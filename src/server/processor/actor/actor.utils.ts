import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import type { Dirent } from 'fs';

/**
 * Resolve a path relative to user's home directory.
 * - "~" or "~/foo" expands to home directory
 * - Relative paths like "Downloads" resolve from home directory
 * - Absolute paths are used as-is
 */
function resolvePath(inputPath: string): string {
    const home = os.homedir();

    if (inputPath === '~' || inputPath === '') {
        return home;
    }

    if (inputPath.startsWith('~/')) {
        return path.join(home, inputPath.slice(2));
    }

    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }

    // Relative paths resolve from home directory
    return path.join(home, inputPath);
}

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

function getDefaultExcludedDirNames(): Set<string> {
    return new Set([
        '.git',
        'node_modules',
        'dist',
        'build',
        '.next',
        '.turbo',
        '.cache',
        '__pycache__',
        '.pytest_cache',
        '.mypy_cache',
        '.venv',
        'venv',
        'target',
        '.idea',
        '.DS_Store',
    ]);
}

function getHomeMacExcludedDirNames(): Set<string> {
    // macOS home directory “application-ish” folders that are huge/permission-heavy.
    return new Set([
        'Library',
        '.Trash',
        '.Trash-1000',
        '.cache',
        'Caches',
    ]);
}

function shouldExcludeEntry(
    entryName: string,
    opts: { includeHidden: boolean; excludedDirNames: Set<string> }
): boolean {
    if (!opts.includeHidden && entryName.startsWith('.')) return true;
    return opts.excludedDirNames.has(entryName);
}

function getExcludedDirNamesForRootDir(rootDir: string, opts: { includeAppFolders: boolean }): Set<string> {
    const excluded = getDefaultExcludedDirNames();
    const home = os.homedir();
    const resolvedRoot = path.resolve(rootDir);
    if (!opts.includeAppFolders && resolvedRoot === path.resolve(home)) {
        for (const dir of getHomeMacExcludedDirNames()) excluded.add(dir);
    }
    return excluded;
}

async function* walkFilePaths(
    rootDir: string,
    opts: {
        includeHidden: boolean;
        includeAppFolders: boolean;
        followSymlinks: boolean;
    }
): AsyncGenerator<string> {
    const excluded = getExcludedDirNamesForRootDir(rootDir, { includeAppFolders: opts.includeAppFolders });
    const resolvedRoot = path.resolve(rootDir);

    // If the root itself is a file, yield it directly.
    try {
        const rootStat = await fs.lstat(resolvedRoot);
        if (rootStat.isFile()) {
            yield resolvedRoot;
            return;
        }
        if (rootStat.isSymbolicLink() && opts.followSymlinks) {
            try {
                const stat = await fs.stat(resolvedRoot);
                if (stat.isFile()) {
                    yield resolvedRoot;
                    return;
                }
            } catch {
                // ignore
            }
        }
    } catch {
        // ignore
    }

    const stack: string[] = [resolvedRoot];
    while (stack.length > 0) {
        const dir = stack.pop();
        if (!dir) continue;

        let entries: Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const name = entry.name;
            if (shouldExcludeEntry(name, { includeHidden: opts.includeHidden, excludedDirNames: excluded })) {
                continue;
            }

            const fullPath = path.join(dir, name);

            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (entry.isSymbolicLink()) {
                if (!opts.followSymlinks) continue;
                try {
                    const stat = await fs.stat(fullPath);
                    if (stat.isDirectory()) {
                        stack.push(fullPath);
                    } else if (stat.isFile()) {
                        yield fullPath;
                    }
                } catch {
                    continue;
                }
                continue;
            }

            if (entry.isFile()) {
                yield fullPath;
            }
        }
    }
}

export {
    resolvePath,
    clampInt,
    getDefaultExcludedDirNames,
    getHomeMacExcludedDirNames,
    shouldExcludeEntry,
    getExcludedDirNamesForRootDir,
    walkFilePaths,
};