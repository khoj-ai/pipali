#!/usr/bin/env npx tsx
/**
 * Word Document Creator
 * Creates .docx files from JSON specifications using the docx library.
 *
 * Usage:
 *   bunx tsx docx_create.ts --spec spec.json --output report.docx
 *   bunx tsx docx_create.ts --stdin --output report.docx  # Read spec from stdin
 *
 * Dependencies (auto-installed via bunx):
 *   - docx: Word document generation
 */

import {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    BorderStyle,
    ImageRun,
    PageBreak,
    NumberFormat,
    Header,
    Footer,
    PageNumber,
    ShadingType,
    convertInchesToTwip,
    LevelFormat,
    ExternalHyperlink,
} from 'docx';
import * as fs from 'fs';
import * as path from 'path';

// Types for document specification
interface DocSpec {
    properties?: {
        title?: string;
        creator?: string;
        description?: string;
        subject?: string;
    };
    styles?: {
        defaultFont?: string;
        headingFont?: string;
        fontSize?: number;
    };
    sections: SectionSpec[];
}

interface SectionSpec {
    properties?: {
        type?: 'continuous' | 'nextPage' | 'evenPage' | 'oddPage';
        orientation?: 'portrait' | 'landscape';
    };
    headers?: { default?: string };
    footers?: { default?: string; pageNumbers?: boolean };
    children: ElementSpec[];
}

type ElementSpec =
    | HeadingSpec
    | ParagraphSpec
    | BulletListSpec
    | NumberedListSpec
    | TableSpec
    | ImageSpec
    | PageBreakSpec;

interface HeadingSpec {
    type: 'heading';
    level: 1 | 2 | 3 | 4 | 5 | 6;
    text: string;
    style?: string;
}

// Rich text support: a segment of text with optional formatting
interface TextSegment {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    link?: string; // URL - wraps text in ExternalHyperlink
    color?: string;
}

// RichText can be a simple string or an array of formatted segments
type RichText = string | TextSegment[];

interface ParagraphSpec {
    type: 'paragraph';
    text: RichText;
    // Legacy single-style properties (applied when text is a string)
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    alignment?: 'left' | 'center' | 'right' | 'justified';
    fontSize?: number;
    color?: string;
}

interface BulletListSpec {
    type: 'bulletList';
    items: RichText[];
    level?: number;
}

interface NumberedListSpec {
    type: 'numberedList';
    items: RichText[];
    level?: number;
}

interface TableSpec {
    type: 'table';
    headers: string[];
    rows: string[][];
    widths?: number[];
    headerStyle?: {
        bold?: boolean;
        fill?: string;
        fontColor?: string;
    };
}

interface ImageSpec {
    type: 'image';
    path: string;
    width?: number;
    height?: number;
    caption?: string;
}

interface PageBreakSpec {
    type: 'pageBreak';
}

// Numbering configuration for lists
const numberingConfig = {
    config: [
        {
            reference: 'bullet-list',
            levels: [
                {
                    level: 0,
                    format: LevelFormat.BULLET,
                    text: '\u2022',
                    alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } } },
                },
                {
                    level: 1,
                    format: LevelFormat.BULLET,
                    text: '\u25E6',
                    alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: convertInchesToTwip(1), hanging: convertInchesToTwip(0.25) } } },
                },
            ],
        },
        {
            reference: 'numbered-list',
            levels: [
                {
                    level: 0,
                    format: LevelFormat.DECIMAL,
                    text: '%1.',
                    alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } } },
                },
                {
                    level: 1,
                    format: LevelFormat.LOWER_LETTER,
                    text: '%2.',
                    alignment: AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: convertInchesToTwip(1), hanging: convertInchesToTwip(0.25) } } },
                },
            ],
        },
    ],
};

function getHeadingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
    const levels: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5,
        6: HeadingLevel.HEADING_6,
    };
    return levels[level] || HeadingLevel.HEADING_1;
}

function getAlignment(align?: string): AlignmentType {
    const alignments: Record<string, AlignmentType> = {
        left: AlignmentType.LEFT,
        center: AlignmentType.CENTER,
        right: AlignmentType.RIGHT,
        justified: AlignmentType.JUSTIFIED,
    };
    return alignments[align || 'left'] || AlignmentType.LEFT;
}

function hexToRgb(hex: string): string {
    // Remove # if present and return uppercase
    return hex.replace('#', '').toUpperCase();
}

// Default text color - dark gray for standard professional-styling.md aesthetics
const DEFAULT_TEXT_COLOR = '404040';

// Spacing constants in twips (1/20 of a point, 1440 twips = 1 inch)
const SPACING = {
    // Heading spacing (before/after in twips)
    heading1: { before: 360, after: 240 },  // 18pt before, 12pt after
    heading2: { before: 320, after: 160 },  // 16pt before, 8pt after
    heading3: { before: 280, after: 120 },  // 14pt before, 6pt after
    heading4: { before: 240, after: 80 },   // 12pt before, 4pt after
    // Paragraph spacing
    paragraph: { before: 0, after: 160 },   // 0pt before, 8pt after
    // List item spacing
    listItem: { before: 0, after: 80 },     // 0pt before, 4pt after
};

// Font sizes in half-points (24 = 12pt)
const FONT_SIZES = {
    heading1: 48,  // 24pt
    heading2: 36,  // 18pt
    heading3: 28,  // 14pt
    heading4: 24,  // 12pt
    body: 22,      // 11pt
};

// Hyperlink style color
const LINK_COLOR = '0563C1';

// URL regex pattern for auto-linking
const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;

/**
 * Parse text and split into segments, auto-detecting URLs.
 * Returns array of {text, isUrl} objects.
 */
function parseTextWithUrls(text: string): Array<{ text: string; isUrl: boolean }> {
    const segments: Array<{ text: string; isUrl: boolean }> = [];
    let lastIndex = 0;

    // Reset regex state
    URL_PATTERN.lastIndex = 0;

    let match;
    while ((match = URL_PATTERN.exec(text)) !== null) {
        // Add text before the URL
        if (match.index > lastIndex) {
            segments.push({ text: text.slice(lastIndex, match.index), isUrl: false });
        }
        // Add the URL
        segments.push({ text: match[0], isUrl: true });
        lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last URL
    if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex), isUrl: false });
    }

    // If no URLs found, return the original text
    if (segments.length === 0) {
        segments.push({ text, isUrl: false });
    }

    return segments;
}

/**
 * Create a TextRun with the given properties.
 */
function createTextRun(
    text: string,
    font: string,
    fontSize: number,
    styles: { bold?: boolean; italic?: boolean; underline?: boolean; color?: string }
): TextRun {
    return new TextRun({
        text,
        font,
        size: fontSize * 2, // Half-points
        bold: styles.bold === true,
        italics: styles.italic === true,
        underline: styles.underline ? {} : undefined,
        color: styles.color || DEFAULT_TEXT_COLOR,
    });
}

/**
 * Convert RichText (string or TextSegment[]) to an array of TextRun/ExternalHyperlink children.
 * This is the shared helper for paragraphs and list items.
 * Automatically detects and links URLs in text.
 */
function createTextChildren(
    text: RichText,
    defaultFont: string,
    defaultFontSize: number,
    defaultStyles?: { bold?: boolean; italic?: boolean; underline?: boolean; color?: string }
): (TextRun | ExternalHyperlink)[] {
    // Simple string case - parse for URLs
    if (typeof text === 'string') {
        const parsed = parseTextWithUrls(text);
        return parsed.map((segment) => {
            if (segment.isUrl) {
                const linkRun = createTextRun(segment.text, defaultFont, defaultFontSize, {
                    bold: defaultStyles?.bold,
                    italic: defaultStyles?.italic,
                    underline: true,
                    color: LINK_COLOR,
                });
                return new ExternalHyperlink({
                    link: segment.text,
                    children: [linkRun],
                });
            }
            return createTextRun(segment.text, defaultFont, defaultFontSize, {
                bold: defaultStyles?.bold,
                italic: defaultStyles?.italic,
                underline: defaultStyles?.underline,
                color: defaultStyles?.color ? hexToRgb(defaultStyles.color) : undefined,
            });
        });
    }

    // Array of segments case
    const result: (TextRun | ExternalHyperlink)[] = [];
    for (const segment of text) {
        // If segment has explicit link, use that
        if (segment.link) {
            const linkRun = createTextRun(segment.text, defaultFont, defaultFontSize, {
                bold: segment.bold,
                italic: segment.italic,
                underline: true,
                color: LINK_COLOR,
            });
            result.push(
                new ExternalHyperlink({
                    link: segment.link,
                    children: [linkRun],
                })
            );
            continue;
        }

        // Otherwise, parse text for URLs
        const parsed = parseTextWithUrls(segment.text);
        for (const part of parsed) {
            if (part.isUrl) {
                const linkRun = createTextRun(part.text, defaultFont, defaultFontSize, {
                    bold: segment.bold,
                    italic: segment.italic,
                    underline: true,
                    color: LINK_COLOR,
                });
                result.push(
                    new ExternalHyperlink({
                        link: part.text,
                        children: [linkRun],
                    })
                );
            } else {
                result.push(
                    createTextRun(part.text, defaultFont, defaultFontSize, {
                        bold: segment.bold,
                        italic: segment.italic,
                        underline: segment.underline,
                        color: segment.color ? hexToRgb(segment.color) : undefined,
                    })
                );
            }
        }
    }

    return result;
}

function createHeading(spec: HeadingSpec, defaultFont: string): Paragraph {
    const level = spec.level;
    const spacingKey = `heading${Math.min(level, 4)}` as keyof typeof SPACING;
    const fontSizeKey = `heading${Math.min(level, 4)}` as keyof typeof FONT_SIZES;
    const spacing = SPACING[spacingKey] || SPACING.heading4;
    const fontSize = FONT_SIZES[fontSizeKey] || FONT_SIZES.heading4;

    return new Paragraph({
        children: [
            new TextRun({
                text: spec.text,
                font: defaultFont,
                bold: true,
                size: fontSize,
                color: '2F5496', // Professional dark blue for headings
            }),
        ],
        heading: getHeadingLevel(spec.level),
        spacing: {
            before: spacing.before,
            after: spacing.after,
        },
    });
}

function createParagraph(spec: ParagraphSpec, defaultFont: string, defaultFontSize: number): Paragraph {
    const fontSize = spec.fontSize || defaultFontSize;
    const children = createTextChildren(spec.text, defaultFont, fontSize, {
        bold: spec.bold,
        italic: spec.italic,
        underline: spec.underline,
        color: spec.color,
    });

    return new Paragraph({
        children,
        alignment: getAlignment(spec.alignment),
        spacing: {
            before: SPACING.paragraph.before,
            after: SPACING.paragraph.after,
            line: 276, // 1.15 line spacing (240 = single, 276 = 1.15, 360 = 1.5)
        },
    });
}

function createBulletList(spec: BulletListSpec, defaultFont: string, defaultFontSize: number): Paragraph[] {
    return spec.items.map((item, index) => {
        const children = createTextChildren(item, defaultFont, defaultFontSize);
        return new Paragraph({
            children,
            numbering: { reference: 'bullet-list', level: spec.level || 0 },
            spacing: {
                before: index === 0 ? 120 : SPACING.listItem.before,
                after: index === spec.items.length - 1 ? 160 : SPACING.listItem.after,
                line: 276,
            },
        });
    });
}

function createNumberedList(spec: NumberedListSpec, defaultFont: string, defaultFontSize: number): Paragraph[] {
    return spec.items.map((item, index) => {
        const children = createTextChildren(item, defaultFont, defaultFontSize);
        return new Paragraph({
            children,
            numbering: { reference: 'numbered-list', level: spec.level || 0 },
            spacing: {
                before: index === 0 ? 120 : SPACING.listItem.before,
                after: index === spec.items.length - 1 ? 160 : SPACING.listItem.after,
                line: 276,
            },
        });
    });
}

function createTable(spec: TableSpec, defaultFont: string, defaultFontSize: number): Table {
    const headerStyle = spec.headerStyle || { bold: true, fill: '4472C4', fontColor: 'FFFFFF' };
    const columnCount = spec.headers.length;
    // Default to equal widths in DXA (twips) - 9000 twips ≈ 6.25 inches total table width
    const defaultColWidth = Math.floor(9000 / columnCount);
    const widths = spec.widths || Array(columnCount).fill(defaultColWidth);

    // Create header row - headers use bold white text, no auto-linking (typically labels)
    const headerRow = new TableRow({
        children: spec.headers.map(
            (header, i) =>
                new TableCell({
                    children: [
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: header,
                                    font: defaultFont,
                                    size: defaultFontSize * 2,
                                    bold: headerStyle.bold !== false,
                                    color: headerStyle.fontColor ? hexToRgb(headerStyle.fontColor) : 'FFFFFF',
                                }),
                            ],
                            alignment: AlignmentType.CENTER,
                        }),
                    ],
                    shading: {
                        type: ShadingType.CLEAR,
                        fill: headerStyle.fill ? hexToRgb(headerStyle.fill) : '4472C4',
                    },
                    width: { size: widths[i], type: WidthType.DXA },
                })
        ),
    });

    // Create data rows - data cells support auto-linking URLs
    const dataRows = spec.rows.map(
        (row) =>
            new TableRow({
                children: row.map((cell, i) => {
                    const cellText = String(cell);
                    const children = createTextChildren(cellText, defaultFont, defaultFontSize);
                    return new TableCell({
                        children: [new Paragraph({ children })],
                        width: { size: widths[i], type: WidthType.DXA },
                    });
                }),
            })
    );

    // Calculate total width for columnWidths
    const totalWidth = widths.reduce((sum, w) => sum + w, 0);

    return new Table({
        rows: [headerRow, ...dataRows],
        width: { size: totalWidth, type: WidthType.DXA },
        columnWidths: widths,
    });
}

async function createImage(spec: ImageSpec): Promise<Paragraph> {
    const imagePath = spec.path;

    if (!fs.existsSync(imagePath)) {
        console.error(`Warning: Image not found: ${imagePath}`);
        return new Paragraph({
            children: [new TextRun({ text: `[Image not found: ${imagePath}]`, italics: true })],
        });
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase().slice(1);

    // Determine image type
    type ImageType = 'png' | 'jpg' | 'jpeg' | 'gif' | 'bmp';
    const imageType: ImageType = ['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(ext) ? (ext as ImageType) : 'png';

    // Default dimensions if not specified
    const width = spec.width || 400;
    const height = spec.height || Math.round(width * 0.75); // Default 4:3 aspect ratio

    const children: (ImageRun | TextRun)[] = [
        new ImageRun({
            data: imageBuffer,
            transformation: { width, height },
            type: imageType,
        }),
    ];

    const paragraphs: Paragraph[] = [new Paragraph({ children, alignment: AlignmentType.CENTER })];

    // Add caption if specified
    if (spec.caption) {
        paragraphs.push(
            new Paragraph({
                children: [new TextRun({ text: spec.caption, italics: true, size: 20 })],
                alignment: AlignmentType.CENTER,
            })
        );
    }

    return paragraphs[0];
}

function createPageBreak(): Paragraph {
    return new Paragraph({
        children: [new PageBreak()],
    });
}

async function processElement(
    element: ElementSpec,
    defaultFont: string,
    defaultFontSize: number
): Promise<(Paragraph | Table)[]> {
    switch (element.type) {
        case 'heading':
            return [createHeading(element, defaultFont)];
        case 'paragraph':
            return [createParagraph(element, defaultFont, defaultFontSize)];
        case 'bulletList':
            return createBulletList(element, defaultFont, defaultFontSize);
        case 'numberedList':
            return createNumberedList(element, defaultFont, defaultFontSize);
        case 'table':
            return [createTable(element, defaultFont, defaultFontSize)];
        case 'image':
            return [await createImage(element)];
        case 'pageBreak':
            return [createPageBreak()];
        default:
            console.warn(`Unknown element type: ${(element as ElementSpec).type}`);
            return [];
    }
}

async function createDocument(spec: DocSpec): Promise<Document> {
    const defaultFont = spec.styles?.defaultFont || 'Calibri';
    const defaultFontSize = spec.styles?.fontSize || 11;

    // Warn if fontSize seems too large (likely confusion with half-points)
    if (defaultFontSize > 20) {
        console.warn(
            `Warning: fontSize ${defaultFontSize}pt is unusually large for body text. ` +
            `Did you mean ${Math.round(defaultFontSize / 2)}pt? (fontSize is in points, not half-points)`
        );
    }

    const sections = await Promise.all(
        spec.sections.map(async (section) => {
            const children: (Paragraph | Table)[] = [];

            for (const element of section.children) {
                const processed = await processElement(element, defaultFont, defaultFontSize);
                children.push(...processed);
            }

            const headers: Record<string, Header> = {};
            const footers: Record<string, Footer> = {};

            if (section.headers?.default) {
                headers.default = new Header({
                    children: [new Paragraph({ children: [new TextRun({ text: section.headers.default })] })],
                });
            }

            if (section.footers?.default || section.footers?.pageNumbers) {
                const footerChildren: (TextRun | PageNumber)[] = [];
                if (section.footers?.default) {
                    footerChildren.push(new TextRun({ text: section.footers.default + ' - ' }));
                }
                if (section.footers?.pageNumbers) {
                    footerChildren.push(new TextRun({ children: [PageNumber.CURRENT] }));
                    footerChildren.push(new TextRun({ text: ' of ' }));
                    footerChildren.push(new TextRun({ children: [PageNumber.TOTAL_PAGES] }));
                }
                footers.default = new Footer({
                    children: [new Paragraph({ children: footerChildren, alignment: AlignmentType.CENTER })],
                });
            }

            return {
                properties: section.properties || {},
                headers: Object.keys(headers).length > 0 ? headers : undefined,
                footers: Object.keys(footers).length > 0 ? footers : undefined,
                children,
            };
        })
    );

    return new Document({
        creator: spec.properties?.creator || 'Pipali.ai',
        title: spec.properties?.title,
        description: spec.properties?.description,
        subject: spec.properties?.subject,
        numbering: numberingConfig,
        styles: {
            default: {
                document: {
                    run: {
                        font: defaultFont,
                        size: defaultFontSize * 2,
                    },
                    paragraph: {
                        spacing: {
                            after: 160, // Default 8pt after paragraphs
                            line: 276,  // 1.15 line spacing
                        },
                    },
                },
                heading1: {
                    run: {
                        font: defaultFont,
                        size: FONT_SIZES.heading1,
                        bold: true,
                        color: '2F5496',
                    },
                    paragraph: {
                        spacing: { before: SPACING.heading1.before, after: SPACING.heading1.after },
                    },
                },
                heading2: {
                    run: {
                        font: defaultFont,
                        size: FONT_SIZES.heading2,
                        bold: true,
                        color: '2F5496',
                    },
                    paragraph: {
                        spacing: { before: SPACING.heading2.before, after: SPACING.heading2.after },
                    },
                },
                heading3: {
                    run: {
                        font: defaultFont,
                        size: FONT_SIZES.heading3,
                        bold: true,
                        color: '2F5496',
                    },
                    paragraph: {
                        spacing: { before: SPACING.heading3.before, after: SPACING.heading3.after },
                    },
                },
            },
        },
        sections,
    });
}

async function main() {
    const args = process.argv.slice(2);
    let specPath: string | null = null;
    let outputPath: string | null = null;
    let useStdin = false;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--spec' && args[i + 1]) {
            specPath = args[++i];
        } else if (args[i] === '--output' && args[i + 1]) {
            outputPath = args[++i];
        } else if (args[i] === '--stdin') {
            useStdin = true;
        } else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`
Word Document Creator

Usage:
  bunx tsx docx_create.ts --spec spec.json --output document.docx
  bunx tsx docx_create.ts --stdin --output document.docx

Options:
  --spec <file>    Path to JSON specification file
  --output <file>  Output .docx file path
  --stdin          Read specification from stdin
  --help, -h       Show this help message

Example spec.json:
{
  "properties": { "title": "My Document", "creator": "Pipali.ai" },
  "sections": [{
    "children": [
      { "type": "heading", "level": 1, "text": "Title" },
      { "type": "paragraph", "text": "Simple text paragraph." },
      { "type": "paragraph", "text": [
        { "text": "Rich text with " },
        { "text": "bold", "bold": true },
        { "text": " and " },
        { "text": "links", "link": "https://example.com" }
      ]},
      { "type": "bulletList", "items": ["Simple item", [{ "text": "Rich ", "bold": true }, { "text": "item" }]] }
    ]
  }]
}
`);
            process.exit(0);
        }
    }

    // Validate arguments
    if (!outputPath) {
        console.error('Error: --output is required');
        process.exit(1);
    }

    if (!specPath && !useStdin) {
        console.error('Error: Either --spec or --stdin is required');
        process.exit(1);
    }

    // Read specification
    let specJson: string;
    if (useStdin) {
        specJson = fs.readFileSync(0, 'utf-8'); // Read from stdin
    } else {
        if (!fs.existsSync(specPath!)) {
            console.error(`Error: Spec file not found: ${specPath}`);
            process.exit(1);
        }
        specJson = fs.readFileSync(specPath!, 'utf-8');
    }

    let spec: DocSpec;
    try {
        spec = JSON.parse(specJson);
    } catch (e) {
        console.error(`Error: Invalid JSON in specification: ${e}`);
        process.exit(1);
    }

    // Create document
    try {
        const doc = await createDocument(spec);
        const buffer = await Packer.toBuffer(doc);

        // Ensure output directory exists
        const outDir = path.dirname(outputPath);
        if (outDir && !fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        fs.writeFileSync(outputPath, buffer);
        console.log(`Document created: ${outputPath}`);
    } catch (e) {
        console.error(`Error creating document: ${e}`);
        process.exit(1);
    }
}

main();
