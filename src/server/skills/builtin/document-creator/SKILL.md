---
name: document-creator
description: Create and edit professional Word (.docx) and Excel (.xlsx) documents. Use to create reports, memos, proposals, financial models, invoices, or modify existing Office documents. Supports rich text, tables, lists, images, formulas, charts, and tracked changes.
---

# Document Creator

Create professional-grade Word and Excel documents for expert knowledge workers.

## Quick Reference

| Task | Tool | Command Pattern |
|------|------|-----------------|
| Create Word doc | `docx_create.ts` | `bun run scripts/docx_create.ts --spec spec.json --output doc.docx` |
| Edit Word doc | `docx_unpack.py` + XML editing + `docx_pack.py` | See Word Editing section |
| Create/Edit Excel | `xlsx_create.py` | `uvx --with openpyxl python scripts/xlsx_create.py --spec spec.json --output file.xlsx` |
| Verify formulas | `xlsx_recalc.py` | `uvx --with openpyxl python scripts/xlsx_recalc.py file.xlsx` |

## Decision Tree

```
What type of document?
├── Word (.docx)
│   ├── Create new → Use docx_create.ts (TypeScript)
│   └── Edit existing → Unpack → Edit XML → Repack (Python)
└── Excel (.xlsx)
    └── Create or Edit → Use xlsx_create.py (Python)
```

## Word Document Creation

Use `scripts/docx_create.ts` to create new Word documents from a JSON specification.

### First-Time Setup

1. Install Bun and UV on first run if not already available on machine.

2. The Word creation script requires the `docx` npm package. Install once:

```bash
cd ~/.pipali/skills/document-creator/scripts && bun install
```

### Running the Script

```bash
# From the scripts directory (after setup)
cd ~/.pipali/skills/document-creator/scripts
bun run docx_create.ts --spec spec.json --output report.docx

# Or with full path
bun run ~/.pipali/skills/document-creator/scripts/docx_create.ts \
  --spec spec.json \
  --output report.docx
```

### Specification Format

```json
{
  "properties": {
    "title": "Document Title",
    "creator": "Author Name"
  },
  "styles": {
    "defaultFont": "Calibri",
    "headingFont": "Cambria",
    "fontSize": 11
  },
  "sections": [
    {
      "properties": { "type": "continuous" },
      "children": [
        { "type": "heading", "level": 1, "text": "Main Title" },
        { "type": "paragraph", "text": "Introduction paragraph." },
        { "type": "heading", "level": 2, "text": "Section 1" },
        { "type": "bulletList", "items": ["First point", "Second point"] },
        { "type": "numberedList", "items": ["Step 1", "Step 2"] },
        {
          "type": "table",
          "headers": ["Column A", "Column B"],
          "rows": [
            ["Cell 1", "Cell 2"],
            ["Cell 3", "Cell 4"]
          ]
        },
        { "type": "image", "path": "/path/to/image.png", "width": 400 },
        { "type": "pageBreak" }
      ]
    }
  ]
}
```

### Element Types

| Type | Required Fields | Optional Fields |
|------|-----------------|-----------------|
| `heading` | `level` (1-6), `text` | `style` |
| `paragraph` | `text` (string or RichText) | `bold`, `italic`, `alignment`, `color` |
| `bulletList` | `items` (array of string or RichText) | `level` |
| `numberedList` | `items` (array of string or RichText) | `level` |
| `table` | `headers`, `rows` | `widths`, `headerStyle` |
| `image` | `path` | `width`, `height`, `caption` |
| `pageBreak` | - | - |

### Rich Text Support

Paragraphs and list items support rich text with inline formatting and links. Text can be:
- A simple string: `"Plain text"`
- An array of segments with formatting: `[{ "text": "bold", "bold": true }, { "text": " normal" }]`

**Auto-linking:** URLs (http:// or https://) in text are automatically converted to clickable hyperlinks.

**TextSegment properties:**
| Property | Type | Description |
|----------|------|-------------|
| `text` | string | The text content (required) |
| `bold` | boolean | Bold formatting |
| `italic` | boolean | Italic formatting |
| `underline` | boolean | Underline formatting |
| `link` | string | URL - makes text a clickable hyperlink |
| `color` | string | Text color as hex (e.g., "#FF0000") |

**Examples:**

```json
// Simple paragraph (backward compatible)
{ "type": "paragraph", "text": "Plain text paragraph." }

// Paragraph with inline formatting
{ "type": "paragraph", "text": [
  { "text": "This has " },
  { "text": "bold", "bold": true },
  { "text": " and " },
  { "text": "italic", "italic": true },
  { "text": " text." }
]}

// Paragraph with link
{ "type": "paragraph", "text": [
  { "text": "Visit " },
  { "text": "our website", "link": "https://example.com" },
  { "text": " for more info." }
]}

// List with rich text items
{ "type": "bulletList", "items": [
  "Simple string item",
  [{ "text": "Item with " }, { "text": "bold part", "bold": true }],
  [{ "text": "Click ", "link": "https://docs.example.com" }]
]}

// Auto-linked URL (no explicit link property needed)
{ "type": "paragraph", "text": "Check out https://example.com for details." }
```

See `references/docx-js-api.md` for complete API reference.

## Word Document Editing

For editing existing documents (especially with tracked changes), use the unpack-edit-repack workflow.

### Step 1: Unpack

```bash
uvx --with defusedxml python ~/.pipali/skills/document-creator/scripts/docx_unpack.py \
  input.docx \
  --output unpacked_folder/
```

### Step 2: Edit XML

Edit `unpacked_folder/word/document.xml` directly. Key elements:
- `<w:p>` - Paragraph
- `<w:r>` - Run (text span)
- `<w:t>` - Text content
- `<w:ins>` - Tracked insertion
- `<w:del>` - Tracked deletion

Use `scripts/docx_edit.py` for common operations:

```bash
# Find and replace with tracked changes
uvx --with defusedxml python scripts/docx_edit.py \
  --folder unpacked_folder/ \
  --action replace \
  --find "old text" \
  --replace "new text" \
  --track-changes \
  --author "Your Name"
```

### Step 3: Repack

```bash
uvx --with defusedxml python ~/.pipali/skills/document-creator/scripts/docx_pack.py \
  unpacked_folder/ \
  --output output.docx
```

See `references/ooxml-structure.md` for XML element reference.

## Excel Creation and Editing

Use `scripts/xlsx_create.py` for all Excel operations.

### Running the Script

```bash
uvx --with openpyxl python ~/.pipali/skills/document-creator/scripts/xlsx_create.py \
  --spec spec.json \
  --output report.xlsx
```

### Specification Format

```json
{
  "sheets": [
    {
      "name": "Summary",
      "data": [
        ["Item", "Q1", "Q2", "Q3", "Total"],
        ["Revenue", 100000, 120000, 130000, "=SUM(B2:D2)"],
        ["Costs", 50000, 55000, 60000, "=SUM(B3:D3)"],
        ["Profit", "=B2-B3", "=C2-C3", "=D2-D3", "=SUM(B4:D4)"]
      ],
      "columnWidths": { "A": 15, "B": 12, "C": 12, "D": 12, "E": 12 },
      "formatting": {
        "A1:E1": { "bold": true, "fill": "#4472C4", "fontColor": "#FFFFFF" },
        "B2:E4": { "numberFormat": "$#,##0" }
      }
    }
  ]
}
```

### Critical Excel Rules

1. **Always use formulas** - Never calculate in code and hardcode results
2. **Color coding for financial models**:
   - Blue (`#0070C0`): Input values / assumptions
   - Black: Formulas and calculations
   - Green (`#00B050`): Cross-sheet references
3. **Number formats**:
   - Currency: `$#,##0.00`
   - Percentages: `0.0%`
   - Years: Use text format `@` to prevent `2,024`
   - Zeros: Display as `-` using conditional format

### Formula Verification

After creating files with formulas, verify them:

```bash
uvx --with openpyxl python ~/.pipali/skills/document-creator/scripts/xlsx_recalc.py \
  output.xlsx
```

Returns JSON with any formula errors (#REF!, #DIV/0!, etc.) and their locations.

See `references/xlsx-best-practices.md` for formula patterns and standards.

## Professional Standards

### Fonts
- **Body**: Calibri 11pt (Windows) or Arial 11pt (cross-platform)
- **Headings**: Cambria or Arial Bold
- **Monospace**: Consolas or Courier New

### Font Sizes (in points)
- `fontSize` in spec is in **points** (pt), not half-points
- Standard body: 11pt (use `"fontSize": 11`)
- Headings: 12-24pt depending on level

### Margins
- Standard: 1 inch (2.54 cm) all sides
- Narrow: 0.5 inch (1.27 cm) for dense reports

### Colors
- Primary: `#2F5496` (dark blue)
- Accent: `#4472C4` (medium blue)
- Success: `#00B050` (green)
- Warning: `#FFC000` (amber)
- Error: `#C00000` (red)

See `references/professional-styling.md` for complete style guide.

## Template Usage

Pre-built templates are available in `assets/templates/`:
- `report-template.docx` - Business report with sections
- `financial-model.xlsx` - 3-statement financial model

To use a template:
1. Copy template to working directory
2. Use editing scripts to modify content
3. Save with new filename

## Troubleshooting

### First-time setup for Word creation
```bash
cd ~/.pipali/skills/document-creator/scripts && bun install
```

### "bun not found"
Install Bun:
- Unix: `curl -fsSL https://bun.sh/install | bash`
- Windows: `irm https://bun.sh/install.ps1 | iex`

### "uvx not found"
Install uv:
- Unix: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- Windows: `irm https://astral.sh/uv/install.ps1 | iex"`

### LibreOffice not found (for xlsx_recalc.py)
The recalc script is optional. Install LibreOffice for formula verification:
- macOS: `brew install --cask libreoffice`
- Windows: Download from libreoffice.org

### Document won't open
Check for XML errors in the unpacked folder. Common issues:
- Unclosed tags
- Invalid characters (use `&#8217;` for apostrophe, etc.)
- Missing namespace declarations
