# OOXML Structure Reference

Reference for directly editing Word document XML (OOXML format).

## Document Structure

A `.docx` file is a ZIP archive containing:

```
document.docx (ZIP)
├── [Content_Types].xml     # MIME type declarations
├── _rels/
│   └── .rels              # Package relationships
├── docProps/
│   ├── app.xml            # Application properties
│   └── core.xml           # Core properties (title, author)
└── word/
    ├── document.xml       # Main document content
    ├── styles.xml         # Style definitions
    ├── settings.xml       # Document settings
    ├── fontTable.xml      # Font declarations
    ├── numbering.xml      # List definitions
    ├── comments.xml       # Comments (if any)
    ├── _rels/
    │   └── document.xml.rels  # Document relationships
    └── media/             # Embedded images
```

## Namespace Prefixes

Always declare these namespaces:

```xml
xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
```

## Core Elements

### Paragraph (`<w:p>`)

```xml
<w:p>
    <w:pPr>                    <!-- Paragraph properties -->
        <w:pStyle w:val="Heading1"/>
        <w:jc w:val="center"/>
    </w:pPr>
    <w:r>                      <!-- Run (text span) -->
        <w:t>Text content</w:t>
    </w:r>
</w:p>
```

### Run (`<w:r>`)

```xml
<w:r>
    <w:rPr>                    <!-- Run properties -->
        <w:b/>                 <!-- Bold -->
        <w:i/>                 <!-- Italic -->
        <w:u w:val="single"/>  <!-- Underline -->
        <w:color w:val="FF0000"/>
        <w:sz w:val="24"/>     <!-- Size in half-points -->
    </w:rPr>
    <w:t>Styled text</w:t>
</w:r>
```

### Text (`<w:t>`)

```xml
<!-- Preserve whitespace -->
<w:t xml:space="preserve"> text with spaces </w:t>
```

**Important**: Use `xml:space="preserve"` when text has leading/trailing spaces.

## Paragraph Properties Order

Elements in `<w:pPr>` must follow this order:

1. `<w:pStyle>`
2. `<w:keepNext>`
3. `<w:keepLines>`
4. `<w:pageBreakBefore>`
5. `<w:numPr>` (list numbering)
6. `<w:spacing>`
7. `<w:ind>` (indentation)
8. `<w:jc>` (justification)

## Tracked Changes

### Enable Track Changes

In `word/settings.xml`:
```xml
<w:settings>
    <w:trackRevisions/>
</w:settings>
```

### Insertion (`<w:ins>`)

```xml
<w:ins w:id="1" w:author="John Doe" w:date="2024-01-15T10:30:00Z">
    <w:r>
        <w:t>inserted text</w:t>
    </w:r>
</w:ins>
```

### Deletion (`<w:del>`)

```xml
<w:del w:id="2" w:author="John Doe" w:date="2024-01-15T10:30:00Z">
    <w:r>
        <w:delText>deleted text</w:delText>
    </w:r>
</w:del>
```

**Note**: Use `<w:delText>` instead of `<w:t>` for deleted text.

### Revision Session ID (RSID)

```xml
<w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3">
```

RSIDs are 8-digit hexadecimal values that track editing sessions.

## Tables

```xml
<w:tbl>
    <w:tblPr>
        <w:tblW w:w="5000" w:type="pct"/>  <!-- 50% width -->
    </w:tblPr>
    <w:tblGrid>
        <w:gridCol w:w="2500"/>
        <w:gridCol w:w="2500"/>
    </w:tblGrid>
    <w:tr>
        <w:tc>
            <w:tcPr>
                <w:tcW w:w="2500" w:type="dxa"/>
                <w:shd w:val="clear" w:fill="4472C4"/>
            </w:tcPr>
            <w:p>
                <w:r><w:t>Cell 1</w:t></w:r>
            </w:p>
        </w:tc>
    </w:tr>
</w:tbl>
```

## Lists

In `word/numbering.xml`:
```xml
<w:numbering>
    <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0">
            <w:start w:val="1"/>
            <w:numFmt w:val="bullet"/>
            <w:lvlText w:val=""/>
            <w:lvlJc w:val="left"/>
        </w:lvl>
    </w:abstractNum>
    <w:num w:numId="1">
        <w:abstractNumId w:val="0"/>
    </w:num>
</w:numbering>
```

Reference in document:
```xml
<w:p>
    <w:pPr>
        <w:pStyle w:val="ListParagraph"/>
        <w:numPr>
            <w:ilvl w:val="0"/>
            <w:numId w:val="1"/>
        </w:numPr>
    </w:pPr>
    <w:r><w:t>List item</w:t></w:r>
</w:p>
```

## Images

In `word/document.xml`:
```xml
<w:drawing>
    <wp:inline>
        <wp:extent cx="914400" cy="914400"/>  <!-- EMUs (914400 = 1 inch) -->
        <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                    <pic:blipFill>
                        <a:blip r:embed="rId4"/>
                    </pic:blipFill>
                </pic:pic>
            </a:graphicData>
        </a:graphic>
    </wp:inline>
</w:drawing>
```

In `word/_rels/document.xml.rels`:
```xml
<Relationship Id="rId4" Type=".../image" Target="media/image1.png"/>
```

In `[Content_Types].xml`:
```xml
<Default Extension="png" ContentType="image/png"/>
```

## Character Escaping

| Character | XML Entity |
|-----------|------------|
| & | `&amp;` |
| < | `&lt;` |
| > | `&gt;` |
| " | `&quot;` |
| ' | `&apos;` |

### Special Characters

| Character | Unicode |
|-----------|---------|
| Left quote " | `&#8220;` |
| Right quote " | `&#8221;` |
| Apostrophe ' | `&#8217;` |
| Em dash — | `&#8212;` |
| En dash – | `&#8211;` |
| Ellipsis … | `&#8230;` |
| Non-breaking space | `&#160;` |

## Hyperlinks

```xml
<w:hyperlink r:id="rId5">
    <w:r>
        <w:rPr>
            <w:rStyle w:val="Hyperlink"/>
        </w:rPr>
        <w:t>Link text</w:t>
    </w:r>
</w:hyperlink>
```

In `word/_rels/document.xml.rels`:
```xml
<Relationship Id="rId5" Type=".../hyperlink" Target="https://example.com" TargetMode="External"/>
```

## Page Break

```xml
<w:p>
    <w:r>
        <w:br w:type="page"/>
    </w:r>
</w:p>
```

## Common Validation Errors

1. **Missing namespace**: Always include required xmlns declarations
2. **Wrong element order**: Follow strict ordering in `<w:pPr>` and `<w:rPr>`
3. **Unclosed tags**: Validate XML before repacking
4. **Missing relationships**: Images and hyperlinks need entries in `.rels` files
5. **Missing content type**: New file types need `[Content_Types].xml` entries
