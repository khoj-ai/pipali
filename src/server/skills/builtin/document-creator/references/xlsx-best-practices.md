# Excel Best Practices

Professional spreadsheet creation standards for financial models and business reports.

## Golden Rules

1. **Never hardcode calculated values** - Always use Excel formulas
2. **Separate inputs from calculations** - Put assumptions in dedicated cells/sheets
3. **Use consistent formatting** - Apply color coding and number formats uniformly
4. **Document your work** - Include assumption sources and methodology notes

## Color Coding Standard

| Color | RGB Hex | Usage |
|-------|---------|-------|
| Blue | `#0070C0` | Input values, assumptions |
| Black | `#000000` | Formulas and calculations |
| Green | `#00B050` | Cross-sheet references |
| Red | `#FF0000` | External file references |
| Yellow (background) | `#FFFF00` | Key assumptions requiring attention |

### Visual Example

```
Revenue Growth Rate:  15%      ← Blue (input)
Revenue 2024:        $100,000  ← Black (=D5*1.15)
From Other Sheet:    $50,000   ← Green (=Summary!B10)
```

## Number Formats

| Type | Format Code | Example |
|------|-------------|---------|
| Currency | `$#,##0` | $1,234 |
| Currency (decimals) | `$#,##0.00` | $1,234.56 |
| Accounting | `_($* #,##0.00_)` | $ 1,234.56 |
| Percentage | `0.0%` | 15.5% |
| Percentage (2 dec) | `0.00%` | 15.50% |
| Years | `@` (text) | 2024 |
| Zeros as dash | `#,##0;-#,##0;"-"` | - |
| Negative in parens | `#,##0;(#,##0)` | (1,234) |

### Year Formatting

**Problem**: `2024` displays as `2,024` with number formatting.

**Solution**: Format years as text using `@` format or prefix with apostrophe.

```python
# In xlsx_create.py spec
"data": [
    ["Year", "Revenue"],
    ["'2024", 100000],  # Apostrophe forces text
]
```

## Formula Patterns

### Safe Division

```excel
=IF(B2=0, 0, A2/B2)
=IFERROR(A2/B2, 0)
```

### Year-over-Year Growth

```excel
=IF(B2=0, "", (C2-B2)/ABS(B2))
```

### Percentage of Total

```excel
=IF($D$10=0, 0, B5/$D$10)
```

### SUMIF with Multiple Criteria

```excel
=SUMIFS(Amount, Category, "Revenue", Year, 2024)
```

### Dynamic Range Reference

```excel
=SUM(INDIRECT("B2:B"&ROW()))
```

## Common Excel Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `#REF!` | Invalid cell reference | Check deleted rows/columns |
| `#DIV/0!` | Division by zero | Add IF or IFERROR wrapper |
| `#VALUE!` | Wrong data type | Check for text in number cells |
| `#NAME?` | Unrecognized formula | Check spelling, quotes |
| `#N/A` | Lookup not found | Add IFERROR, check lookup values |
| `#NULL!` | Incorrect range | Check range operators (: vs ,) |

## Sheet Organization

### Recommended Structure

```
1. Cover         - Title, date, version, author
2. TOC           - Table of contents with hyperlinks
3. Assumptions   - All inputs and assumptions
4. Data          - Raw data (hidden or protected)
5. Calculations  - Main model calculations
6. Summary       - Executive summary outputs
7. Charts        - Visualizations
8. Appendix      - Supporting details
```

### Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Sheets | Title case, short | `Revenue Model` |
| Named ranges | snake_case | `revenue_growth_rate` |
| Tables | tbl_PascalCase | `tblMonthlyData` |
| Input cells | Descriptive | `Input_TaxRate` |

## Formula Audit Checklist

1. **No hardcoded values in formulas**
   - Bad: `=B2*1.15`
   - Good: `=B2*(1+$C$1)` where C1 = 15%

2. **All references are correct**
   - Check for proper absolute/relative references
   - Test by copying formulas

3. **Error handling exists**
   - Wrap potentially problematic formulas in IFERROR

4. **Cross-sheet references are explicit**
   - Use full sheet names: `=Summary!B10`

5. **Circular references resolved**
   - Check Formulas → Error Checking

## Data Validation

### Dropdown List

```python
# In xlsx_create.py
from openpyxl.worksheet.datavalidation import DataValidation

dv = DataValidation(
    type="list",
    formula1='"Option1,Option2,Option3"',
    allow_blank=True
)
ws.add_data_validation(dv)
dv.add("A1:A100")
```

### Number Range

```python
dv = DataValidation(
    type="whole",
    operator="between",
    formula1="0",
    formula2="100"
)
```

## Conditional Formatting

### Highlight Negatives

```python
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Font

red_font = Font(color="FF0000")
rule = CellIsRule(operator="lessThan", formula=["0"], font=red_font)
ws.conditional_formatting.add("B2:B100", rule)
```

### Data Bars

```python
from openpyxl.formatting.rule import DataBarRule

rule = DataBarRule(
    start_type="min",
    end_type="max",
    color="638EC6"
)
ws.conditional_formatting.add("C2:C100", rule)
```

## Performance Tips

1. **Limit VLOOKUP/INDEX-MATCH** - Use tables and structured references
2. **Avoid volatile functions** - NOW(), TODAY(), OFFSET(), INDIRECT()
3. **Use helper columns** - Break complex formulas into steps
4. **Minimize array formulas** - They calculate on every change
5. **Set calculation to manual** for large files during editing

## Quality Checklist

Before delivering a spreadsheet:

- [ ] All formulas calculate correctly
- [ ] No #REF!, #DIV/0!, or other errors
- [ ] Color coding applied consistently
- [ ] Assumptions documented with sources
- [ ] Print areas set correctly
- [ ] Headers/footers include filename and date
- [ ] Password protection if needed
- [ ] File named with version and date
