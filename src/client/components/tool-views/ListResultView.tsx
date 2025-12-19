// Formatted list files view for the thoughts section
// Groups files by directory with directory as heading and filenames below

import React from 'react';

interface ListResultViewProps {
    result: string;
}

type ParsedFile = {
    dir: string;
    filename: string;
    fullPath: string;
};

type DirGroup = {
    dir: string;
    displayDir: string;
    files: Array<{ filename: string; fullPath: string }>;
};

export function ListResultView({ result }: ListResultViewProps) {
    const lines = result.split('\n').filter(Boolean);

    // Parse list result line: "- /full/path/to/file"
    const parseFile = (line: string): ParsedFile | null => {
        // Match lines starting with "- " followed by a path
        const match = line.match(/^- (.+)$/);
        if (match && match[1]) {
            const fullPath = match[1];
            const lastSlash = fullPath.lastIndexOf('/');
            if (lastSlash >= 0) {
                const dir = fullPath.substring(0, lastSlash) || '/';
                const filename = fullPath.substring(lastSlash + 1);
                return { dir, filename, fullPath };
            }
            return { dir: '', filename: fullPath, fullPath };
        }
        return null;
    };

    // Group files by full directory path (not short name) using a Map
    const dirMap = new Map<string, Array<{ filename: string; fullPath: string }>>();
    let truncationMessage = '';

    for (const line of lines) {
        if (!line) continue;
        // Check for truncation message
        if (line.startsWith('...')) {
            truncationMessage = line;
            continue;
        }
        const parsed = parseFile(line);
        if (parsed) {
            // Use full dir path as key to keep different directories separate
            const existing = dirMap.get(parsed.dir);
            if (existing) {
                existing.push({ filename: parsed.filename, fullPath: parsed.fullPath });
            } else {
                dirMap.set(parsed.dir, [{ filename: parsed.filename, fullPath: parsed.fullPath }]);
            }
        }
    }

    // Get a short display name for directory
    const getShortDir = (dir: string): string => {
        const parts = dir.split('/').filter(Boolean);
        // Show last 2-3 parts of the path
        if (parts.length <= 2) return dir;
        return '.../' + parts.slice(-2).join('/');
    };

    // Convert to array and sort by directory name
    const dirGroups: DirGroup[] = Array.from(dirMap.entries())
        .map(([dir, files]) => ({ dir, displayDir: getShortDir(dir), files }))
        .sort((a, b) => a.dir.localeCompare(b.dir));

    // Calculate total files for truncation message
    const totalFiles = dirGroups.reduce((sum, g) => sum + g.files.length, 0);

    // Limit total files shown
    const maxTotalFiles = 15;
    let fileCount = 0;
    let truncated = false;

    return (
        <div className="thought-list">
            {dirGroups.map((group) => {
                if (fileCount >= maxTotalFiles) {
                    truncated = true;
                    return null;
                }

                const remainingFiles = maxTotalFiles - fileCount;
                const filesToShow = group.files.slice(0, remainingFiles);
                fileCount += filesToShow.length;

                if (filesToShow.length < group.files.length) {
                    truncated = true;
                }

                return (
                    <div key={group.dir} className="list-dir-group">
                        <div className="list-dir-header">{group.displayDir}</div>
                        {filesToShow.map((file, fileIdx) => (
                            <div key={fileIdx} className="list-file-item">
                                <span className="list-file-name">{file.filename}</span>
                            </div>
                        ))}
                    </div>
                );
            })}
            {(truncated || truncationMessage) && (
                <div className="list-result-truncated">
                    {truncationMessage || `... ${totalFiles - maxTotalFiles} more files`}
                </div>
            )}
        </div>
    );
}
