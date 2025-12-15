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
    compiled: string | Array<{ type: string; [key: string]: any }>;
    isImage?: boolean;
}

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

        // Check if file is an image
        if (isImageFile(resolvedPath)) {
            try {
                // Read image as array buffer and convert to base64
                console.log(`[Image] Reading: ${resolvedPath}`);
                const arrayBuffer = await file.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                const mimeType = getMimeType(resolvedPath);
                // const dataUrl = `data:${mimeType};base64,${base64}`;
                console.log(`[Image] Encoded: ${(arrayBuffer.byteLength / 1024).toFixed(2)} KB as ${mimeType}`);

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
                console.error(`[Image] Error reading ${filePath}:`, imageError);
                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: `Error reading image file ${filePath}: ${imageError instanceof Error ? imageError.message : String(imageError)}`,
                };
            }
        }

        // Read file content as text
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
