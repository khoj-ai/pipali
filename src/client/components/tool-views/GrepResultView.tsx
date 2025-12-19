// Formatted grep results view for the thoughts section
// Groups results by file with filename as heading and line numbers in gutter

import React from 'react';

interface GrepResultViewProps {
    result: string;
}

type ParsedLine = {
    filename: string;
    lineNum: string;
    text: string;
    isMatch: boolean;
};

type FileGroup = {
    filename: string;
    lines: Array<{ lineNum: string; text: string; isMatch: boolean }>;
};

export function GrepResultView({ result }: GrepResultViewProps) {
    const lines = result.split('\n').filter(Boolean);

    // Parse grep result line: /full/path/to/file:linenum:matched text (or -text for context)
    const parseLine = (line: string): ParsedLine | null => {
        const match = line.match(/^(.+?):(\d+)([:|-])(.*)$/);
        if (match && match[1] && match[2] && match[3] && match[4] !== undefined) {
            const fullPath = match[1];
            const lineNum = match[2];
            const separator = match[3];
            const text = match[4];
            const filename = fullPath.split('/').pop() || fullPath;
            const isMatch = separator === ':';
            return { filename, lineNum, text, isMatch };
        }
        return null;
    };

    // Group lines by filename
    const fileGroups: FileGroup[] = [];
    let currentGroup: FileGroup | null = null;

    for (const line of lines) {
        if (!line || line === '--') continue;
        const parsed = parseLine(line);
        if (parsed) {
            if (!currentGroup || currentGroup.filename !== parsed.filename) {
                currentGroup = { filename: parsed.filename, lines: [] };
                fileGroups.push(currentGroup);
            }
            currentGroup.lines.push({ lineNum: parsed.lineNum, text: parsed.text, isMatch: parsed.isMatch });
        }
    }

    // Calculate total lines for truncation message
    const totalLines = fileGroups.reduce((sum, g) => sum + g.lines.length, 0);
    const maxTotalLines = 12;
    let lineCount = 0;
    let truncated = false;

    return (
        <div className="thought-grep">
            {fileGroups.map((group, groupIdx) => {
                if (lineCount >= maxTotalLines) {
                    truncated = true;
                    return null;
                }

                const remainingLines = maxTotalLines - lineCount;
                const linesToShow = group.lines.slice(0, remainingLines);
                lineCount += linesToShow.length;

                if (linesToShow.length < group.lines.length) {
                    truncated = true;
                }

                return (
                    <div key={groupIdx} className="grep-file-group">
                        <div className="grep-file-header">{group.filename}</div>
                        {linesToShow.map((line, lineIdx) => (
                            <div key={lineIdx} className={`grep-result-line ${line.isMatch ? 'match' : 'context'}`}>
                                <span className="grep-line-num">{line.lineNum}</span>
                                <span className="grep-text">{line.text}</span>
                            </div>
                        ))}
                    </div>
                );
            })}
            {truncated && (
                <div className="grep-result-truncated">
                    ... {totalLines - maxTotalLines} more matches
                </div>
            )}
        </div>
    );
}
