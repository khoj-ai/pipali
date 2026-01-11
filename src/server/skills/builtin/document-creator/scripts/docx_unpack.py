#!/usr/bin/env python3
"""
Unpack a .docx file to a folder for OOXML editing.

Usage:
    uvx --with defusedxml python docx_unpack.py input.docx
    uvx --with defusedxml python docx_unpack.py input.docx --output unpacked_folder/

A .docx file is a ZIP archive containing XML files. This script extracts
them to a folder where they can be edited directly.
"""

import sys
import zipfile
import argparse
from pathlib import Path


def unpack_docx(docx_path: str, output_dir: str | None = None) -> str:
    """
    Unpack a .docx file to a folder.

    Args:
        docx_path: Path to the .docx file
        output_dir: Output directory (default: same name as docx without extension)

    Returns:
        Path to the unpacked folder
    """
    docx = Path(docx_path)

    if not docx.exists():
        raise FileNotFoundError(f"File not found: {docx_path}")

    if not docx.suffix.lower() == ".docx":
        raise ValueError(f"Not a .docx file: {docx_path}")

    # Determine output directory
    if output_dir:
        out = Path(output_dir)
    else:
        out = docx.with_suffix("")  # Remove .docx extension

    # Create output directory
    out.mkdir(parents=True, exist_ok=True)

    # Extract all files
    with zipfile.ZipFile(docx, "r") as z:
        z.extractall(out)

    print(f"Unpacked to: {out}")
    print(f"  - word/document.xml: Main document content")
    print(f"  - word/styles.xml: Document styles")
    print(f"  - [Content_Types].xml: Content type definitions")

    return str(out)


def main():
    parser = argparse.ArgumentParser(
        description="Unpack a .docx file for OOXML editing",
        epilog="Example: python docx_unpack.py report.docx --output unpacked/",
    )
    parser.add_argument("docx_file", help="Path to the .docx file to unpack")
    parser.add_argument(
        "--output",
        "-o",
        help="Output directory (default: same name as docx file without extension)",
    )

    args = parser.parse_args()

    try:
        unpack_docx(args.docx_file, args.output)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except zipfile.BadZipFile:
        print(f"Error: {args.docx_file} is not a valid ZIP/DOCX file", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
