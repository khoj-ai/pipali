import path from 'path';
import { homedir } from 'os';
import fs from 'fs/promises';
import { clampInt, getExcludedDirNamesForRootDir, resolveCaseInsensitivePath, resolvePath, walkFilePaths } from './actor.utils';

/** Arguments exposed to the agent via tool schema */
export interface GrepFilesArgs {
    regex_pattern: string;
    path_prefix?: string;
    lines_before?: number;
    lines_after?: number;
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
 * Search for a regex pattern in files with optional path prefix and context lines
 * Defaults to home directory if path_prefix is not provided and no context lines
 */
export async function grepFiles(args: GrepFilesArgs): Promise<GrepResult> {
    const {
        regex_pattern,
        path_prefix = homedir(),
        lines_before = 0,
        lines_after = 0,
        max_results,
    } = args;

    // Internal defaults optimized for speed on large directories
    const config: SearchConfig = {
        maxResults: clampInt(max_results ?? 500, 1, 5000),
        timeoutMs: 10_000,           // 60s hard cap
        includeHidden: false,        // Skip dotfiles/dirs for speed
        includeAppFolders: false,    // Skip ~/Library etc on macOS
        followSymlinks: false,       // Avoid cycles and huge expansions
        respectIgnore: true,         // Honor .gitignore etc
        preferRipgrep: true,         // Use rg when available
    };

    try {
        // Compile the regex pattern
        let regex: RegExp;
        try {
            regex = new RegExp(regex_pattern);
        } catch (e) {
            return {
                query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after, config.maxResults),
                file: path_prefix,
                uri: path_prefix,
                compiled: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
            };
        }

        // Determine search path.
        let searchPath = resolvePath(path_prefix);

        // Normalize to on-disk casing when input casing differs (common on macOS).
        // This ensures reported file paths are case-correct (e.g. Notes/... not notes/...).
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
                    pattern: regex_pattern,
                    searchPath,
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
                            path_prefix,
                            regex_pattern,
                            lines_before,
                            lines_after,
                            config.maxResults,
                            rgResult.truncated || rgResult.timedOut
                        ),
                        file: path_prefix,
                        uri: path_prefix,
                        compiled,
                    };
                }

                // If no output, distinguish "no files" vs "no matches".
                // Important: file-path searches with no matches should say "No matches", not "No files".
                const state = await getSearchPathState(searchPath);
                if (state.kind === 'missing' || state.kind === 'empty-directory') {
                    return {
                        query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after, config.maxResults),
                        file: path_prefix,
                        uri: path_prefix,
                        compiled: 'No files found in specified path.',
                    };
                }

                return {
                    query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after, config.maxResults),
                    file: path_prefix,
                    uri: path_prefix,
                    compiled: 'No matches found.',
                };
            }
        }

        // Fallback: stream-walk files and scan line-by-line
        const fallback = await grepWithFallbackWalker({
            regex,
            pattern: regex_pattern,
            searchPath,
            pathPrefix: path_prefix,
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
                query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after, config.maxResults),
                file: path_prefix,
                uri: path_prefix,
                compiled: 'No files found in specified path.',
            };
        }

        if (fallback.outputLines.length === 0) {
            return {
                query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after, config.maxResults),
                file: path_prefix,
                uri: path_prefix,
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
                path_prefix,
                regex_pattern,
                lines_before,
                lines_after,
                config.maxResults,
                fallback.truncated || fallback.timedOut
            ),
            file: path_prefix,
            uri: path_prefix,
            compiled,
        };
    } catch (error) {
        const errorMsg = `Error using grep files tool: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg, error);

        return {
            query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after, config.maxResults),
            file: path_prefix,
            uri: path_prefix,
            compiled: errorMsg,
        };
    }
}

function generateQuery(
    lineCount: number,
    docCount: number,
    pathPrefix: string | undefined,
    pattern: string,
    linesBefore: number,
    linesAfter: number,
    maxResults: number = 1000,
    isPartial: boolean = false
): string {
    let query = `**Found ${lineCount} matches for '${pattern}' in ${docCount} documents**`;
    if (pathPrefix) {
        query += ` in ${pathPrefix}`;
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
            // Directory exists but can't be listed; don't claim "No files".
            return { kind: 'not-accessible' };
        }
    } catch {
        return { kind: 'missing' };
    }
}

function buildRipgrepGlobExcludes(excludedDirNames: Set<string>): string[] {
    // ripgrep globs are evaluated against paths; exclude directory trees.
    const globs: string[] = [];
    for (const dir of excludedDirNames) {
        // Note: keep it broad; these are commonly huge and not useful for user-facing search.
        globs.push(`!**/${dir}/**`);
    }
    return globs;
}

async function grepWithRipgrep(params: {
    rgPath: string;
    pattern: string;
    searchPath: string;
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

    // Prefer PCRE2 if supported (closer to JS regex). If unsupported, we'll retry without.
    const baseArgs = [...args, '--pcre2', params.pattern, path.resolve(params.searchPath)];
    const retryArgs = [...args, params.pattern, path.resolve(params.searchPath)];

    // Apply globs (excludes)
    const globExcludes = buildRipgrepGlobExcludes(excluded);
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

    // If we had no readable files at all, treat as no files.
    const noFiles = !sawAnyFile;

    // Keep fallback quiet; but if everything got skipped, surface a small hint.
    if (!noFiles && outputLines.length === 0 && (skippedErrors + skippedBinary + skippedLarge) > 0) {
        // no-op: main caller will return "No matches found."; the summary would be noise for normal usage.
    }

    return { outputLines, matchedFiles, truncated, timedOut, noFiles };
}
