import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { resolveCaseInsensitivePath } from './actor.utils';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import { isPathWithinAllowedWrite } from '../../sandbox';
import { isMemoryFile, memoryWriteError, stampProvenance } from '../../memory';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'edit_file' });

const editQueues = new Map<string, Promise<void>>();

interface ResolvedEditPath {
    resolvedPath: string;
    queuePath: string;
}

function getEditQueueKey(filePath: string): string {
    const normalized = path.normalize(filePath);
    return process.platform === 'darwin' || process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized;
}

async function runWithFileEditQueue<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const queueKey = getEditQueueKey(filePath);
    const previous = editQueues.get(queueKey) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const queued = previous.then(() => current, () => current);
    editQueues.set(queueKey, queued);

    await previous.catch(() => undefined);

    try {
        return await operation();
    } finally {
        release();
        if (editQueues.get(queueKey) === queued) {
            editQueues.delete(queueKey);
        }
    }
}

async function resolveEditPath(absolutePath: string): Promise<ResolvedEditPath | null> {
    let resolvedPath = absolutePath;
    let exists = await Bun.file(resolvedPath).exists();

    if (!exists) {
        const caseResolved = await resolveCaseInsensitivePath(path.normalize(absolutePath));
        if (caseResolved) {
            resolvedPath = caseResolved;
            exists = await Bun.file(resolvedPath).exists();
        }
    }

    if (!exists) return null;

    let queuePath = resolvedPath;
    try {
        queuePath = await fs.realpath(resolvedPath);
    } catch {
        // The existence check above is the user-facing validation. If realpath
        // fails after that, fall back to the resolved path for queueing.
    }

    return { resolvedPath, queuePath };
}

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
    /** Conversation to credit as the origin of a new memory */
    conversationId?: string;
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

        const resolved = await resolveEditPath(absolutePath);
        if (!resolved) {
            return {
                query,
                file: file_path,
                uri: file_path,
                compiled: `Error: File '${file_path}' not found`,
            };
        }

        return await runWithFileEditQueue(resolved.queuePath, () => editResolvedFile(
            args,
            options,
            query,
            resolved.resolvedPath,
        ));
    } catch (error) {
        const errorMsg = `Error editing file ${file_path}: ${error instanceof Error ? error.message : String(error)}`;
        log.error({ err: error }, errorMsg);

        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: errorMsg,
        };
    }
}

async function editResolvedFile(
    args: EditFileArgs,
    options: EditFileOptions | undefined,
    query: string,
    resolvedPath: string,
): Promise<EditFileResult> {
    const { file_path, old_string, new_string, replace_all = false } = args;
    const file = Bun.file(resolvedPath);

    if (!await file.exists()) {
        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: `Error: File '${file_path}' not found`,
        };
    }

    const content = await file.text();
    if (!content.includes(old_string)) {
        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: `Error: old_string not found in file. Make sure you're using the exact text from the file.`,
        };
    }

    const occurrences = content.split(old_string).length - 1;
    if (!replace_all && occurrences > 1) {
        return {
            query,
            file: file_path,
            uri: file_path,
            compiled: `Error: old_string is not unique in the file (found ${occurrences} occurrences). Either provide a larger string with more surrounding context to make it unique, or set replace_all to true to replace all occurrences.`,
        };
    }

    let newContent: string;
    if (replace_all) {
        newContent = content.split(old_string).join(new_string);
    } else {
        const index = content.indexOf(old_string);
        newContent = content.slice(0, index) + new_string + content.slice(index + old_string.length);
    }

    let contentToWrite = newContent;
    if (isMemoryFile(resolvedPath)) {
        const rejection = memoryWriteError(newContent);
        if (rejection) {
            return { query, file: file_path, uri: file_path, compiled: rejection };
        }
        contentToWrite = stampProvenance(newContent, options?.conversationId);
    }

    if (!isPathWithinAllowedWrite(resolvedPath) && options?.confirmationContext) {
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

    await fs.writeFile(resolvedPath, contentToWrite, 'utf-8');

    const replacementCount = replace_all ? occurrences : 1;
    const message = `Successfully replaced ${replacementCount} occurrence${replacementCount > 1 ? 's' : ''} in ${file_path}`;

    log.debug({ file: file_path, replacements: replacementCount }, message);

    return {
        query,
        file: file_path,
        uri: file_path,
        compiled: message,
    };
}
