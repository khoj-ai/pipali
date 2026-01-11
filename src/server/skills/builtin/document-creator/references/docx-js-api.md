# docx.js API Quick Reference

Reference for the `docx` npm library used by `docx_create.ts`.

## Document Structure

```
Document
└── Section[]
    ├── properties (page layout)
    ├── headers/footers
    └── children (Paragraph | Table)[]
        └── TextRun | ImageRun | etc.
```

## Core Elements

### Paragraph

```typescript
new Paragraph({
    children: [new TextRun({ text: "Content" })],
    heading: HeadingLevel.HEADING_1,  // Optional
    alignment: AlignmentType.CENTER,   // Optional
    spacing: { before: 200, after: 200 },
})
```

### TextRun

```typescript
new TextRun({
    text: "Styled text",
    bold: true,
    italics: true,
    underline: {},
    strike: true,
    font: "Arial",
    size: 24,  // Half-points (24 = 12pt)
    color: "FF0000",
})
```

### Heading Levels

| Level | Constant |
|-------|----------|
| 1 | `HeadingLevel.HEADING_1` |
| 2 | `HeadingLevel.HEADING_2` |
| 3 | `HeadingLevel.HEADING_3` |
| 4 | `HeadingLevel.HEADING_4` |
| 5 | `HeadingLevel.HEADING_5` |
| 6 | `HeadingLevel.HEADING_6` |

## Rich Text (RichText type)

In `docx_create.ts`, paragraphs and list items support rich text via the `RichText` type.

**Auto-linking:** URLs matching `https?://...` are automatically converted to clickable hyperlinks.

```typescript
type RichText = string | TextSegment[];

interface TextSegment {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    link?: string;  // Wraps in ExternalHyperlink
    color?: string;
}
```

### Usage in JSON spec

```json
// Simple string (backward compatible)
{ "type": "paragraph", "text": "Plain text" }

// Rich text with segments
{ "type": "paragraph", "text": [
  { "text": "Normal " },
  { "text": "bold", "bold": true },
  { "text": " and " },
  { "text": "link", "link": "https://example.com" }
]}

// List items also support RichText
{ "type": "bulletList", "items": [
  "Simple item",
  [{ "text": "Rich ", "bold": true }, { "text": "item" }]
]}
```

### Internal implementation

The `createTextChildren()` helper converts RichText to TextRun/ExternalHyperlink:

```typescript
function createTextChildren(
    text: RichText,
    defaultFont: string,
    defaultFontSize: number,
    defaultStyles?: { bold?: boolean; italic?: boolean; underline?: boolean; color?: string }
): (TextRun | ExternalHyperlink)[]
```

## Lists

### Bullet List

```typescript
new Paragraph({
    children: [new TextRun({ text: "Item" })],
    bullet: { level: 0 },
})
```

### Numbered List

Requires numbering configuration:

```typescript
const doc = new Document({
    numbering: {
        config: [{
            reference: "my-list",
            levels: [{
                level: 0,
                format: LevelFormat.DECIMAL,
                text: "%1.",
                alignment: AlignmentType.LEFT,
            }],
        }],
    },
    sections: [{
        children: [
            new Paragraph({
                children: [new TextRun({ text: "First" })],
                numbering: { reference: "my-list", level: 0 },
            }),
        ],
    }],
});
```

**Important**: Use same `reference` to continue numbering, different reference to restart.

## Tables

```typescript
new Table({
    rows: [
        new TableRow({
            children: [
                new TableCell({
                    children: [new Paragraph({ text: "Cell 1" })],
                    width: { size: 50, type: WidthType.PERCENTAGE },
                    shading: { fill: "4472C4", type: ShadingType.CLEAR },
                }),
                new TableCell({
                    children: [new Paragraph({ text: "Cell 2" })],
                    width: { size: 50, type: WidthType.PERCENTAGE },
                }),
            ],
        }),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
})
```

### Cell Borders

```typescript
new TableCell({
    borders: {
        top: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
        left: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
        right: { style: BorderStyle.SINGLE, size: 1, color: "000000" },
    },
})
```

### Cell Merge

```typescript
// Horizontal merge
new TableCell({
    columnSpan: 2,  // Spans 2 columns
})

// Vertical merge
new TableCell({
    rowSpan: 2,  // Spans 2 rows
})
```

## Images

```typescript
new Paragraph({
    children: [
        new ImageRun({
            data: fs.readFileSync("image.png"),
            transformation: { width: 400, height: 300 },
            type: "png",  // Required: png, jpg, jpeg, gif, bmp
        }),
    ],
})
```

**Common error**: Missing `type` parameter causes invalid XML.

## Page Breaks

```typescript
// Page break MUST be inside a Paragraph
new Paragraph({
    children: [new PageBreak()],
})
```

**Never** use `new PageBreak()` standalone.

## Headers and Footers

```typescript
new Document({
    sections: [{
        headers: {
            default: new Header({
                children: [new Paragraph({ text: "Header Text" })],
            }),
        },
        footers: {
            default: new Footer({
                children: [
                    new Paragraph({
                        children: [
                            new TextRun({ text: "Page " }),
                            new TextRun({ children: [PageNumber.CURRENT] }),
                            new TextRun({ text: " of " }),
                            new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
                        ],
                        alignment: AlignmentType.CENTER,
                    }),
                ],
            }),
        },
        children: [/* content */],
    }],
})
```

## Hyperlinks

### External Link

```typescript
new Paragraph({
    children: [
        new ExternalHyperlink({
            link: "https://example.com",
            children: [
                new TextRun({
                    text: "Click here",
                    style: "Hyperlink",
                }),
            ],
        }),
    ],
})
```

### Internal Link (Bookmark)

```typescript
// Create bookmark
new Paragraph({
    children: [
        new Bookmark({ id: "section1", children: [new TextRun("Section 1")] }),
    ],
})

// Link to bookmark
new Paragraph({
    children: [
        new InternalHyperlink({
            anchor: "section1",
            children: [new TextRun({ text: "Go to Section 1" })],
        }),
    ],
})
```

## Section Properties

```typescript
new Document({
    sections: [{
        properties: {
            type: SectionType.CONTINUOUS,  // or NEXT_PAGE
            page: {
                margin: {
                    top: convertInchesToTwip(1),
                    bottom: convertInchesToTwip(1),
                    left: convertInchesToTwip(1),
                    right: convertInchesToTwip(1),
                },
                size: {
                    orientation: PageOrientation.LANDSCAPE,
                },
            },
        },
        children: [/* content */],
    }],
})
```

## Alignment Types

| Alignment | Constant |
|-----------|----------|
| Left | `AlignmentType.LEFT` |
| Center | `AlignmentType.CENTER` |
| Right | `AlignmentType.RIGHT` |
| Justified | `AlignmentType.JUSTIFIED` |

## Unit Conversions

```typescript
import { convertInchesToTwip, convertMillimetersToTwip } from "docx";

// 1 inch = 1440 twips
const oneInch = convertInchesToTwip(1);  // 1440

// 1 mm = ~56.7 twips
const tenMm = convertMillimetersToTwip(10);
```

## Common Mistakes

1. **Line breaks**: Never use `\n`. Create separate Paragraph elements.
2. **Unicode bullets**: Never use `•` for lists. Use proper `bullet` property.
3. **Standalone PageBreak**: Always wrap in Paragraph.
4. **Missing image type**: Always specify `type: "png"` etc.
5. **Table cell width**: Must specify `columnWidths` on Table AND `width` on each cell.
6. **Black backgrounds**: Always use `ShadingType.CLEAR` for cell shading.
