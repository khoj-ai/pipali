#!/usr/bin/env python3
"""
Edit Word documents with support for tracked changes.

Usage:
    uvx --with defusedxml python docx_edit.py --folder unpacked/ --action replace \
        --find "old text" --replace "new text" --track-changes --author "Your Name"

Actions:
    replace     Find and replace text
    insert      Insert text at a location
    delete      Delete text

This script modifies the XML files in an unpacked DOCX folder.
Use docx_pack.py to create the final .docx file.
"""

import sys
import argparse
from pathlib import Path

# Add parent directory to path for utils import
sys.path.insert(0, str(Path(__file__).parent))

from utils.ooxml_helpers import (
    parse_document,
    save_document,
    find_paragraphs,
    find_runs,
    get_text_content,
    create_tracked_insertion,
    create_tracked_deletion,
    create_run,
    get_next_change_id,
    enable_track_changes,
    NAMESPACES,
)
import defusedxml.ElementTree as ET


def replace_text(
    folder_path: str,
    find_text: str,
    replace_text: str,
    track_changes: bool = False,
    author: str = "Document Editor",
) -> int:
    """
    Find and replace text in the document.

    Args:
        folder_path: Path to unpacked DOCX folder
        find_text: Text to find
        replace_text: Text to replace with
        track_changes: Whether to use tracked changes
        author: Author name for tracked changes

    Returns:
        Number of replacements made
    """
    root = parse_document(folder_path)
    replacements = 0
    change_id = get_next_change_id(root) if track_changes else 0

    if track_changes:
        enable_track_changes(folder_path)

    for para in find_paragraphs(root):
        para_text = get_text_content(para)

        if find_text not in para_text:
            continue

        # Process each run in the paragraph
        runs = list(find_runs(para))
        for run in runs:
            run_text = get_text_content(run)

            if find_text not in run_text:
                continue

            # Get the parent of the run
            parent = None
            for p in para.iter():
                if run in list(p):
                    parent = p
                    break

            if parent is None:
                parent = para

            # Find the index of this run
            run_index = list(parent).index(run)

            if track_changes:
                # Create deletion for old text
                del_elem = create_tracked_deletion(find_text, author, change_id)
                change_id += 1

                # Create insertion for new text
                ins_elem = create_tracked_insertion(replace_text, author, change_id)
                change_id += 1

                # Split the run text around the found text
                before, _, after = run_text.partition(find_text)

                # Remove the original run
                parent.remove(run)

                # Insert elements in order
                insert_index = run_index
                if before:
                    before_run = create_run(before)
                    parent.insert(insert_index, before_run)
                    insert_index += 1

                parent.insert(insert_index, del_elem)
                insert_index += 1

                parent.insert(insert_index, ins_elem)
                insert_index += 1

                if after:
                    after_run = create_run(after)
                    parent.insert(insert_index, after_run)

            else:
                # Simple replacement without tracking
                new_text = run_text.replace(find_text, replace_text)

                # Update the text element
                for t in run.iter(f"{{{NAMESPACES['w']}}}t"):
                    t.text = new_text
                    break

            replacements += 1

    save_document(root, folder_path)
    return replacements


def insert_text_after(
    folder_path: str,
    after_text: str,
    new_text: str,
    track_changes: bool = False,
    author: str = "Document Editor",
) -> bool:
    """
    Insert text after a specific string.

    Args:
        folder_path: Path to unpacked DOCX folder
        after_text: Text to insert after
        new_text: Text to insert
        track_changes: Whether to use tracked changes
        author: Author name for tracked changes

    Returns:
        True if insertion was made
    """
    root = parse_document(folder_path)
    change_id = get_next_change_id(root) if track_changes else 0

    if track_changes:
        enable_track_changes(folder_path)

    for para in find_paragraphs(root):
        para_text = get_text_content(para)

        if after_text not in para_text:
            continue

        for run in find_runs(para):
            run_text = get_text_content(run)

            if after_text not in run_text:
                continue

            # Get parent element
            parent = None
            for p in para.iter():
                if run in list(p):
                    parent = p
                    break

            if parent is None:
                parent = para

            run_index = list(parent).index(run)

            # Split the run text
            before, _, after = run_text.partition(after_text)
            full_before = before + after_text

            # Remove original run
            parent.remove(run)

            # Insert before text + after_text
            insert_index = run_index
            before_run = create_run(full_before)
            parent.insert(insert_index, before_run)
            insert_index += 1

            # Insert new text
            if track_changes:
                ins_elem = create_tracked_insertion(new_text, author, change_id)
                parent.insert(insert_index, ins_elem)
            else:
                new_run = create_run(new_text)
                parent.insert(insert_index, new_run)
            insert_index += 1

            # Insert remaining text
            if after:
                after_run = create_run(after)
                parent.insert(insert_index, after_run)

            save_document(root, folder_path)
            return True

    return False


def delete_text(
    folder_path: str,
    text_to_delete: str,
    track_changes: bool = False,
    author: str = "Document Editor",
) -> int:
    """
    Delete text from the document.

    Args:
        folder_path: Path to unpacked DOCX folder
        text_to_delete: Text to delete
        track_changes: Whether to use tracked changes
        author: Author name for tracked changes

    Returns:
        Number of deletions made
    """
    if track_changes:
        # For tracked changes, replace with empty string shows deletion
        return replace_text(folder_path, text_to_delete, "", track_changes, author)
    else:
        # Simple deletion
        return replace_text(folder_path, text_to_delete, "", False, author)


def main():
    parser = argparse.ArgumentParser(
        description="Edit Word documents with tracked changes support",
        epilog="Example: python docx_edit.py --folder unpacked/ --action replace "
        '--find "old" --replace "new" --track-changes --author "John"',
    )
    parser.add_argument(
        "--folder",
        "-f",
        required=True,
        help="Path to unpacked DOCX folder",
    )
    parser.add_argument(
        "--action",
        "-a",
        required=True,
        choices=["replace", "insert", "delete"],
        help="Action to perform",
    )
    parser.add_argument(
        "--find",
        help="Text to find (for replace/delete)",
    )
    parser.add_argument(
        "--replace",
        help="Replacement text (for replace)",
    )
    parser.add_argument(
        "--after",
        help="Text to insert after (for insert)",
    )
    parser.add_argument(
        "--text",
        help="Text to insert (for insert) or delete (for delete)",
    )
    parser.add_argument(
        "--track-changes",
        "-t",
        action="store_true",
        help="Use tracked changes",
    )
    parser.add_argument(
        "--author",
        default="Document Editor",
        help="Author name for tracked changes",
    )

    args = parser.parse_args()

    # Validate folder exists
    if not Path(args.folder).exists():
        print(f"Error: Folder not found: {args.folder}", file=sys.stderr)
        sys.exit(1)

    try:
        if args.action == "replace":
            if not args.find:
                print("Error: --find is required for replace action", file=sys.stderr)
                sys.exit(1)
            if args.replace is None:
                print(
                    "Error: --replace is required for replace action", file=sys.stderr
                )
                sys.exit(1)

            count = replace_text(
                args.folder,
                args.find,
                args.replace,
                args.track_changes,
                args.author,
            )
            print(f"Made {count} replacement(s)")

        elif args.action == "insert":
            if not args.after:
                print("Error: --after is required for insert action", file=sys.stderr)
                sys.exit(1)
            if not args.text:
                print("Error: --text is required for insert action", file=sys.stderr)
                sys.exit(1)

            success = insert_text_after(
                args.folder,
                args.after,
                args.text,
                args.track_changes,
                args.author,
            )
            if success:
                print("Insertion successful")
            else:
                print("Text not found, no insertion made")

        elif args.action == "delete":
            if not args.find and not args.text:
                print(
                    "Error: --find or --text is required for delete action",
                    file=sys.stderr,
                )
                sys.exit(1)

            text_to_del = args.find or args.text
            count = delete_text(
                args.folder,
                text_to_del,
                args.track_changes,
                args.author,
            )
            print(f"Made {count} deletion(s)")

    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
