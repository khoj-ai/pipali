import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import type { Dirent } from 'fs';
import { isCaseInsensitiveFS } from '../../utils';

async function resolveCaseInsensitivePath(absolutePath: string): Promise<string | null> {
    // Cross-platform resolver for absolute paths (Windows/macOS/Linux).
    // If a path exists but its casing differs (common on case-insensitive FS),
    // this reconstructs the path using directory entries to recover real casing.
    if (!path.isAbsolute(absolutePath)) return null;

    const normalized = path.normalize(absolutePath);
    const parsed = path.parse(normalized);
    let currentDir = parsed.root;

    // Compute the path components *after* the root (drive letter or '/' or UNC share).
    const remainder = normalized.slice(parsed.root.length);
    const parts = remainder.split(path.sep).filter(Boolean);

    for (const part of parts) {
        let entries: string[];
        try {
            entries = await fs.readdir(currentDir);
        } catch {
            return null;
        }

        // Prefer exact match first to avoid changing casing when not needed.
        let match = entries.find(e => e === part);
        if (!match && isCaseInsensitiveFS) {
            // Only try case-insensitive matching on case-insensitive filesystems
            const partLower = part.toLowerCase();
            match = entries.find(e => e.toLowerCase() === partLower);
        }
        if (!match) return null;

        currentDir = path.join(currentDir, match);
    }

    return currentDir;
}

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

/** Opaque app bundles that trigger their own TCC category (e.g., Photos, Media Library access). */
const TCC_PROTECTED_EXTENSIONS = new Set([
    '.photoslibrary',
    '.photolibrary',
    '.musiclibrary',
    '.tvlibrary',
    '.imovielibrary',
]);

function shouldExcludeEntry(
    entryName: string,
    opts: { includeHidden: boolean; excludedDirNames: Set<string> }
): boolean {
    if (!opts.includeHidden && entryName.startsWith('.')) return true;
    if (opts.excludedDirNames.has(entryName)) return true;
    // Skip opaque app bundles that trigger their own TCC prompts (e.g., Photos Library)
    if (process.platform === 'darwin') {
        const ext = path.extname(entryName).toLowerCase();
        if (TCC_PROTECTED_EXTENSIONS.has(ext)) return true;
    }
    return false;
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
    let resolvedRoot = path.resolve(rootDir);

    // If the provided root exists but has incorrect casing (only on case-insensitive FS like macOS/Windows),
    // normalize it to on-disk casing so returned paths are case-correct.
    const caseResolvedRoot = await resolveCaseInsensitivePath(resolvedRoot);
    if (caseResolvedRoot) {
        resolvedRoot = caseResolvedRoot;
    }

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

// --- mdfind utilities (macOS Spotlight) ---

/** Cached mdfind availability check (null = not checked yet) */
let mdfindPath: string | false | null = null;

function getMdfindPath(): string | false {
    if (mdfindPath === null) {
        mdfindPath = process.platform === 'darwin' ? (Bun.which('mdfind') || false) : false;
    }
    return mdfindPath;
}

/**
 * True if the search path is "broad" — home dir or one level deep from home.
 * Used to gate warnings for slow `find` commands in shell_command.
 */
function isBroadSearch(resolvedPath: string): boolean {
    const home = os.homedir();
    if (resolvedPath === home) return true;
    const parent = path.dirname(resolvedPath);
    return parent === home;
}

/**
 * True if the glob pattern can be translated to an mdfind query.
 * Rejects character classes like [a-z] which mdfind doesn't support.
 * Accepts **\/ prefixed patterns since mdfind is inherently recursive.
 */
function canTranslateToMdfind(pattern?: string): boolean {
    if (!pattern) return true;
    if (/\[.+\]/.test(pattern)) return false;
    const stripped = stripRecursivePrefix(pattern);
    if (stripped.includes('/')) return false;
    return true;
}

/**
 * Strip leading **\/ from a glob pattern. mdfind searches recursively
 * by default, so **\/*.ts is equivalent to *.ts for mdfind.
 */
function stripRecursivePrefix(pattern: string): string {
    return pattern.replace(/^\*\*\//, '');
}

/**
 * Expand simple brace patterns like "*.{ts,js}" into ["*.ts", "*.js"].
 * Only handles a single brace group — no nesting.
 */
function expandBraces(pattern: string): string[] {
    const match = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (!match?.[2]) return [pattern];
    const prefix = match[1] ?? '';
    const alternatives = match[2];
    const suffix = match[3] ?? '';
    return alternatives.split(',').map(alt => `${prefix}${alt.trim()}${suffix}`);
}

/**
 * Extract a literal substring from a regex pattern for use as an mdfind
 * content pre-filter. Returns null if the pattern is too complex to extract
 * a useful literal (e.g., pure wildcards or alternations).
 */
function extractLiteralFromRegex(pattern: string): string | null {
    // Strip common regex anchors/assertions
    let s = pattern.replace(/^\^|\$$/g, '');
    // Strip word boundaries
    s = s.replace(/\\b/g, '');
    // If what remains is purely literal (no special regex chars), use it
    if (/^[a-zA-Z0-9_ .\-/]+$/.test(s) && s.length >= 2) {
        return s;
    }
    return null;
}

/**
 * Build mdfind command arguments for a given pattern and search path.
 * @param pattern - Glob pattern for file name filtering (from `include`)
 * @param searchPath - Directory to search in
 * @param contentFilter - Literal string for content pre-filtering (from grep regex)
 */
function buildMdfindArgs(pattern: string | undefined, searchPath: string, contentFilter?: string): string[] {
    const predicates: string[] = [];

    if (pattern) {
        const normalized = stripRecursivePrefix(pattern);
        const hasGlobChars = normalized.includes('*') || normalized.includes('?');

        if (!hasGlobChars && !contentFilter) {
            // Simple name substring match, no content filter — use -name shorthand
            return ['-name', normalized, '-onlyin', searchPath];
        }

        if (hasGlobChars) {
            const expanded = expandBraces(normalized);
            const namePredicates = expanded.map(p => `kMDItemFSName == '${p}'`);
            predicates.push(namePredicates.length === 1 ? namePredicates[0]! : `(${namePredicates.join(' || ')})`);
        } else {
            predicates.push(`kMDItemFSName == '*${normalized}*'`);
        }
    }

    if (contentFilter) {
        // Escape single quotes in the literal for the mdfind query
        const escaped = contentFilter.replace(/'/g, "\\'");
        predicates.push(`kMDItemTextContent == '${escaped}'`);
    }

    if (predicates.length === 0) {
        return ['-onlyin', searchPath, 'kMDItemContentTypeTree == "public.data"'];
    }

    return ['-onlyin', searchPath, predicates.join(' && ')];
}

/**
 * Check if an mdfind result path should be excluded based on hidden/excluded dirs.
 */
function shouldExcludeMdfindResult(
    filePath: string,
    rootDir: string,
    excludedDirs: Set<string>,
    includeHidden: boolean,
): boolean {
    const relative = path.relative(rootDir, filePath);
    const segments = relative.split(path.sep);

    for (const seg of segments) {
        if (!includeHidden && seg.startsWith('.')) return true;
        if (excludedDirs.has(seg)) return true;
        if (process.platform === 'darwin') {
            const ext = path.extname(seg).toLowerCase();
            if (TCC_PROTECTED_EXTENSIONS.has(ext)) return true;
        }
    }
    return false;
}

/**
 * Run mdfind and return matching file paths, filtered by exclusions.
 * Returns null if mdfind is unavailable or the pattern can't be translated.
 */
async function runMdfind(params: {
    searchPath: string;
    pattern?: string;
    /** Literal string for content pre-filtering (from grep regex pattern) */
    contentFilter?: string;
    includeHidden: boolean;
    includeAppFolders: boolean;
    timeoutMs: number;
    /** Max file paths to return after filtering. Caps downstream work. */
    maxFiles?: number;
}): Promise<string[] | null> {
    const mdfind = getMdfindPath();
    if (!mdfind) return null;
    if (!canTranslateToMdfind(params.pattern)) return null;

    const args = buildMdfindArgs(params.pattern, params.searchPath, params.contentFilter);
    const excludedDirs = getExcludedDirNamesForRootDir(params.searchPath, { includeAppFolders: params.includeAppFolders });
    const maxFiles = params.maxFiles ?? Infinity;

    try {
        const proc = Bun.spawn([mdfind, ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: params.timeoutMs,
        });

        // Stream stdout line-by-line to stop early instead of buffering all output
        const result: string[] = [];
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let partial = '';

        try {
            while (result.length < maxFiles) {
                const { done, value } = await reader.read();
                if (done) break;

                partial += decoder.decode(value, { stream: true });
                const lines = partial.split('\n');
                partial = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line) continue;
                    if (result.length >= maxFiles) break;
                    if (!shouldExcludeMdfindResult(line, params.searchPath, excludedDirs, params.includeHidden)) {
                        result.push(line);
                    }
                }
            }
        } finally {
            reader.releaseLock();
            proc.kill();
            await proc.exited.catch(() => {});
        }

        if (partial && result.length < maxFiles &&
            !shouldExcludeMdfindResult(partial, params.searchPath, excludedDirs, params.includeHidden)) {
            result.push(partial);
        }

        return result.length > 0 ? result : null;
    } catch {
        return null;
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
    resolveCaseInsensitivePath,
    getMdfindPath,
    isBroadSearch,
    canTranslateToMdfind,
    stripRecursivePrefix,
    expandBraces,
    buildMdfindArgs,
    shouldExcludeMdfindResult,
    extractLiteralFromRegex,
    runMdfind,
    TCC_PROTECTED_EXTENSIONS,
};