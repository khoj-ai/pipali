import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { resolveCaseInsensitivePath } from './actor.utils';
import { extractDocumentText, getLegacyOfficeReplacement, isReadableDocumentFile } from './document_text';
import { getSensitivePathReason } from '../../security';
import {
    type ConfirmationContext,
    requestOperationConfirmation,
} from '../confirmation';
import { isPathDeniedForRead } from '../../sandbox';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'read_file' });

/**
 * Arguments for the read_file tool.
 */
export interface ReadFileArgs {
    /** The file path to read (absolute or relative to home directory) */
    path: string;
    /** Starting line offset (0-based). For text files only. */
    offset?: number;
    /** Maximum number of lines to read. For text files only. */
    limit?: number;
}

export interface FileContentResult {
    query: string;
    file: string;
    uri: string;
    compiled: string | Array<{ type: string; [key: string]: any }>;
    isImage?: boolean;
}

/**
 * Options for file reading operations
 */
export interface ReadFileOptions {
    /** Confirmation context for requesting user approval on sensitive paths */
    confirmationContext?: ConfirmationContext;
}

/** Default maximum lines to read when no limit is specified */
const DEFAULT_LINE_LIMIT = 50;

// Supported image formats
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * Check if a file path is an image based on extension
 */
function isImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Result of applying line filtering to text content
 */
interface LineFilterResult {
    content: string;
    truncated: boolean;
    totalLines: number;
    startLine: number;
    endLine: number;
}

/**
 * Apply offset/limit filtering to lines of text.
 *
 * @param text - The raw text content
 * @param offset - Starting line offset (0-based), defaults to 0
 * @param limit - Maximum number of lines to read, defaults to DEFAULT_LINE_LIMIT
 * @returns Filtered content with metadata
 */
function applyLineFilter(text: string, offset: number = 0, limit?: number): LineFilterResult {
    const lines = text.split('\n');
    const totalLines = lines.length;

    // Clamp offset to valid range
    const startIdx = Math.max(0, Math.min(offset, totalLines));

    // Apply limit (default to DEFAULT_LINE_LIMIT if not specified)
    const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
    const endIdx = Math.min(startIdx + effectiveLimit, totalLines);

    const selectedLines = lines.slice(startIdx, endIdx);
    const truncated = endIdx < totalLines;

    return {
        content: selectedLines.join('\n'),
        truncated,
        totalLines,
        startLine: startIdx,
        endLine: endIdx,
    };
}

/**
 * Format truncation message for output
 */
function formatTruncationMessage(result: LineFilterResult, fileType: string = 'File'): string {
    if (!result.truncated) return '';
    return `\n\n[${fileType} truncated: showing lines ${result.startLine + 1}-${result.endLine} of ${result.totalLines}. Use offset/limit parameters to view more.]`;
}

/**
 * View the contents of a file with optional line range specification.
 *
 * Supports:
 * - Text files with offset/limit filtering
 * - Images (jpg, jpeg, png, webp) - returned as base64
 * - PDFs - text extraction with offset/limit
 * - Word documents (.docx)
 * - Excel spreadsheets (.xlsx)
 * - PowerPoint presentations (.pptx)
 * - OpenDocument files (.odt, .ods, .odp)
 *
 * Security:
 * - Sensitive paths (SSH keys, credentials, etc.) require user confirmation
 */
export async function readFile(
    args: ReadFileArgs,
    options?: ReadFileOptions
): Promise<FileContentResult> {
    const { path: filePath, offset = 0, limit } = args;

    let query = `View file: ${filePath}`;
    if (offset > 0 || limit) {
        const parts: string[] = [];
        if (offset > 0) parts.push(`offset=${offset}`);
        if (limit) parts.push(`limit=${limit}`);
        query += ` (${parts.join(', ')})`;
    }

    try {
        // Expand tilde to home directory if present
        const expandedPath = filePath.startsWith('~/')
            ? path.join(os.homedir(), filePath.slice(2))
            : filePath === '~'
                ? os.homedir()
                : filePath;

        // Resolve to absolute path (relative paths resolve relative to home folder)
        const absolutePath = path.isAbsolute(expandedPath)
            ? expandedPath
            : path.resolve(os.homedir(), expandedPath);

        // The result to return if the user says no to reading a protected path, else null
        const askToRead = async (protectedPath: string): Promise<FileContentResult | null> => {
            if (!options?.confirmationContext) return null;
            const reason = getSensitivePathReason(protectedPath) || 'protected file';
            const confirmResult = await requestOperationConfirmation(
                'read_sensitive_file',
                protectedPath,
                options.confirmationContext,
                {
                    toolName: 'view_file',
                    toolArgs: { path: filePath, offset, limit },
                    additionalMessage: `This path contains ${reason}.\n\nAre you sure you want to read this file?`,
                }
            );
            if (confirmResult.approved) return null;
            return {
                query,
                file: filePath,
                uri: filePath,
                compiled: `File read cancelled: ${confirmResult.denialReason || 'User denied access to protected file'}`,
            };
        };

        // A protected name is asked about before looking, so whether it exists stays private
        const askedFirst = isPathDeniedForRead(absolutePath);
        if (askedFirst) {
            const cancelled = await askToRead(absolutePath);
            if (cancelled) return cancelled;
        }

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

        // The file read is the one judged, so a protected file is asked about however it is reached
        resolvedPath = await fs.realpath(resolvedPath);
        file = Bun.file(resolvedPath);
        if (!askedFirst && isPathDeniedForRead(resolvedPath)) {
            const cancelled = await askToRead(resolvedPath);
            if (cancelled) return cancelled;
        }

        // Check if file is an image
        if (isImageFile(resolvedPath)) {
            try {
                log.debug(`[Image] Reading: ${resolvedPath}`);
                const arrayBuffer = await file.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                const mimeType = getMimeType(resolvedPath);
                log.debug(`[Image] Encoded: ${(arrayBuffer.byteLength / 1024).toFixed(2)} KB as ${mimeType}`);

                // Return multimodal content for vision-enabled models
                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: [
                        {
                            type: 'text',
                            text: `Read image file: ${filePath}\nSize: ${(arrayBuffer.byteLength / 1024).toFixed(2)} KB\nFormat: ${mimeType}`
                        },
                        {
                            type: 'image',
                            source_type: 'base64',
                            mime_type: mimeType,
                            data: base64,
                        }
                    ],
                    isImage: true,
                };
            } catch (imageError) {
                log.error({ err: imageError }, `Error reading image ${filePath}`);
                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: `Error reading image file ${filePath}: ${imageError instanceof Error ? imageError.message : String(imageError)}`,
                };
            }
        }

        const legacyOfficeReplacement = getLegacyOfficeReplacement(resolvedPath);
        if (legacyOfficeReplacement) {
            const extension = path.extname(resolvedPath).toLowerCase();
            return {
                query,
                file: filePath,
                uri: filePath,
                compiled: `Legacy Office format '${extension}' is not supported. Convert the file to '${legacyOfficeReplacement}' to view its contents.`,
            };
        }

        if (isReadableDocumentFile(resolvedPath)) {
            try {
                const document = await extractDocumentText(resolvedPath);

                if (!document.text) {
                    return {
                        query,
                        file: filePath,
                        uri: filePath,
                        compiled: `${document.name} file '${filePath}' contains no readable text content.`,
                    };
                }

                log.debug(`Extracted ${document.text.length} characters from ${document.name} ${resolvedPath}`);
                const filterResult = applyLineFilter(document.text, offset, limit);
                const truncationMsg = formatTruncationMessage(filterResult, document.truncationLabel);
                const details = document.detail ? `${document.detail}, ` : '';

                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: `[${document.name}: ${details}${filterResult.totalLines} lines]\n\n${filterResult.content}${truncationMsg}`,
                };
            } catch (documentError) {
                log.error({ err: documentError }, `Error reading document ${filePath}`);
                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: `Error reading document ${filePath}: ${documentError instanceof Error ? documentError.message : String(documentError)}`,
                };
            }
        }

        // Read file content as text (default handler)
        const rawText = await file.text();
        const filterResult = applyLineFilter(rawText, offset, limit);
        const truncationMsg = formatTruncationMessage(filterResult, 'File');
        const filteredText = filterResult.content + truncationMsg;

        return {
            query,
            file: filePath,
            uri: filePath,
            compiled: filteredText,
        };
    } catch (error) {
        const errorMsg = `Error reading file ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
        log.error({ err: error }, errorMsg);

        return {
            query,
            file: filePath,
            uri: filePath,
            compiled: errorMsg,
        };
    }
}
