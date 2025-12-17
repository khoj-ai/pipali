import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';

/**
 * Arguments for the write_file tool.
 */
export interface WriteFileArgs {
    /** The absolute path to the file to write (must be absolute, not relative) */
    file_path: string;
    /** The content to write to the file */
    content: string;
}

export interface WriteFileResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Options for write file operation
 */
export interface WriteFileOptions {
    /** Confirmation context for requesting user approval */
    confirmationContext?: ConfirmationContext;
}

/**
 * Writes content to a file, creating it if it doesn't exist or overwriting if it does.
 *
 * Features:
 * - Creates parent directories if they don't exist
 * - Overwrites existing files
 * - UTF-8 encoding
 * - Optional user confirmation before writing files
 */
export async function writeFile(
    args: WriteFileArgs,
    options?: WriteFileOptions
): Promise<WriteFileResult> {
    const { file_path, content } = args;

    const query = `Write file: ${file_path}`;

    // Validate inputs
    if (!file_path) {
        return {
            query,
            file: file_path || '',
            uri: file_path || '',
            compiled: 'Error: file_path is required',
        };
    }

    if (content === undefined || content === null) {
        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: 'Error: content is required',
        };
    }

    try {
        // Resolve to absolute path (relative paths resolve relative to home folder)
        const absolutePath = path.isAbsolute(file_path)
            ? file_path
            : path.resolve(os.homedir(), file_path);

        // Check if the file already exists
        const file = Bun.file(absolutePath);
        const exists = await file.exists();

        // Create parent directories if they don't exist
        const parentDir = path.dirname(absolutePath);
        await fs.mkdir(parentDir, { recursive: true });

        // Request user confirmation if confirmation context is provided
        if (options?.confirmationContext) {
            const lineCount = content.split('\n').length;
            const byteSize = Buffer.byteLength(content, 'utf-8');
            const action = exists ? 'overwrite' : 'create';

            const confirmResult = await requestOperationConfirmation(
                'write_file',
                file_path,
                options.confirmationContext,
                {
                    toolName: 'write_file',
                    toolArgs: { file_path, content: `[${lineCount} lines, ${byteSize} bytes]` },
                    additionalMessage: `This will ${action} the file with ${lineCount} lines (${byteSize} bytes).`,
                }
            );

            if (!confirmResult.approved) {
                return {
                    query,
                    file: file_path,
                    uri: file_path,
                    compiled: `Operation cancelled: ${confirmResult.denialReason || 'User denied the write operation'}`,
                };
            }
        }

        // Write the file
        await fs.writeFile(absolutePath, content, 'utf-8');

        const action = exists ? 'Updated' : 'Created';
        const lineCount = content.split('\n').length;
        const byteSize = Buffer.byteLength(content, 'utf-8');
        const message = `${action} ${file_path} (${lineCount} lines, ${byteSize} bytes)`;

        console.log(`[Write] ${message}`);

        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: message,
        };
    } catch (error) {
        const errorMsg = `Error writing file ${file_path}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg, error);

        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: errorMsg,
        };
    }
}
