// Diff computation utilities for comparing text

export type DiffLine = {
    type: 'context' | 'removed' | 'added';
    content: string;
};

/**
 * Compute unified diff lines from old and new text
 * Returns lines with type: 'context' | 'removed' | 'added'
 */
export function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const result: DiffLine[] = [];

    // Simple LCS-based diff
    const lcs = computeLCS(oldLines, newLines);

    let oldIdx = 0;
    let newIdx = 0;
    let lcsIdx = 0;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
        const oldLine = oldLines[oldIdx];
        const newLine = newLines[newIdx];
        const lcsLine = lcs[lcsIdx];

        if (lcsIdx < lcs.length && oldIdx < oldLines.length && oldLine === lcsLine) {
            // This line is in both - check if new also matches
            if (newIdx < newLines.length && newLine === lcsLine) {
                result.push({ type: 'context', content: oldLine ?? '' });
                oldIdx++;
                newIdx++;
                lcsIdx++;
            } else if (newLine !== undefined) {
                // New has different line before matching LCS
                result.push({ type: 'added', content: newLine });
                newIdx++;
            }
        } else if (oldIdx < oldLines.length && oldLine !== undefined && (lcsIdx >= lcs.length || oldLine !== lcsLine)) {
            // Old line not in LCS - it was removed
            result.push({ type: 'removed', content: oldLine });
            oldIdx++;
        } else if (newIdx < newLines.length && newLine !== undefined) {
            // New line not yet processed
            result.push({ type: 'added', content: newLine });
            newIdx++;
        } else {
            // Safety break to prevent infinite loop
            break;
        }
    }

    return result;
}

/**
 * Compute Longest Common Subsequence of two string arrays
 */
export function computeLCS(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
        const row: number[] = [];
        for (let j = 0; j <= n; j++) {
            row[j] = 0;
        }
        dp[i] = row;
    }

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const aVal = a[i - 1];
            const bVal = b[j - 1];
            const prevDiag = dp[i - 1]?.[j - 1] ?? 0;
            const prevUp = dp[i - 1]?.[j] ?? 0;
            const prevLeft = dp[i]?.[j - 1] ?? 0;

            if (aVal === bVal) {
                dp[i][j] = prevDiag + 1;
            } else {
                dp[i][j] = Math.max(prevUp, prevLeft);
            }
        }
    }

    // Backtrack to find LCS
    const lcs: string[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
        const aVal = a[i - 1];
        const bVal = b[j - 1];
        const prevUp = dp[i - 1]?.[j] ?? 0;
        const prevLeft = dp[i]?.[j - 1] ?? 0;

        if (aVal === bVal && aVal !== undefined) {
            lcs.unshift(aVal);
            i--;
            j--;
        } else if (prevUp > prevLeft) {
            i--;
        } else {
            j--;
        }
    }

    return lcs;
}
