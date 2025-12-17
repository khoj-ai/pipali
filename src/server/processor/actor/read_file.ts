import path from 'path';
import os from 'os';
import { resolveCaseInsensitivePath } from './actor.utils';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { PPTXLoader } from '@langchain/community/document_loaders/fs/pptx';
import * as XLSX from 'xlsx';

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

/** Default maximum lines to read when no limit is specified */
const DEFAULT_LINE_LIMIT = 50;

// Supported image formats
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Supported document formats
const PDF_EXTENSION = '.pdf';
const DOCX_EXTENSIONS = ['.docx', '.doc'];
const EXCEL_EXTENSIONS = ['.xlsx', '.xls'];
const PPT_EXTENSIONS = ['.pptx', '.ppt'];

/**
 * Check if a file path is an image based on extension
 */
function isImageFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if a file path is a PDF based on extension
 */
function isPdfFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === PDF_EXTENSION;
}

/**
 * Check if a file path is a Word document based on extension
 */
function isWordDoc(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return DOCX_EXTENSIONS.includes(ext);
}

/**
 * Check if a file path is an Excel spreadsheet based on extension
 */
function isExcelFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return EXCEL_EXTENSIONS.includes(ext);
}

/**
 * Check if a file path is a PowerPoint presentation based on extension
 */
function isPptFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return PPT_EXTENSIONS.includes(ext);
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
 * - Word documents (.docx, .doc)
 * - Excel spreadsheets (.xlsx, .xls)
 * - PowerPoint presentations (.pptx, .ppt)
 */
export async function readFile(args: ReadFileArgs): Promise<FileContentResult> {
    const { path: filePath, offset = 0, limit } = args;

    let query = `View file: ${filePath}`;
    if (offset > 0 || limit) {
        const parts: string[] = [];
        if (offset > 0) parts.push(`offset=${offset}`);
        if (limit) parts.push(`limit=${limit}`);
        query += ` (${parts.join(', ')})`;
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
                console.log(`[Image] Reading: ${resolvedPath}`);
                const arrayBuffer = await file.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                const mimeType = getMimeType(resolvedPath);
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

        // Check if file is a PDF
        if (isPdfFile(resolvedPath)) {
            try {
                console.log(`[PDF] Reading: ${resolvedPath}`);
                const loader = new PDFLoader(resolvedPath, {
                    splitPages: false,
                });
                const docs = await loader.load();

                if (docs.length === 0) {
                    return {
                        query,
                        file: filePath,
                        uri: filePath,
                        compiled: `PDF file '${filePath}' contains no readable text content.`,
                    };
                }

                const pdfText = docs.map(doc => doc.pageContent).join('\n\n');
                const pageCount = (docs[0]?.metadata as any)?.pdf?.totalPages || docs.length;
                console.log(`[PDF] Extracted ${pdfText.length} characters from ${pageCount} page(s)`);

                const filterResult = applyLineFilter(pdfText, offset, limit);
                const truncationMsg = formatTruncationMessage(filterResult, 'PDF');
                const filteredText = `[PDF: ${pageCount} page(s), ${filterResult.totalLines} lines]\n\n${filterResult.content}${truncationMsg}`;

                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: filteredText,
                };
            } catch (pdfError) {
                console.error(`[PDF] Error reading ${filePath}:`, pdfError);
                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: `Error reading PDF file ${filePath}: ${pdfError instanceof Error ? pdfError.message : String(pdfError)}`,
                };
            }
        }

        // Check if file is a Word document
        if (isWordDoc(resolvedPath)) {
            try {
                console.log(`[DOCX] Reading: ${resolvedPath}`);
                const loader = new DocxLoader(resolvedPath);
                const docs = await loader.load();

                if (docs.length === 0) {
                    return {
                        query,
                        file: filePath,
                        uri: filePath,
                        compiled: `Word document '${filePath}' contains no readable text content.`,
                    };
                }

                const docText = docs.map(doc => doc.pageContent).join('\n\n');
                console.log(`[DOCX] Extracted ${docText.length} characters`);

                const filterResult = applyLineFilter(docText, offset, limit);
                const truncationMsg = formatTruncationMessage(filterResult, 'Document');
                const filteredText = `[Word Document: ${filterResult.totalLines} lines]\n\n${filterResult.content}${truncationMsg}`;

                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: filteredText,
                };
            } catch (docxError) {
                console.error(`[DOCX] Error reading ${filePath}:`, docxError);
                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: `Error reading Word document ${filePath}: ${docxError instanceof Error ? docxError.message : String(docxError)}`,
                };
            }
        }

        // Check if file is an Excel spreadsheet
        if (isExcelFile(resolvedPath)) {
            try {
                console.log(`[XLSX] Reading: ${resolvedPath}`);
                const arrayBuffer = await file.arrayBuffer();
                const workbook = XLSX.read(arrayBuffer, { type: 'array' });

                const sheetNames = workbook.SheetNames;
                if (sheetNames.length === 0) {
                    return {
                        query,
                        file: filePath,
                        uri: filePath,
                        compiled: `Excel file '${filePath}' contains no sheets.`,
                    };
                }

                // Convert all sheets to text
                const sheetsText: string[] = [];
                for (const sheetName of sheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    if (sheet) {
                        const csv = XLSX.utils.sheet_to_csv(sheet);
                        sheetsText.push(`--- Sheet: ${sheetName} ---\n${csv}`);
                    }
                }

                const xlsxText = sheetsText.join('\n\n');
                console.log(`[XLSX] Extracted ${xlsxText.length} characters from ${sheetNames.length} sheet(s)`);

                const filterResult = applyLineFilter(xlsxText, offset, limit);
                const truncationMsg = formatTruncationMessage(filterResult, 'Spreadsheet');
                const filteredText = `[Excel: ${sheetNames.length} sheet(s), ${filterResult.totalLines} lines]\n\n${filterResult.content}${truncationMsg}`;

                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: filteredText,
                };
            } catch (excelError) {
                console.error(`[Excel] Error reading ${filePath}:`, excelError);
                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: `Error reading Excel file ${filePath}: ${excelError instanceof Error ? excelError.message : String(excelError)}`,
                };
            }
        }

        // Check if file is a PowerPoint presentation
        if (isPptFile(resolvedPath)) {
            try {
                console.log(`[PPT] Reading: ${resolvedPath}`);
                const loader = new PPTXLoader(resolvedPath);
                const docs = await loader.load();

                if (docs.length === 0) {
                    return {
                        query,
                        file: filePath,
                        uri: filePath,
                        compiled: `PowerPoint file '${filePath}' contains no readable text content.`,
                    };
                }

                const pptText = docs.map(doc => doc.pageContent).join('\n\n');
                console.log(`[PPT] Extracted ${pptText.length} characters`);

                const filterResult = applyLineFilter(pptText, offset, limit);
                const truncationMsg = formatTruncationMessage(filterResult, 'Presentation');
                const filteredText = `[PowerPoint: ${filterResult.totalLines} lines]\n\n${filterResult.content}${truncationMsg}`;

                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: filteredText,
                };
            } catch (pptError) {
                console.error(`[PPT] Error reading ${filePath}:`, pptError);
                return {
                    query,
                    file: filePath,
                    uri: filePath,
                    compiled: `Error reading PowerPoint file ${filePath}: ${pptError instanceof Error ? pptError.message : String(pptError)}`,
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
        console.error(errorMsg, error);

        return {
            query,
            file: filePath,
            uri: filePath,
            compiled: errorMsg,
        };
    }
}
