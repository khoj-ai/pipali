import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { resolveCaseInsensitivePath } from './actor.utils';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import { isPathWithinAllowedWrite } from '../../sandbox';

/**
 * Arguments for the edit_file tool.
 */
export interface EditFileArgs {
    /** The absolute path to the file to modify */
    file_path: string;
    /** The text to replace (must be unique in the file unless replace_all is true) */
    old_string: string;
    /** The text to replace it with (must be different from old_string) */
    new_string: string;
    /** Replace all occurrences of old_string (default: false) */
    replace_all?: boolean;
}

export interface EditFileResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Options for edit file operation
 */
export interface EditFileOptions {
    /** Confirmation context for requesting user approval */
    confirmationContext?: ConfirmationContext;
}

/**
 * Performs exact string replacements in files.
 *
 * Features:
 * - Exact string matching (not regex)
 * - Validates uniqueness of old_string (unless replace_all is true)
 * - Preserves file encoding
 * - Case-insensitive path resolution fallback
 * - Optional user confirmation before modifying files
 */
export async function editFile(
    args: EditFileArgs,
    options?: EditFileOptions
): Promise<EditFileResult> {
    const { file_path, old_string, new_string, replace_all = false } = args;

    const query = `Edit file: ${file_path}`;

    // Validate inputs
    if (!file_path) {
        return {
            query,
            file: file_path || '',
            uri: file_path || '',
            compiled: 'Error: file_path is required',
        };
    }

    if (old_string === undefined || old_string === null) {
        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: 'Error: old_string is required',
        };
    }

    if (new_string === undefined || new_string === null) {
        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: 'Error: new_string is required',
        };
    }

    if (old_string === new_string) {
        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: 'Error: new_string must be different from old_string',
        };
    }

    try {
        // Resolve to absolute path (relative paths resolve relative to home folder)
        const absolutePath = path.isAbsolute(file_path)
            ? file_path
            : path.resolve(os.homedir(), file_path);

        // Check if file exists
        let resolvedPath = absolutePath;
        let file = Bun.file(resolvedPath);
        let exists = await file.exists();

        // If the exact-cased path doesn't exist, try resolving case-insensitively
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
                file: file_path,
                uri: file_path,
                compiled: `Error: File '${file_path}' not found`,
            };
        }

        // Read the file content
        const content = await file.text();

        // Check if old_string exists in the file
        if (!content.includes(old_string)) {
            return {
                query,
                file: file_path,
                uri: file_path,
                compiled: `Error: old_string not found in file. Make sure you're using the exact text from the file.`,
            };
        }

        // Count occurrences of old_string
        const occurrences = content.split(old_string).length - 1;

        // If not replace_all and there are multiple occurrences, error out
        if (!replace_all && occurrences > 1) {
            return {
                query,
                file: file_path,
                uri: file_path,
                compiled: `Error: old_string is not unique in the file (found ${occurrences} occurrences). Either provide a larger string with more surrounding context to make it unique, or set replace_all to true to replace all occurrences.`,
            };
        }

        // Perform the replacement
        let newContent: string;
        if (replace_all) {
            newContent = content.split(old_string).join(new_string);
        } else {
            // Replace only the first occurrence
            const index = content.indexOf(old_string);
            newContent = content.slice(0, index) + new_string + content.slice(index + old_string.length);
        }

        // Check if path is within allowed write directories (skip confirmation if so)
        const skipConfirmation = isPathWithinAllowedWrite(resolvedPath);

        // Request user confirmation if:
        // 1. Path is NOT within allowed write directories, AND
        // 2. Confirmation context is provided
        if (!skipConfirmation && options?.confirmationContext) {
            const confirmResult = await requestOperationConfirmation(
                'edit_file',
                file_path,
                options.confirmationContext,
                {
                    toolName: 'edit_file',
                    toolArgs: { file_path, old_string, new_string, replace_all },
                    additionalMessage: `This will replace ${occurrences} occurrence${occurrences > 1 ? 's' : ''} of the specified text.`,
                    diff: {
                        filePath: file_path,
                        oldText: old_string,
                        newText: new_string,
                    },
                }
            );

            if (!confirmResult.approved) {
                return {
                    query,
                    file: file_path,
                    uri: file_path,
                    compiled: `Operation cancelled: ${confirmResult.denialReason || 'User denied the edit operation'}`,
                };
            }
        }

        // Write the file back
        await fs.writeFile(resolvedPath, newContent, 'utf-8');

        const replacementCount = replace_all ? occurrences : 1;
        const message = `Successfully replaced ${replacementCount} occurrence${replacementCount > 1 ? 's' : ''} in ${file_path}`;

        console.log(`[Edit] ${message}`);

        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: message,
        };
    } catch (error) {
        const errorMsg = `Error editing file ${file_path}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg, error);

        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: errorMsg,
        };
    }
}
