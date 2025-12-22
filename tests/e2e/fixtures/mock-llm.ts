/**
 * Mock LLM Response System
 *
 * Provides deterministic LLM responses for E2E testing.
 * Scenarios define what tool calls and responses the mock LLM returns.
 */

export interface MockToolCall {
    function_name: string;
    arguments: Record<string, unknown>;
    tool_call_id: string;
}

export interface MockToolResult {
    source_call_id: string;
    content: string;
}

export interface MockIteration {
    thought?: string;
    toolCalls: MockToolCall[];
    toolResults?: MockToolResult[];
}

export interface MockScenario {
    name: string;
    queryPattern: string; // Regex pattern to match user query
    iterations: MockIteration[];
    finalResponse: string;
    iterationDelayMs?: number; // Delay between iterations for testing async behavior
}

/**
 * Create a simple response scenario with no tool calls
 */
export function simpleResponse(pattern: string, response: string): MockScenario {
    return {
        name: 'simple-response',
        queryPattern: pattern,
        iterations: [],
        finalResponse: response,
    };
}

/**
 * Create a file listing scenario
 */
export function fileListingScenario(): MockScenario {
    return {
        name: 'file-listing',
        queryPattern: '.*list.*file.*|.*files.*',
        iterations: [
            {
                thought: 'I will list the files in the specified directory.',
                toolCalls: [
                    {
                        function_name: 'list_files',
                        arguments: { path: '.', pattern: '*' },
                        tool_call_id: 'tc-list-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-list-1',
                        content:
                            '- src/\n- tests/\n- package.json\n- tsconfig.json\n- README.md',
                    },
                ],
            },
        ],
        finalResponse:
            'I found 5 items in the directory: src/, tests/, package.json, tsconfig.json, and README.md.',
        iterationDelayMs: 100,
    };
}

/**
 * Create a multi-step analysis scenario (good for pause/resume testing)
 */
export function multiStepAnalysisScenario(steps: number = 3): MockScenario {
    const iterations: MockIteration[] = [];

    for (let i = 0; i < steps; i++) {
        iterations.push({
            thought: `Step ${i + 1}: Analyzing part ${i + 1} of the codebase...`,
            toolCalls: [
                {
                    function_name: 'grep_files',
                    arguments: { pattern: `pattern-${i + 1}`, path: 'src' },
                    tool_call_id: `tc-grep-${i + 1}`,
                },
            ],
            toolResults: [
                {
                    source_call_id: `tc-grep-${i + 1}`,
                    content: `Found ${(i + 1) * 3} matches for pattern-${i + 1} in src/`,
                },
            ],
        });
    }

    return {
        name: 'multi-step-analysis',
        queryPattern: '.*analyz.*|.*research.*|.*slow.*',
        iterations,
        finalResponse: `Analysis complete. Found patterns across ${steps} search iterations.`,
        iterationDelayMs: 500, // Slower to allow pause testing
    };
}

/**
 * Create a very slow scenario for reliable pause testing
 * Uses 10 iterations with 1s delay each = ~10s total
 * This gives plenty of time to interact with pause/resume
 */
export function slowPausableScenario(): MockScenario {
    const iterations: MockIteration[] = [];

    for (let i = 0; i < 10; i++) {
        iterations.push({
            thought: `Processing step ${i + 1} of 10...`,
            toolCalls: [
                {
                    function_name: 'list_files',
                    arguments: { path: `.`, pattern: `step-${i + 1}` },
                    tool_call_id: `tc-slow-${i + 1}`,
                },
            ],
            toolResults: [
                {
                    source_call_id: `tc-slow-${i + 1}`,
                    content: `Processed step ${i + 1}`,
                },
            ],
        });
    }

    return {
        name: 'slow-pausable',
        queryPattern: '.*pausable.*|.*very.*slow.*',
        iterations,
        finalResponse: 'Slow analysis completed successfully.',
        iterationDelayMs: 1000, // 1s x 10 iterations = 10s total
    };
}

/**
 * Create a quick scenario for fast tests
 */
export function quickScenario(): MockScenario {
    return {
        name: 'quick',
        queryPattern: '.*quick.*|.*fast.*|.*hello.*',
        iterations: [],
        finalResponse: 'Quick response completed!',
        iterationDelayMs: 0,
    };
}

/**
 * Create a simple response scenario with no tool calls
 * Used for testing simple conversations
 */
export function simpleResponseNoTools(): MockScenario {
    return {
        name: 'simple-no-tools',
        queryPattern: '.*you good.*|.*how are you.*|.*simple.*',
        iterations: [],
        finalResponse: "I'm doing great, thanks for asking!",
        iterationDelayMs: 0,
    };
}

/**
 * Create a shell command scenario that triggers bash_command with confirmation
 */
export function shellCommandScenario(): MockScenario {
    return {
        name: 'shell-command',
        queryPattern: '.*run.*command.*|.*shell.*|.*bash.*|.*execute.*',
        iterations: [
            {
                thought: 'I will run a shell command to list the files.',
                toolCalls: [
                    {
                        function_name: 'bash_command',
                        arguments: {
                            command: 'ls -la',
                            cwd: '.',
                            operation_type: 'read-only',
                        },
                        tool_call_id: 'tc-bash-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-bash-1',
                        content:
                            'total 24\ndrwxr-xr-x  5 user  staff  160 Jan  1 12:00 .\ndrwxr-xr-x  3 user  staff   96 Jan  1 12:00 ..\n-rw-r--r--  1 user  staff  100 Jan  1 12:00 file.txt',
                    },
                ],
            },
        ],
        finalResponse: 'The directory contains 3 items.',
        iterationDelayMs: 500,
    };
}

/**
 * Create a read-write shell command scenario that triggers confirmation with different risk level
 */
export function readWriteShellCommandScenario(): MockScenario {
    return {
        name: 'shell-command-readwrite',
        queryPattern: '.*write.*command.*|.*modify.*|.*delete.*',
        iterations: [
            {
                thought: 'I will modify the file as requested.',
                toolCalls: [
                    {
                        function_name: 'bash_command',
                        arguments: {
                            command: 'echo "new content" >> file.txt',
                            cwd: '.',
                            operation_type: 'read-write',
                        },
                        tool_call_id: 'tc-bash-rw-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-bash-rw-1',
                        content: 'File modified successfully.',
                    },
                ],
            },
        ],
        finalResponse: 'File has been updated.',
        iterationDelayMs: 500,
    };
}

/**
 * Create a write file scenario
 */
export function writeFileScenario(): MockScenario {
    return {
        name: 'write-file',
        queryPattern: '.*write.*file.*|.*create.*file.*|.*save.*',
        iterations: [
            {
                thought: 'I will write the content to a file.',
                toolCalls: [
                    {
                        function_name: 'write_file',
                        arguments: {
                            path: 'output.txt',
                            content: 'Hello, World!',
                        },
                        tool_call_id: 'tc-write-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-write-1',
                        content: 'File written successfully.',
                    },
                ],
            },
        ],
        finalResponse: 'The file has been created with the content.',
        iterationDelayMs: 200,
    };
}

/**
 * Create a read file scenario with thought interleaved
 */
export function readFileScenario(): MockScenario {
    return {
        name: 'read-file',
        queryPattern: '.*read.*file.*|.*view.*file.*|.*show.*content.*',
        iterations: [
            {
                thought: 'Let me first list the available files.',
                toolCalls: [
                    {
                        function_name: 'list_files',
                        arguments: { path: '.', pattern: '*' },
                        tool_call_id: 'tc-list-rf-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-list-rf-1',
                        content: '- src/\n- tests/\n- README.md',
                    },
                ],
            },
            {
                thought: 'Now I will read the README file.',
                toolCalls: [
                    {
                        function_name: 'read_file',
                        arguments: { path: 'README.md' },
                        tool_call_id: 'tc-read-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-read-1',
                        content: '# Project\n\nThis is a sample project.',
                    },
                ],
            },
        ],
        finalResponse: 'The README contains project documentation.',
        iterationDelayMs: 300,
    };
}

/**
 * Create a multi-tool scenario with different tool types (safe tools only - no confirmation required)
 * Uses list_files, read_file, and grep_files for expanded thoughts testing
 */
export function multiToolScenario(): MockScenario {
    return {
        name: 'multi-tool',
        queryPattern: '.*multi.*tool.*|.*comprehensive.*|.*all.*tools.*',
        iterations: [
            {
                thought: 'First, let me list the files.',
                toolCalls: [
                    {
                        function_name: 'list_files',
                        arguments: { path: '.', pattern: '*.ts' },
                        tool_call_id: 'tc-mt-list-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-mt-list-1',
                        content: '- index.ts\n- utils.ts\n- types.ts',
                    },
                ],
            },
            {
                thought: 'Now reading the main file.',
                toolCalls: [
                    {
                        function_name: 'read_file',
                        arguments: { path: 'index.ts' },
                        tool_call_id: 'tc-mt-read-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-mt-read-1',
                        content: 'export const main = () => console.log("Hello");',
                    },
                ],
            },
            {
                thought: 'Let me search for patterns in the code.',
                toolCalls: [
                    {
                        function_name: 'grep_files',
                        arguments: {
                            pattern: 'export',
                            path: '.',
                        },
                        tool_call_id: 'tc-mt-grep-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-mt-grep-1',
                        content: 'Found 3 matches in 2 files.',
                    },
                ],
            },
            {
                thought: 'Finally, reading another file for more context.',
                toolCalls: [
                    {
                        function_name: 'read_file',
                        arguments: {
                            path: 'utils.ts',
                        },
                        tool_call_id: 'tc-mt-read-2',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-mt-read-2',
                        content: 'export function helper() { return true; }',
                    },
                ],
            },
        ],
        finalResponse:
            'Complete analysis done using list, read, and grep operations.',
        iterationDelayMs: 400,
    };
}

/**
 * Default scenarios used in tests
 */
export const defaultMockScenarios: MockScenario[] = [
    // Catch-all simple response (lowest priority - checked last)
    simpleResponse('.*', 'This is a mock response for testing.'),
    // Specific scenarios (checked first due to more specific patterns)
    fileListingScenario(),
    multiStepAnalysisScenario(3),
    slowPausableScenario(),
    quickScenario(),
    simpleResponseNoTools(),
    shellCommandScenario(),
    readWriteShellCommandScenario(),
    writeFileScenario(),
    readFileScenario(),
    multiToolScenario(),
];

/**
 * Find matching scenario for a query
 */
export function findMatchingScenario(
    query: string,
    scenarios: MockScenario[]
): MockScenario | undefined {
    // Check scenarios in order (more specific first, catch-all last)
    // Reverse order so specific patterns are checked before catch-all
    for (let i = scenarios.length - 1; i >= 0; i--) {
        const scenario = scenarios[i];
        if (!scenario) continue;
        const regex = new RegExp(scenario.queryPattern, 'i');
        if (regex.test(query)) {
            return scenario;
        }
    }
    return undefined;
}
