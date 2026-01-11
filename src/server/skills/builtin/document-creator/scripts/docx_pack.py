#!/usr/bin/env python3
"""
Pack an unpacked .docx folder back into a .docx file.

Usage:
    uvx --with defusedxml python docx_pack.py unpacked_folder/ --output output.docx

This script repacks an extracted OOXML folder structure back into a valid .docx file.
"""

import sys
import zipfile
import argparse
from pathlib import Path


# Files that must be at the root of the ZIP (not in subfolders)
ROOT_FILES = ["[Content_Types].xml"]

# Standard DOCX folder structure order (for compatibility)
FOLDER_ORDER = ["_rels", "docProps", "word"]


def pack_docx(folder_path: str, output_path: str) -> str:
    """
    Pack a folder into a .docx file.

    Args:
        folder_path: Path to the unpacked folder
        output_path: Path for the output .docx file

    Returns:
        Path to the created .docx file
    """
    folder = Path(folder_path)
    output = Path(output_path)

    if not folder.exists():
        raise FileNotFoundError(f"Folder not found: {folder_path}")

    if not folder.is_dir():
        raise ValueError(f"Not a directory: {folder_path}")

    # Check for required files
    content_types = folder / "[Content_Types].xml"
    if not content_types.exists():
        raise ValueError(f"Missing [Content_Types].xml in {folder_path}")

    document_xml = folder / "word" / "document.xml"
    if not document_xml.exists():
        raise ValueError(f"Missing word/document.xml in {folder_path}")

    # Create output directory if needed
    output.parent.mkdir(parents=True, exist_ok=True)

    # Create the ZIP file with DEFLATED compression
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as z:
        # Add files in a specific order for compatibility
        files_added = set()

        # First, add [Content_Types].xml at root
        for root_file in ROOT_FILES:
            file_path = folder / root_file
            if file_path.exists():
                z.write(file_path, root_file)
                files_added.add(file_path)

        # Then add folders in order
        for folder_name in FOLDER_ORDER:
            subfolder = folder / folder_name
            if subfolder.exists():
                for file_path in subfolder.rglob("*"):
                    if file_path.is_file() and file_path not in files_added:
                        arcname = str(file_path.relative_to(folder))
                        z.write(file_path, arcname)
                        files_added.add(file_path)

        # Add any remaining files
        for file_path in folder.rglob("*"):
            if file_path.is_file() and file_path not in files_added:
                arcname = str(file_path.relative_to(folder))
                z.write(file_path, arcname)

    print(f"Created: {output}")
    return str(output)


def main():
    parser = argparse.ArgumentParser(
        description="Pack an unpacked folder back into a .docx file",
        epilog="Example: python docx_pack.py unpacked_report/ --output report_edited.docx",
    )
    parser.add_argument("folder", help="Path to the unpacked folder")
    parser.add_argument(
        "--output",
        "-o",
        required=True,
        help="Output .docx file path",
    )

    args = parser.parse_args()

    try:
        pack_docx(args.folder, args.output)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
