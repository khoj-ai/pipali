import path from 'path';
import fs from 'fs/promises';
import { minimatch } from 'minimatch';
import { clampInt, resolvePath, walkFilePaths } from './actor.utils';

export interface ListFilesArgs {
    path?: string;
    pattern?: string;
    max_results?: number;
}

/** Internal config with sensible defaults */
interface ListConfig {
    maxResults: number;
    timeoutMs: number;
    includeHidden: boolean;
    includeAppFolders: boolean;
    followSymlinks: boolean;
}

export interface FileListResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * List files under a given path or glob pattern
 */
export async function listFiles(args: ListFilesArgs): Promise<FileListResult> {
    const { path: searchPath = '', pattern, max_results } = args;

    // Internal defaults optimized for speed on large directories
    const config: ListConfig = {
        maxResults: clampInt(max_results ?? 500, 1, 5000),
        timeoutMs: 10_000,           // 30s hard cap
        includeHidden: false,        // Skip dotfiles/dirs for speed
        includeAppFolders: false,    // Skip ~/Library etc on macOS
        followSymlinks: false,       // Avoid cycles and huge expansions
    };

    try {
        const normalizedPath = resolvePath(searchPath);

        // Use streaming walker with timeout + maxResults
        const result = await walkAndCollect({
            rootDir: normalizedPath,
            pattern,
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

        // Format file list
        let fileList = result.files
            .sort()
            .map(f => `- ${f}`)
            .join('\n');

        if (result.truncated) {
            fileList += `\n\n... (showing first ${config.maxResults} files). Use a more specific path or pattern to narrow down results.`;
        } else if (result.timedOut) {
            fileList += `\n\n... (listing timed out after ${config.timeoutMs}ms). Use a more specific path or pattern.`;
        }

        return {
            query: generateQuery(result.files.length, searchPath, pattern, config.maxResults, result.truncated || result.timedOut),
            file: searchPath,
            uri: searchPath,
            compiled: fileList,
        };
    } catch (error) {
        const errorMsg = `Error listing files: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg, error);

        return {
            query: generateQuery(0, searchPath, pattern, config.maxResults),
            file: searchPath || '.',
            uri: searchPath || '.',
            compiled: errorMsg,
        };
    }
}

function generateQuery(
    docCount: number,
    searchPath?: string,
    pattern?: string,
    maxResults?: number,
    isPartial: boolean = false
): string {
    let query = `**Found ${docCount} files**`;
    if (searchPath && searchPath !== '.') {
        query += ` in ${searchPath}`;
    }
    if (pattern) {
        query += ` filtered by ${pattern}`;
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

interface WalkResult {
    files: string[];
    truncated: boolean;
    timedOut: boolean;
}

async function walkAndCollect(params: {
    rootDir: string;
    pattern?: string;
    maxResults: number;
    timeoutMs: number;
    includeHidden: boolean;
    includeAppFolders: boolean;
    followSymlinks: boolean;
}): Promise<WalkResult> {
    const files: string[] = [];
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

        const name = path.basename(filePath);
        const matches = !params.pattern || minimatch(name, params.pattern);
        if (matches) files.push(filePath);
    }

    return { files, truncated, timedOut };
}
