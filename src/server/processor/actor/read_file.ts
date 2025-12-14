import path from 'path';
import os from 'os';
import { resolveCaseInsensitivePath } from './actor.utils';

export interface ReadFileArgs {
    path: string;
    start_line?: number;
    end_line?: number;
}

export interface FileContentResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * View the contents of a file with optional line range specification
 */
export async function readFile(args: ReadFileArgs): Promise<FileContentResult> {
    const { path: filePath, start_line, end_line } = args;

    let query = `View file: ${filePath}`;
    if (start_line && end_line) {
        query += ` (lines ${start_line}-${end_line})`;
    }

    try {
        // Resolve to absolute path (relative paths resolve relative to home folder)
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(os.homedir(), filePath);

        // Read the file using Bun.file
        let resolvedPath = absolutePath;
        let file = Bun.file(resolvedPath);
        let exists = await file.exists();

        // If the exact-cased path doesn't exist, try resolving case-insensitively.
        if (!exists) {
            const caseResolved = await resolveCaseInsensitivePath(path.normalize(absolutePath));
            if (caseResolved) {
                resolvedPath = caseResolved;
                file = Bun.file(resolvedPath);
                exists = await file.exists();
            }
        }

        if (!exists) {
            return {
                query,
                file: filePath,
                uri: filePath,
                compiled: `File '${filePath}' not found`,
            };
        }

        // Read file content
        const rawText = await file.text();
        const lines = rawText.split('\n');

        // Apply line range filtering if specified
        const startIdx = (start_line || 1) - 1; // Convert to 0-based index
        const endIdx = end_line || lines.length;

        // Validate line range
        if (startIdx < 0 || startIdx >= lines.length) {
            return {
                query,
                file: filePath,
                uri: filePath,
                compiled: `Invalid start_line: ${start_line}. File has ${lines.length} lines.`,
            };
        }

        // Limit to first 50 lines if more than 50 lines are requested
        let actualEndIdx = Math.min(endIdx, lines.length);
        let truncationMessage = '';

        if (actualEndIdx - startIdx > 50) {
            truncationMessage = '\n\n[Truncated after 50 lines! Use narrower line range to view complete section.]';
            actualEndIdx = startIdx + 50;
        }

        const selectedLines = lines.slice(startIdx, actualEndIdx);
        const filteredText = selectedLines.join('\n') + truncationMessage;

        return {
            query,
            file: filePath,
            uri: filePath,
            compiled: filteredText,
        };
    } catch (error) {
        const errorMsg = `Error reading file ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg, error);

        return {
            query,
            file: filePath,
            uri: filePath,
            compiled: errorMsg,
        };
    }
}
