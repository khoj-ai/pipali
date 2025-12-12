import { glob } from 'glob';
import path from 'path';
import os from 'os';

export interface ListFilesArgs {
    path?: string;
    pattern?: string;
}

export interface FileListResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Resolve a path relative to user's home directory.
 * - "~" or "~/foo" expands to home directory
 * - Relative paths like "Downloads" resolve from home directory
 * - Absolute paths are used as-is
 */
function resolvePath(inputPath: string): string {
    const home = os.homedir();

    if (inputPath === '~' || inputPath === '') {
        return home;
    }

    if (inputPath.startsWith('~/')) {
        return path.join(home, inputPath.slice(2));
    }

    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }

    // Relative paths resolve from home directory
    return path.join(home, inputPath);
}

/**
 * List files under a given path or glob pattern
 */
export async function listFiles(args: ListFilesArgs): Promise<FileListResult> {
    const { path: searchPath = '', pattern } = args;

    try {
        const normalizedPath = resolvePath(searchPath);

        // Build glob pattern
        const globPattern = pattern
            ? path.join(normalizedPath, pattern)
            : path.join(normalizedPath, '/*');

        // Find matching files
        const files = await glob(globPattern, {
            absolute: true,
        });

        if (files.length === 0) {
            return {
                query: generateQuery(0, searchPath, pattern),
                file: searchPath,
                uri: searchPath,
                compiled: 'No files found.',
            };
        }

        // Format file list
        const fileList = files
            .sort()
            .map(f => `- ${f}`)
            .join('\n');

        return {
            query: generateQuery(files.length, searchPath, pattern),
            file: searchPath,
            uri: searchPath,
            compiled: fileList,
        };
    } catch (error) {
        const errorMsg = `Error listing files: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg, error);

        return {
            query: generateQuery(0, searchPath, pattern),
            file: searchPath || '.',
            uri: searchPath || '.',
            compiled: errorMsg,
        };
    }
}

function generateQuery(docCount: number, searchPath?: string, pattern?: string): string {
    let query = `**Found ${docCount} files**`;
    if (searchPath && searchPath !== '.') {
        query += ` in ${searchPath}`;
    }
    if (pattern) {
        query += ` filtered by ${pattern}`;
    }
    return query;
}
