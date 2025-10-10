import { glob } from 'glob';
import path from 'path';

export interface GrepFilesArgs {
    regex_pattern: string;
    path_prefix?: string;
    lines_before?: number;
    lines_after?: number;
}

export interface GrepResult {
    query: string;
    file: string;
    uri: string;
    compiled: string;
}

/**
 * Search for a regex pattern in files with optional path prefix and context lines
 */
export async function grepFiles(args: GrepFilesArgs): Promise<GrepResult> {
    const { regex_pattern, path_prefix, lines_before = 0, lines_after = 0 } = args;
    const maxResults = 1000;

    try {
        // Compile the regex pattern
        let regex: RegExp;
        try {
            regex = new RegExp(regex_pattern);
        } catch (e) {
            return {
                query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after),
                file: path_prefix || '.',
                uri: path_prefix || '.',
                compiled: `Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`,
            };
        }

        // Determine search path and pattern
        const searchPath = path_prefix ? path.resolve(path_prefix) : process.cwd();
        const globPattern = path.join(searchPath, '**/*');

        // Find all files in the specified path
        const files = await glob(globPattern, {
            nodir: true,
            absolute: true,
        });

        if (files.length === 0) {
            return {
                query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after),
                file: path_prefix || '.',
                uri: path_prefix || '.',
                compiled: 'No files found in specified path.',
            };
        }

        // Search through files for matches
        const matches: string[] = [];
        let matchedFileCount = 0;

        for (const filePath of files) {
            if (matches.length >= maxResults) break;

            try {
                const file = Bun.file(filePath);
                const content = await file.text();
                const lines = content.split('\n');

                let fileHasMatch = false;

                for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                    // note: suffix '!' tells ts we know lines[i] is not undefined here
                    if (regex.test(lines[i]!)) {
                        if (!fileHasMatch) {
                            matchedFileCount++;
                            fileHasMatch = true;
                        }

                        // Add context lines before
                        const startIdx = Math.max(0, i - lines_before);
                        for (let j = startIdx; j < i; j++) {
                            matches.push(`${filePath}:${j + 1}-${lines[j]}`);
                        }

                        // Add the matched line
                        matches.push(`${filePath}:${i + 1}:${lines[i]}`);

                        // Add context lines after
                        const endIdx = Math.min(lines.length, i + lines_after + 1);
                        for (let j = i + 1; j < endIdx; j++) {
                            matches.push(`${filePath}:${j + 1}-${lines[j]}`);
                        }

                        // Add separator between matches if there are context lines
                        if (lines_before > 0 || lines_after > 0) {
                            matches.push('--');
                        }
                    }
                }
            } catch (error) {
                // Skip files that can't be read (binary files, permission errors, etc.)
                console.warn(`Skipping file ${filePath}: ${error}`);
                continue;
            }
        }

        if (matches.length === 0) {
            return {
                query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after),
                file: path_prefix || '.',
                uri: path_prefix || '.',
                compiled: 'No matches found.',
            };
        }

        // Truncate matches if too many
        let compiled = matches.join('\n');
        if (matches.length >= maxResults) {
            compiled += `\n\n... ${matches.length} results found (showing first ${maxResults}). Use stricter regex or path to narrow down results.`;
        }

        return {
            query: generateQuery(matches.length, matchedFileCount, path_prefix, regex_pattern, lines_before, lines_after, maxResults),
            file: path_prefix || '.',
            uri: path_prefix || '.',
            compiled,
        };
    } catch (error) {
        const errorMsg = `Error using grep files tool: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMsg, error);

        return {
            query: generateQuery(0, 0, path_prefix, regex_pattern, lines_before, lines_after),
            file: path_prefix || '.',
            uri: path_prefix || '.',
            compiled: errorMsg,
        };
    }
}

function generateQuery(
    lineCount: number,
    docCount: number,
    pathPrefix: string | undefined,
    pattern: string,
    linesBefore: number,
    linesAfter: number,
    maxResults: number = 1000
): string {
    let query = `**Found ${lineCount} matches for '${pattern}' in ${docCount} documents**`;
    if (pathPrefix) {
        query += ` in ${pathPrefix}`;
    }
    if (linesBefore || linesAfter || lineCount > maxResults) {
        query += ' Showing';
    }
    if (linesBefore || linesAfter) {
        const contextInfo: string[] = [];
        if (linesBefore) {
            contextInfo.push(`${linesBefore} lines before`);
        }
        if (linesAfter) {
            contextInfo.push(`${linesAfter} lines after`);
        }
        query += ` ${contextInfo.join(' and ')}`;
    }
    if (lineCount > maxResults) {
        if (linesBefore || linesAfter) {
            query += ' for';
        }
        query += ` first ${maxResults} results`;
    }
    return query;
}
