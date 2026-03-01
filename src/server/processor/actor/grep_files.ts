import path from 'path';
import { homedir } from 'os';
import fs from 'fs/promises';
import { minimatch } from 'minimatch';
import { clampInt, getExcludedDirNamesForRootDir, resolveCaseInsensitivePath, resolvePath, walkFilePaths } from './actor.utils';
import { isSensitivePath, getSensitivePathReason } from '../../security';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'grep_files' });

/**
 * Binary and image file extensions to exclude from grep searches.
 * These files are not text-searchable and would produce garbage output.
 */
const BINARY_EXTENSIONS = new Set([
    // Images
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff', '.tif',
    '.psd', '.ai', '.eps', '.raw', '.cr2', '.nef', '.heic', '.heif', '.avif',
    // Audio
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.aiff', '.opus',
    // Video
    '.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpeg', '.mpg', '.3gp',
    // Archives
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.dmg', '.iso',
    // Executables and libraries
    '.exe', '.dll', '.so', '.dylib', '.bin', '.app', '.msi', '.deb', '.rpm',
    // Compiled/bytecode
    '.pyc', '.pyo', '.class', '.o', '.obj', '.wasm',
    // Documents (binary formats)
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
    // Fonts
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    // Database files
    '.db', '.sqlite', '.sqlite3', '.mdb',
    // Other binary formats
    '.swf', '.fla', '.blend', '.fbx', '.glb', '.gltf',
    // Lock files and caches (often large/binary-like)
    '.lock', '.pack', '.idx',
]);

/**
 * Arguments for the grep_files tool.
 */
export interface GrepFilesArgs {
    /** Regular expression pattern to search for */
    pattern: string;
    /** Directory or file path to search in (defaults to home directory) */
    path?: string;
    /** Glob pattern to filter which files to search (e.g., *.ts or *.{js,jsx}) */
    include?: string;
    /** Number of context lines to show before each match */
    lines_before?: number;
    /** Number of context lines to show after each match */
    lines_after?: number;
    /** Maximum number of results to return (default: 500, max: 5000) */
    max_results?: number;
}

/** Internal search configuration with sensible defaults */
interface SearchConfig {
    maxResults: number;
    timeoutMs: number;
    includeHidden: boolean;
    includeAppFolders: boolean;
    followSymlinks: boolean;
    respectIgnore: boolean;
    preferRipgrep: boolean;
}

export interface GrepResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Options for grep operations
 */
export interface GrepFilesOptions {
    /** Confirmation context for requesting user approval on sensitive paths */
    confirmationContext?: ConfirmationContext;
}

/**
 * Check if a file should be excluded from grep based on its extension.
 */
function isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/**
 * Build ripgrep glob patterns to exclude binary file extensions.
 */
function buildBinaryExcludeGlobs(): string[] {
    return Array.from(BINARY_EXTENSIONS).map(ext => `!*${ext}`);
}

/**
 * Check if a regex pattern is potentially dangerous (ReDoS).
 * Uses simple heuristics to detect nested quantifiers and other patterns
 * that can cause catastrophic backtracking.
 */
function isUnsafeRegex(pattern: string): boolean {
    // Detect nested quantifiers like (a+)+, (a*)+, (a+)*, etc.
    // These can cause exponential backtracking
    const nestedQuantifiers = /(\([^)]*[+*][^)]*\))[+*]|\([^)]*([+*])[^)]*\)\2/;
    if (nestedQuantifiers.test(pattern)) {
        return true;
    }

    // Detect overlapping alternations with quantifiers like (a|a)+
    const overlappingAlternation = /\(([^|)]+)\|(\1[^)]*|\1)\)[+*]/;
    if (overlappingAlternation.test(pattern)) {
        return true;
    }

    // Very long patterns with many quantifiers
    const quantifierCount = (pattern.match(/[+*?]|\{\d+,?\d*\}/g) || []).length;
    if (quantifierCount > 10 && pattern.length > 100) {
        return true;
    }

    return false;
}

/**
 * Search for a regex pattern in files.
 *
 * Features:
 * - Regex pattern search
 * - Path filtering (directory or file)
 * - Glob-based file type filtering via `include` parameter
 * - Context lines (before/after matches)
 * - Uses ripgrep when available for speed
 *
 * Security:
 * - Sensitive paths require user confirmation
 * - Dangerous regex patterns (ReDoS) are rejected
 */
export async function grepFiles(
    args: GrepFilesArgs,
    options?: GrepFilesOptions
): Promise<GrepResult> {
    const {
        pattern,
        path: searchPathArg = homedir(),
        include,
        lines_before = 0,
        lines_after = 0,
        max_results,
    } = args;

    // Internal defaults optimized for speed on large directories
    const config: SearchConfig = {
        maxResults: clampInt(max_results ?? 500, 1, 5000),
        timeoutMs: 10_000,           // 10s hard cap
        includeHidden: false,        // Skip dotfiles/dirs for speed
        includeAppFolders: false,    // Skip ~/Library etc on macOS
        followSymlinks: false,       // Avoid cycles and huge expansions
        respectIgnore: true,         // Honor .gitignore etc
        preferRipgrep: true,         // Use rg when available
    };

    try {
        // Check for potentially dangerous regex patterns (ReDoS prevention)
        if (isUnsafeRegex(pattern)) {
            return {
                query: generateQuery(0, 0, searchPathArg, pattern, include, lines_before, lines_after, config.maxResults),
                file: searchPathArg,
                uri: searchPathArg,
                compiled: 'Error: Regex pattern is too complex and may cause performance issues. Patterns with nested quantifiers like (a+)+ or (a|b)* can cause exponential backtracking. Please simplify the pattern.',
            };
        }

        // Compile the regex pattern
        let regex: RegExp;
        try {
            regex = new RegExp(pattern);
        } catch (e) {
            return {
                query: generateQuery(0, 0, searchPathArg, pattern, include, lines_before, lines_after, config.maxResults),
                file: searchPathArg,
                uri: searchPathArg,
                compiled: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
            };
        }

        // Determine search path.
        let searchPath = resolvePath(searchPathArg);

        // Check if path is sensitive and request confirmation if needed
        if (isSensitivePath(searchPath) && options?.confirmationContext) {
            const reason = getSensitivePathReason(searchPath) || 'sensitive location';
            const confirmResult = await requestOperationConfirmation(
                'grep_sensitive_path',
                searchPath,
                options.confirmationContext,
                {
                    toolName: 'grep_files',
                    toolArgs: { pattern, path: searchPathArg, include, lines_before, lines_after, max_results },
                    additionalMessage: `This path contains ${reason}.\n\nAre you sure you want to search in this location?`,
                }
            );

            if (!confirmResult.approved) {
                return {
                    query: generateQuery(0, 0, searchPathArg, pattern, include, lines_before, lines_after, config.maxResults),
                    file: searchPathArg,
                    uri: searchPathArg,
                    compiled: `Search cancelled: ${confirmResult.denialReason || 'User denied access to sensitive path'}`,
                };
            }
        }

        // Normalize to on-disk casing when input casing differs (only on case-insensitive FS like macOS/Windows).
        const caseResolvedSearchPath = await resolveCaseInsensitivePath(path.resolve(searchPath));
        if (caseResolvedSearchPath) {
            searchPath = caseResolvedSearchPath;
        }

        // Prefer ripgrep when available for speed
        if (config.preferRipgrep) {
            const rgPath = Bun.which('rg');
            if (rgPath) {
                const rgResult = await grepWithRipgrep({
                    rgPath,
                    pattern,
                    searchPath,
                    include,
                    linesBefore: lines_before,
                    linesAfter: lines_after,
                    maxOutputLines: config.maxResults,
                    timeoutMs: config.timeoutMs,
                    includeHidden: config.includeHidden,
                    includeAppFolders: config.includeAppFolders,
                    followSymlinks: config.followSymlinks,
                    respectIgnore: config.respectIgnore,
                });

                if (rgResult.outputLines.length > 0) {
                    let compiled = rgResult.outputLines.join('\n');
                    if (rgResult.truncated) {
                        compiled += `\n\n... ${rgResult.outputLines.length} results found (showing first ${config.maxResults}). Use stricter regex or path to narrow down results.`;
                    } else if (rgResult.timedOut) {
                        compiled += `\n\n... Search timed out after ${config.timeoutMs}ms. Use stricter regex or path to narrow down results.`;
                    }

                    return {
                        query: generateQuery(
                            rgResult.outputLines.length,
                            rgResult.matchedFiles.size,
                            searchPathArg,
                            pattern,
                            include,
                            lines_before,
                            lines_after,
                            config.maxResults,
                            rgResult.truncated || rgResult.timedOut
                        ),
                        file: searchPathArg,
                        uri: searchPathArg,
                        compiled,
                    };
                }

                // If no output, distinguish "no files" vs "no matches".
                const state = await getSearchPathState(searchPath);
                if (state.kind === 'missing' || state.kind === 'empty-directory') {
                    return {
                        query: generateQuery(0, 0, searchPathArg, pattern, include, lines_before, lines_after, config.maxResults),
                        file: searchPathArg,
                        uri: searchPathArg,
                        compiled: 'No files found in specified path.',
                    };
                }

                return {
                    query: generateQuery(0, 0, searchPathArg, pattern, include, lines_before, lines_after, config.maxResults),
                    file: searchPathArg,
                    uri: searchPathArg,
                    compiled: 'No matches found.',
                };
            }
        }

        // Fallback: stream-walk files and scan line-by-line
        const fallback = await grepWithFallbackWalker({
            regex,
            pattern,
            searchPath,
            pathPrefix: searchPathArg,
            include,
            linesBefore: lines_before,
            linesAfter: lines_after,
            maxOutputLines: config.maxResults,
            timeoutMs: config.timeoutMs,
            includeHidden: config.includeHidden,
            includeAppFolders: config.includeAppFolders,
            followSymlinks: config.followSymlinks,
        });

        if (fallback.noFiles) {
            return {
                query: generateQuery(0, 0, searchPathArg, pattern, include, lines_before, lines_after, config.maxResults),
                file: searchPathArg,
                uri: searchPathArg,
                compiled: 'No files found in specified path.',
            };
        }

        if (fallback.outputLines.length === 0) {
            return {
                query: generateQuery(0, 0, searchPathArg, pattern, include, lines_before, lines_after, config.maxResults),
                file: searchPathArg,
                uri: searchPathArg,
                compiled: 'No matches found.',
            };
        }

        let compiled = fallback.outputLines.join('\n');
        if (fallback.truncated) {
            compiled += `\n\n... ${fallback.outputLines.length} results found (showing first ${config.maxResults}). Use stricter regex or path to narrow down results.`;
        } else if (fallback.timedOut) {
            compiled += `\n\n... Search timed out after ${config.timeoutMs}ms. Use stricter regex or path to narrow down results.`;
        }

        return {
            query: generateQuery(
                fallback.outputLines.length,
                fallback.matchedFiles.size,
                searchPathArg,
                pattern,
                include,
                lines_before,
                lines_after,
                config.maxResults,
                fallback.truncated || fallback.timedOut
            ),
            file: searchPathArg,
            uri: searchPathArg,
            compiled,
        };
    } catch (error) {
        const errorMsg = `Error using grep files tool: ${error instanceof Error ? error.message : String(error)}`;
        log.error({ err: error }, errorMsg);

        return {
            query: generateQuery(0, 0, searchPathArg, pattern, include, lines_before, lines_after, config.maxResults),
            file: searchPathArg,
            uri: searchPathArg,
            compiled: errorMsg,
        };
    }
}

function generateQuery(
    lineCount: number,
    docCount: number,
    pathPrefix: string | undefined,
    pattern: string,
    include: string | undefined,
    linesBefore: number,
    linesAfter: number,
    maxResults: number = 1000,
    isPartial: boolean = false
): string {
    let query = `**Found ${lineCount} matches for '${pattern}' in ${docCount} files**`;
    if (pathPrefix) {
        query += ` in ${pathPrefix}`;
    }
    if (include) {
        query += ` (files matching: ${include})`;
    }
    if (linesBefore || linesAfter || isPartial || lineCount > maxResults) {
        query += ' Showing';
    }
    if (linesBefore || linesAfter) {
        const contextInfo: string[] = [];
        if (linesBefore) {
            contextInfo.push(`${linesBefore} lines before`);
        }
        if (linesAfter) {
            contextInfo.push(`${linesAfter} lines after`);
        }
        query += ` ${contextInfo.join(' and ')}`;
    }
    if (isPartial || lineCount > maxResults) {
        if (linesBefore || linesAfter) {
            query += ' for';
        }
        query += ` first ${maxResults} results`;
    }
    return query;
}

type SearchPathState =
    | { kind: 'missing' }
    | { kind: 'empty-directory' }
    | { kind: 'non-empty-or-non-directory' }
    | { kind: 'not-accessible' };

async function getSearchPathState(searchPath: string): Promise<SearchPathState> {
    try {
        const stat = await fs.stat(searchPath);
        if (!stat.isDirectory()) {
            return { kind: 'non-empty-or-non-directory' };
        }

        try {
            const entries = await fs.readdir(searchPath);
            return entries.length === 0 ? { kind: 'empty-directory' } : { kind: 'non-empty-or-non-directory' };
        } catch {
            return { kind: 'not-accessible' };
        }
    } catch {
        return { kind: 'missing' };
    }
}

function buildRipgrepGlobExcludes(excludedDirNames: Set<string>): string[] {
    const globs: string[] = [];
    for (const dir of excludedDirNames) {
        globs.push(`!**/${dir}/**`);
    }
    return globs;
}

async function grepWithRipgrep(params: {
    rgPath: string;
    pattern: string;
    searchPath: string;
    include?: string;
    linesBefore: number;
    linesAfter: number;
    maxOutputLines: number;
    timeoutMs: number;
    includeHidden: boolean;
    includeAppFolders: boolean;
    followSymlinks: boolean;
    respectIgnore: boolean;
}): Promise<{
    outputLines: string[];
    matchedFiles: Set<string>;
    truncated: boolean;
    timedOut: boolean;
}> {
    const outputLines: string[] = [];
    const matchedFiles = new Set<string>();
    let truncated = false;
    let timedOut = false;

    const excluded = getExcludedDirNamesForRootDir(params.searchPath, { includeAppFolders: params.includeAppFolders });

    const args: string[] = [
        '--color=never',
        '--no-heading',
        '--with-filename',
        '--line-number',
        '--no-messages',
    ];

    if (params.linesBefore > 0) args.push(`--before-context=${params.linesBefore}`);
    if (params.linesAfter > 0) args.push(`--after-context=${params.linesAfter}`);

    if (params.includeHidden) args.push('--hidden');
    if (params.followSymlinks) args.push('--follow');
    if (!params.respectIgnore) args.push('--no-ignore');

    // Add include glob filter if specified (aligns with Gemini CLI's `include` parameter)
    if (params.include) {
        args.push(`--glob=${params.include}`);
    }

    // Prefer PCRE2 if supported (closer to JS regex). If unsupported, we'll retry without.
    const baseArgs = [...args, '--pcre2', params.pattern, path.resolve(params.searchPath)];
    const retryArgs = [...args, params.pattern, path.resolve(params.searchPath)];

    // Apply globs (directory excludes and binary file excludes)
    const globExcludes = [
        ...buildRipgrepGlobExcludes(excluded),
        ...buildBinaryExcludeGlobs(),
    ];
    for (const glob of globExcludes) {
        baseArgs.splice(baseArgs.length - 2, 0, `--glob=${glob}`);
        retryArgs.splice(retryArgs.length - 2, 0, `--glob=${glob}`);
    }

    const runOnce = async (argv: string[]): Promise<{ exitCode: number; stderr: string } | null> => {
        const proc = Bun.spawn([params.rgPath, ...argv], {
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const stderrPromise = readStreamToString(proc.stderr, 32_768);

        const timeout = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill();
            } catch {
                // ignore
            }
        }, params.timeoutMs);

        try {
            await streamRipgrepStdout(proc.stdout, (line) => {
                if (outputLines.length >= params.maxOutputLines) {
                    truncated = true;
                    try {
                        proc.kill();
                    } catch {
                        // ignore
                    }
                    return;
                }

                if (line === '--' || line.trim() === '--') {
                    outputLines.push('--');
                    return;
                }

                // Match line: path:line:content
                const match = line.match(/^(.*):(\d+):(.*)$/);
                if (match) {
                    const filePath = match[1] ?? '';
                    const lineNo = match[2] ?? '';
                    const text = match[3] ?? '';
                    outputLines.push(`${filePath}:${lineNo}:${text}`);
                    matchedFiles.add(filePath);
                    return;
                }

                // Context line: path-line-content (rg format)
                const ctx = line.match(/^(.*)-(\d+)-(.*)$/);
                if (ctx) {
                    const filePath = ctx[1] ?? '';
                    const lineNo = ctx[2] ?? '';
                    const text = ctx[3] ?? '';
                    outputLines.push(`${filePath}:${lineNo}-${text}`);
                    return;
                }

                // Fallback: keep as-is
                outputLines.push(line);
            });

            const exitCode = await proc.exited;
            const stderr = await stderrPromise;
            return { exitCode, stderr };
        } finally {
            clearTimeout(timeout);
        }
    };

    // Try with --pcre2 first; if unsupported, retry without.
    const first = await runOnce(baseArgs);
    if (first && first.exitCode === 2 && /--pcre2|PCRE2|unknown option/i.test(first.stderr)) {
        // Reset partial results from failed attempt
        outputLines.length = 0;
        matchedFiles.clear();
        truncated = false;
        timedOut = false;
        await runOnce(retryArgs);
    }

    // If context requested but rg didn't emit separators, mimic previous behavior (best-effort).
    if ((params.linesBefore > 0 || params.linesAfter > 0) && outputLines.length > 0 && !outputLines.includes('--')) {
        outputLines.push('--');
    }

    return { outputLines, matchedFiles, truncated, timedOut };
}

async function streamRipgrepStdout(
    stdout: ReadableStream<Uint8Array> | null,
    onLine: (line: string) => void
): Promise<void> {
    if (!stdout) return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line.length === 0) continue;
            onLine(line);
        }
    }
    if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ''));
    }
}

async function readStreamToString(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
    if (!stream) return '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            out += decoder.decode(value, { stream: true });
            out += '\n... (stderr truncated)';
            break;
        }
        out += decoder.decode(value, { stream: true });
    }
    return out;
}

async function grepWithFallbackWalker(params: {
    regex: RegExp;
    pattern: string;
    searchPath: string;
    pathPrefix: string;
    include?: string;
    linesBefore: number;
    linesAfter: number;
    maxOutputLines: number;
    timeoutMs: number;
    includeHidden: boolean;
    includeAppFolders: boolean;
    followSymlinks: boolean;
}): Promise<{
    outputLines: string[];
    matchedFiles: Set<string>;
    truncated: boolean;
    timedOut: boolean;
    noFiles: boolean;
}> {
    const outputLines: string[] = [];
    const matchedFiles = new Set<string>();
    let truncated = false;
    let timedOut = false;
    let sawAnyFile = false;

    const start = Date.now();
    const maxFileSizeBytes = 10 * 1024 * 1024; // 10MB
    let skippedErrors = 0;
    let skippedBinary = 0;
    let skippedLarge = 0;

    for await (const filePath of walkFilePaths(params.searchPath, {
        includeHidden: params.includeHidden,
        includeAppFolders: params.includeAppFolders,
        followSymlinks: params.followSymlinks,
    })) {
        // Skip binary files by extension (fast check before reading)
        if (isBinaryFile(filePath)) {
            skippedBinary++;
            continue;
        }

        // Apply include filter if specified
        if (params.include) {
            const fileName = path.basename(filePath);
            if (!minimatch(fileName, params.include, { dot: true })) {
                continue;
            }
        }

        sawAnyFile = true;
        if (Date.now() - start > params.timeoutMs) {
            timedOut = true;
            break;
        }
        if (outputLines.length >= params.maxOutputLines) {
            truncated = true;
            break;
        }

        try {
            const stat = await fs.stat(filePath);
            if (stat.size > maxFileSizeBytes) {
                skippedLarge++;
                continue;
            }

            const file = Bun.file(filePath);

            // quick binary sniff
            try {
                const head = await file.slice(0, 1024).arrayBuffer();
                const bytes = new Uint8Array(head);
                if (bytes.includes(0)) {
                    skippedBinary++;
                    continue;
                }
            } catch {
                // ignore sniff errors
            }

            const content = await file.text();
            const lines = content.split('\n');
            let fileHasMatch = false;

            for (let i = 0; i < lines.length && outputLines.length < params.maxOutputLines; i++) {
                if (Date.now() - start > params.timeoutMs) {
                    timedOut = true;
                    break;
                }

                const line = lines[i] ?? '';
                if (params.regex.test(line)) {
                    if (!fileHasMatch) {
                        matchedFiles.add(filePath);
                        fileHasMatch = true;
                    }

                    const startIdx = Math.max(0, i - params.linesBefore);
                    for (let j = startIdx; j < i && outputLines.length < params.maxOutputLines; j++) {
                        outputLines.push(`${filePath}:${j + 1}-${lines[j] ?? ''}`);
                    }

                    outputLines.push(`${filePath}:${i + 1}:${line}`);

                    const endIdx = Math.min(lines.length, i + params.linesAfter + 1);
                    for (let j = i + 1; j < endIdx && outputLines.length < params.maxOutputLines; j++) {
                        outputLines.push(`${filePath}:${j + 1}-${lines[j] ?? ''}`);
                    }

                    if (params.linesBefore > 0 || params.linesAfter > 0) {
                        outputLines.push('--');
                    }
                }
            }
        } catch {
            skippedErrors++;
            continue;
        }
    }

    const noFiles = !sawAnyFile;

    return { outputLines, matchedFiles, truncated, timedOut, noFiles };
}
