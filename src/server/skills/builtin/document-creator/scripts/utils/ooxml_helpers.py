#!/usr/bin/env python3
"""
OOXML Helper Utilities for Word Document Manipulation.

Provides low-level XML manipulation functions for editing Word documents.
Uses defusedxml for secure XML parsing.

Usage:
    from utils.ooxml_helpers import parse_document, find_text, create_tracked_insertion
"""

import re
from datetime import datetime
from pathlib import Path
from typing import Iterator
import defusedxml.ElementTree as ET


# OOXML Namespaces
NAMESPACES = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
}

# Register namespaces for output
for prefix, uri in NAMESPACES.items():
    ET.register_namespace(prefix, uri)


def parse_document(folder_path: str) -> ET.Element:
    """
    Parse the main document.xml from an unpacked DOCX folder.

    Args:
        folder_path: Path to unpacked DOCX folder

    Returns:
        Root element of document.xml
    """
    doc_path = Path(folder_path) / "word" / "document.xml"
    if not doc_path.exists():
        raise FileNotFoundError(f"document.xml not found in {folder_path}")

    tree = ET.parse(str(doc_path))
    return tree.getroot()


def save_document(root: ET.Element, folder_path: str) -> None:
    """
    Save the document.xml back to the unpacked folder.

    Args:
        root: Root element to save
        folder_path: Path to unpacked DOCX folder
    """
    doc_path = Path(folder_path) / "word" / "document.xml"
    tree = ET.ElementTree(root)

    # Write with XML declaration
    with open(doc_path, "wb") as f:
        tree.write(f, encoding="UTF-8", xml_declaration=True)


def find_paragraphs(root: ET.Element) -> Iterator[ET.Element]:
    """
    Find all paragraph elements in the document.

    Args:
        root: Document root element

    Yields:
        Paragraph (w:p) elements
    """
    for p in root.iter(f"{{{NAMESPACES['w']}}}p"):
        yield p


def find_runs(paragraph: ET.Element) -> Iterator[ET.Element]:
    """
    Find all run elements in a paragraph.

    Args:
        paragraph: Paragraph element

    Yields:
        Run (w:r) elements
    """
    for r in paragraph.iter(f"{{{NAMESPACES['w']}}}r"):
        yield r


def get_text_content(element: ET.Element) -> str:
    """
    Extract all text content from an element and its children.

    Args:
        element: Element to extract text from

    Returns:
        Concatenated text content
    """
    text_parts = []
    for t in element.iter(f"{{{NAMESPACES['w']}}}t"):
        if t.text:
            text_parts.append(t.text)
    return "".join(text_parts)


def find_text(root: ET.Element, search_text: str) -> list[tuple[ET.Element, ET.Element]]:
    """
    Find all occurrences of text in the document.

    Args:
        root: Document root element
        search_text: Text to search for

    Returns:
        List of (paragraph, run) tuples where text was found
    """
    results = []
    for p in find_paragraphs(root):
        para_text = get_text_content(p)
        if search_text in para_text:
            for r in find_runs(p):
                run_text = get_text_content(r)
                if search_text in run_text:
                    results.append((p, r))
    return results


def generate_rsid() -> str:
    """
    Generate a random RSID (Revision Session ID) for tracked changes.

    Returns:
        8-character hexadecimal RSID
    """
    import random

    return f"{random.randint(0, 0xFFFFFFFF):08X}"


def get_timestamp() -> str:
    """
    Get current timestamp in OOXML format.

    Returns:
        ISO 8601 formatted timestamp
    """
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def create_text_element(text: str, preserve_space: bool = True) -> ET.Element:
    """
    Create a w:t (text) element.

    Args:
        text: Text content
        preserve_space: Whether to preserve whitespace

    Returns:
        w:t element
    """
    t = ET.Element(f"{{{NAMESPACES['w']}}}t")
    t.text = text
    if preserve_space and (text.startswith(" ") or text.endswith(" ")):
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return t


def create_run(text: str, bold: bool = False, italic: bool = False) -> ET.Element:
    """
    Create a w:r (run) element with text.

    Args:
        text: Text content
        bold: Apply bold formatting
        italic: Apply italic formatting

    Returns:
        w:r element
    """
    r = ET.Element(f"{{{NAMESPACES['w']}}}r")

    # Add run properties if any formatting
    if bold or italic:
        rPr = ET.SubElement(r, f"{{{NAMESPACES['w']}}}rPr")
        if bold:
            ET.SubElement(rPr, f"{{{NAMESPACES['w']}}}b")
        if italic:
            ET.SubElement(rPr, f"{{{NAMESPACES['w']}}}i")

    # Add text
    t = create_text_element(text)
    r.append(t)

    return r


def create_tracked_insertion(
    text: str,
    author: str,
    change_id: int,
    bold: bool = False,
    italic: bool = False,
) -> ET.Element:
    """
    Create a tracked insertion (w:ins) element.

    Args:
        text: Text being inserted
        author: Author name
        change_id: Unique change ID
        bold: Apply bold formatting
        italic: Apply italic formatting

    Returns:
        w:ins element containing the insertion
    """
    ins = ET.Element(f"{{{NAMESPACES['w']}}}ins")
    ins.set(f"{{{NAMESPACES['w']}}}id", str(change_id))
    ins.set(f"{{{NAMESPACES['w']}}}author", author)
    ins.set(f"{{{NAMESPACES['w']}}}date", get_timestamp())

    # Add the run with text
    r = create_run(text, bold, italic)
    ins.append(r)

    return ins


def create_tracked_deletion(
    text: str,
    author: str,
    change_id: int,
) -> ET.Element:
    """
    Create a tracked deletion (w:del) element.

    Args:
        text: Text being deleted
        author: Author name
        change_id: Unique change ID

    Returns:
        w:del element containing the deletion
    """
    del_elem = ET.Element(f"{{{NAMESPACES['w']}}}del")
    del_elem.set(f"{{{NAMESPACES['w']}}}id", str(change_id))
    del_elem.set(f"{{{NAMESPACES['w']}}}author", author)
    del_elem.set(f"{{{NAMESPACES['w']}}}date", get_timestamp())

    # Create run with deleted text
    r = ET.Element(f"{{{NAMESPACES['w']}}}r")
    delText = ET.SubElement(r, f"{{{NAMESPACES['w']}}}delText")
    delText.text = text
    if text.startswith(" ") or text.endswith(" "):
        delText.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    del_elem.append(r)

    return del_elem


def enable_track_changes(folder_path: str) -> None:
    """
    Enable track changes in the document settings.

    Args:
        folder_path: Path to unpacked DOCX folder
    """
    settings_path = Path(folder_path) / "word" / "settings.xml"

    if not settings_path.exists():
        # Create minimal settings.xml if it doesn't exist
        root = ET.Element(f"{{{NAMESPACES['w']}}}settings")
        root.set(f"xmlns:w", NAMESPACES["w"])
    else:
        tree = ET.parse(str(settings_path))
        root = tree.getroot()

    # Check if trackRevisions already exists
    track_rev = root.find(f".//{{{NAMESPACES['w']}}}trackRevisions")
    if track_rev is None:
        # Add trackRevisions element
        track_rev = ET.Element(f"{{{NAMESPACES['w']}}}trackRevisions")
        root.insert(0, track_rev)

    # Save settings
    tree = ET.ElementTree(root)
    with open(settings_path, "wb") as f:
        tree.write(f, encoding="UTF-8", xml_declaration=True)


def escape_xml_text(text: str) -> str:
    """
    Escape special characters for XML text content.

    Args:
        text: Text to escape

    Returns:
        Escaped text
    """
    replacements = [
        ("&", "&amp;"),
        ("<", "&lt;"),
        (">", "&gt;"),
        ('"', "&quot;"),
        ("'", "&apos;"),
    ]
    result = text
    for old, new in replacements:
        result = result.replace(old, new)
    return result


def get_next_change_id(root: ET.Element) -> int:
    """
    Find the next available change ID for tracked changes.

    Args:
        root: Document root element

    Returns:
        Next available change ID
    """
    max_id = 0

    # Find all elements with w:id attribute
    for elem in root.iter():
        id_attr = elem.get(f"{{{NAMESPACES['w']}}}id")
        if id_attr:
            try:
                id_val = int(id_attr)
                max_id = max(max_id, id_val)
            except ValueError:
                pass

    return max_id + 1
