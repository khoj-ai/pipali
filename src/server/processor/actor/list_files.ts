import path from 'path';
import fs from 'fs/promises';
import { minimatch } from 'minimatch';
import { clampInt, resolvePath, walkFilePaths } from './actor.utils';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'list_files' });

/**
 * Arguments for the list_files tool.
 */
export interface ListFilesArgs {
    /** Directory path to list (absolute or relative to home directory) */
    path?: string;
    /** Glob pattern to filter files (e.g., *.ts or **\/*.json) */
    pattern?: string;
    /** Glob patterns to exclude from results */
    ignore?: string[];
    /** Maximum number of results to return (default: 500, max: 5000) */
    max_results?: number;
}

/** Internal config with sensible defaults */
interface ListConfig {
    maxResults: number;
    timeoutMs: number;
    includeHidden: boolean;
    includeAppFolders: boolean;
    followSymlinks: boolean;
    ignorePatterns: string[];
}

export interface FileListResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Check if a path should be ignored based on patterns
 */
function shouldIgnore(filePath: string, rootDir: string, ignorePatterns: string[]): boolean {
    if (ignorePatterns.length === 0) return false;

    const relativePath = path.relative(rootDir, filePath);
    const fileName = path.basename(filePath);

    for (const pattern of ignorePatterns) {
        // Match against full relative path and filename
        if (minimatch(relativePath, pattern, { dot: true }) ||
            minimatch(fileName, pattern, { dot: true }) ||
            minimatch(relativePath, `**/${pattern}`, { dot: true })) {
            return true;
        }
    }
    return false;
}

/**
 * List files under a given path.
 *
 * Features:
 * - Glob pattern filtering
 * - Custom ignore patterns
 * - Sorted output by modification time (newest first)
 */
export async function listFiles(args: ListFilesArgs): Promise<FileListResult> {
    const {
        path: searchPath = '',
        pattern,
        ignore = [],
        max_results
    } = args;

    // Internal defaults optimized for speed on large directories
    const config: ListConfig = {
        maxResults: clampInt(max_results ?? 500, 1, 5000),
        timeoutMs: 10_000,           // 10s hard cap
        includeHidden: false,        // Skip dotfiles/dirs for speed
        includeAppFolders: false,    // Skip ~/Library etc on macOS
        followSymlinks: false,       // Avoid cycles and huge expansions
        ignorePatterns: ignore,
    };

    try {
        const normalizedPath = resolvePath(searchPath);

        // Use streaming walker with timeout + maxResults
        const result = await walkAndCollect({
            rootDir: normalizedPath,
            pattern,
            ignorePatterns: config.ignorePatterns,
            maxResults: config.maxResults,
            timeoutMs: config.timeoutMs,
            includeHidden: config.includeHidden,
            includeAppFolders: config.includeAppFolders,
            followSymlinks: config.followSymlinks,
        });

        if (result.files.length === 0) {
            const state = await getPathState(normalizedPath);
            if (state.kind === 'missing') {
                return {
                    query: generateQuery(0, searchPath, pattern, config.maxResults),
                    file: searchPath,
                    uri: searchPath,
                    compiled: 'Path does not exist.',
                };
            }
            return {
                query: generateQuery(0, searchPath, pattern, config.maxResults),
                file: searchPath,
                uri: searchPath,
                compiled: 'No files found.',
            };
        }

        // Sort files by modification time (newest first)
        const sortedFiles = result.files.sort((a, b) => b.mtime - a.mtime);

        let fileList = sortedFiles.map(f => `- ${f.path}`).join('\n');

        if (result.truncated) {
            fileList += `\n\n... (showing first ${config.maxResults} files). Use a more specific path or pattern to narrow down results.`;
        } else if (result.timedOut) {
            fileList += `\n\n... (listing timed out after ${config.timeoutMs}ms). Use a more specific path or pattern.`;
        }

        return {
            query: generateQuery(
                result.files.length,
                searchPath,
                pattern,
                config.maxResults,
                result.truncated || result.timedOut
            ),
            file: searchPath,
            uri: searchPath,
            compiled: fileList,
        };
    } catch (error) {
        const errorMsg = `Error listing files: ${error instanceof Error ? error.message : String(error)}`;
        log.error({ err: error }, errorMsg);

        return {
            query: generateQuery(0, searchPath, pattern, config.maxResults),
            file: searchPath || '.',
            uri: searchPath || '.',
            compiled: errorMsg,
        };
    }
}

function generateQuery(
    fileCount: number,
    searchPath?: string,
    pattern?: string,
    maxResults?: number,
    isPartial: boolean = false
): string {
    let query = `**Found ${fileCount} files**`;
    if (searchPath && searchPath !== '.') {
        query += ` in ${searchPath}`;
    }
    if (pattern) {
        query += ` matching "${pattern}"`;
    }
    if (isPartial) {
        query += ` (showing first ${maxResults || 'few'} results)`;
    }
    return query;
}

type PathState =
    | { kind: 'missing' }
    | { kind: 'exists' };

async function getPathState(p: string): Promise<PathState> {
    try {
        await fs.stat(p);
        return { kind: 'exists' };
    } catch {
        return { kind: 'missing' };
    }
}

interface FileEntry {
    path: string;
    mtime: number;
}

interface WalkResult {
    files: FileEntry[];
    truncated: boolean;
    timedOut: boolean;
}

async function walkAndCollect(params: {
    rootDir: string;
    pattern?: string;
    ignorePatterns: string[];
    maxResults: number;
    timeoutMs: number;
    includeHidden: boolean;
    includeAppFolders: boolean;
    followSymlinks: boolean;
}): Promise<WalkResult> {
    const files: FileEntry[] = [];
    let truncated = false;
    let timedOut = false;

    const start = Date.now();

    for await (const filePath of walkFilePaths(params.rootDir, {
        includeHidden: params.includeHidden,
        includeAppFolders: params.includeAppFolders,
        followSymlinks: params.followSymlinks,
    })) {
        if (Date.now() - start > params.timeoutMs) {
            timedOut = true;
            break;
        }

        if (files.length >= params.maxResults) {
            truncated = true;
            break;
        }

        // Check ignore patterns
        if (shouldIgnore(filePath, params.rootDir, params.ignorePatterns)) {
            continue;
        }

        const name = path.basename(filePath);
        const matches = !params.pattern || minimatch(name, params.pattern, { dot: true });

        if (matches) {
            // Get modification time for sorting
            let mtime = 0;
            try {
                const stat = await fs.stat(filePath);
                mtime = stat.mtimeMs;
            } catch {
                // Use 0 if stat fails
            }
            files.push({ path: filePath, mtime });
        }
    }

    return { files, truncated, timedOut };
}
