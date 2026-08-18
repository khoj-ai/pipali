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
    // Async delay before the final response resolves. Unlike iterationDelayMs's
    // sync sleep, it yields the event loop so a mid-response soft interrupt lands.
    finalResponseDelayMs?: number;
    // Answer for a turn that starts on this scenario after it already finished - a
    // conversation woken by an inbox update. Without it the mock replays the scenario
    // from its first tool call, since a woken turn carries the same user message.
    resumedResponse?: string;
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
 * Slow no-tool final response: leaves a window to soft-interrupt mid-answer,
 * to verify the answer is persisted rather than discarded.
 */
export function interruptDuringFinalResponseScenario(): MockScenario {
    return {
        name: 'interrupt-during-final-response',
        queryPattern: '^answer then interrupt$',
        iterations: [],
        finalResponse: 'Final answer that must survive the interrupt.',
        finalResponseDelayMs: 2000,
    };
}

export function scrollBehaviorSetupScenario(): MockScenario {
    return {
        name: 'scroll-behavior-setup',
        queryPattern: '^scroll behavior setup$',
        iterations: [],
        finalResponse: Array.from({ length: 50 }, (_, i) =>
            `Setup paragraph ${i + 1}: this response is intentionally long so the next user turn starts after a tall assistant message.`
        ).join('\n\n'),
        iterationDelayMs: 0,
    };
}

export function scrollBehaviorFollowupScenario(): MockScenario {
    return {
        name: 'scroll-behavior-followup',
        queryPattern: '^scroll behavior follow up$',
        iterations: [],
        finalResponse: Array.from({ length: 24 }, (_, i) =>
            `Follow-up paragraph ${i + 1}: this response is long enough to create real scroll space below the follow-up user message.`
        ).join('\n\n'),
        iterationDelayMs: 0,
    };
}

export function liveOutlineScrollScenario(): MockScenario {
    const iterations: MockIteration[] = Array.from({ length: 10 }, (_, i) => ({
        thought: `Live outline step ${i + 1} of 10...`,
        toolCalls: [
            {
                function_name: 'list_files',
                arguments: { path: '.', pattern: `outline-step-${i + 1}` },
                tool_call_id: `tc-outline-${i + 1}`,
            },
        ],
        toolResults: [
            {
                source_call_id: `tc-outline-${i + 1}`,
                content: `Completed outline step ${i + 1}`,
            },
        ],
    }));

    return {
        name: 'live-outline-scroll',
        queryPattern: '^live outline scroll$',
        iterations,
        finalResponse: 'Live outline scroll complete.',
        finalResponseDelayMs: 5000,
    };
}

/**
 * Create a shell command scenario that triggers shell_command with confirmation
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
                        function_name: 'shell_command',
                        arguments: {
                            justification: 'User requested to list files in the directory',
                            command: 'ls -la',
                            cwd: '.',
                            operation_type: 'read-only',
                        },
                        tool_call_id: 'tc-shell-1',
                    },
                ],
                // Note: toolResults are for documentation only - actual tools are executed
                toolResults: [
                    {
                        source_call_id: 'tc-shell-1',
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
                        function_name: 'shell_command',
                        arguments: {
                            justification: 'User requested to modify the file contents',
                            command: 'echo "new content" >> file.txt',
                            cwd: '.',
                            operation_type: 'read-write',
                        },
                        tool_call_id: 'tc-shell-rw-1',
                    },
                ],
                // Note: toolResults are for documentation only - actual tools are executed
                toolResults: [
                    {
                        source_call_id: 'tc-shell-rw-1',
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
 * Repro scenario for pub-sub reload dedupe issues
 * - Starts with a confirmation-gated tool call (shell_command)
 * - Continues with multiple tool steps so a reload mid-run can cause duplicates if replay isn't deduped
 */
export function pubSubReloadReproScenario(): MockScenario {
    return {
        name: 'pubsub-reload-repro',
        // Keep this pattern extremely specific so it never matches other tests
        queryPattern: '^repro pubsub reload(\\s+.+)?$',
        iterations: [
            {
                thought: 'Step 1: Request permission to run a read-only command.',
                toolCalls: [
                    {
                        function_name: 'shell_command',
                        arguments: {
                            justification: 'E2E repro: repro-shell-1',
                            command: "printf 'repro-shell-1'",
                            cwd: '.',
                            operation_type: 'read-only',
                        },
                        tool_call_id: 'tc-repro-shell-1',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-repro-shell-1',
                        content: 'repro-shell-1',
                    },
                ],
            },
            {
                thought: 'Step 2: Search for a unique marker in src.',
                toolCalls: [
                    {
                        function_name: 'grep_files',
                        arguments: { pattern: 'repro-pattern-2', path: 'src' },
                        tool_call_id: 'tc-repro-grep-2',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-repro-grep-2',
                        content: 'Found 0 matches for repro-pattern-2',
                    },
                ],
            },
            {
                thought: 'Step 3: Search for another unique marker in src.',
                toolCalls: [
                    {
                        function_name: 'grep_files',
                        arguments: { pattern: 'repro-pattern-3', path: 'src' },
                        tool_call_id: 'tc-repro-grep-3',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-repro-grep-3',
                        content: 'Found 0 matches for repro-pattern-3',
                    },
                ],
            },
            {
                thought: 'Step 4: List files with a unique pattern marker.',
                toolCalls: [
                    {
                        function_name: 'list_files',
                        arguments: { path: '.', pattern: 'repro-list-4' },
                        tool_call_id: 'tc-repro-list-4',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-repro-list-4',
                        content: 'Repro list completed',
                    },
                ],
            },
            {
                thought: 'Step 5: Final unique search marker in src.',
                toolCalls: [
                    {
                        function_name: 'grep_files',
                        arguments: { pattern: 'repro-pattern-5', path: 'src' },
                        tool_call_id: 'tc-repro-grep-5',
                    },
                ],
                toolResults: [
                    {
                        source_call_id: 'tc-repro-grep-5',
                        content: 'Found 0 matches for repro-pattern-5',
                    },
                ],
            },
        ],
        finalResponse: 'Repro run complete.',
        iterationDelayMs: 1000,
    };
}

/**
 * Hands work to a separate conversation via delegate_task.
 *
 * The mock supplies only the tool call, so the real tool runs and a real delegated
 * conversation is created. The delegated brief deliberately matches nothing but the
 * catch-all, so the child finishes immediately.
 */
export function delegationScenario(): MockScenario {
    return {
        name: 'delegation',
        queryPattern: '^delegate a task',
        iterations: [
            {
                thought: 'This is self-contained, so I will hand it off and stay responsive.',
                toolCalls: [
                    {
                        function_name: 'delegate_task',
                        arguments: {
                            title: 'Delegated task',
                            message: 'Handle the sub-task and report back what you found.',
                        },
                        tool_call_id: 'tc-delegate-1',
                    },
                ],
            },
        ],
        finalResponse: 'I started that in the background and will report back.',
    };
}

/**
 * Delegates work that keeps running, and holds its own final response open, so a test
 * can act while both the parent and the delegated task are in flight.
 */
export function slowDelegationScenario(): MockScenario {
    return {
        name: 'slow-delegation',
        queryPattern: '^delegate a slow task',
        iterations: [
            {
                thought: 'Handing off a long-running piece of work.',
                toolCalls: [
                    {
                        function_name: 'delegate_task',
                        arguments: {
                            title: 'Slow delegated task',
                            // Long enough to still be running when the test presses stop,
                            // short enough not to outlive the spec's cleanup.
                            message: 'delegated slow work',
                        },
                        tool_call_id: 'tc-delegate-slow-1',
                    },
                ],
            },
        ],
        finalResponse: 'The long task is under way.',
        finalResponseDelayMs: 8000,
    };
}

/**
 * Starts two tasks at once, then waits on both together - the reason wait_for_tasks
 * exists once run_in_background covers the single-task case.
 */
export function delegateTwoAndWaitScenario(): MockScenario {
    return {
        name: 'delegate-two-and-wait',
        queryPattern: '^delegate two and wait',
        iterations: [
            {
                thought: 'These are independent, so I will run them at the same time.',
                toolCalls: [
                    {
                        function_name: 'delegate_task',
                        arguments: { title: 'First parallel task', message: 'delegated slow work' },
                        tool_call_id: 'tc-delegate-two-1',
                    },
                    {
                        function_name: 'delegate_task',
                        arguments: { title: 'Second parallel task', message: 'delegated slow work' },
                        tool_call_id: 'tc-delegate-two-2',
                    },
                ],
            },
            {
                thought: 'Both are running; waiting for them together.',
                toolCalls: [
                    {
                        function_name: 'wait_for_tasks',
                        // Preload fills in the ids the delegate calls returned.
                        arguments: { conversation_ids: ['__DELEGATED_IDS__'], timeout_seconds: 60 },
                        tool_call_id: 'tc-wait-two-1',
                    },
                ],
            },
        ],
        finalResponse: 'Both parallel tasks finished.',
    };
}

/**
 * Delegates work it needs the answer to, in a single call. run_in_background: false
 * holds the turn open and hands the result straight back.
 */
export function delegateAndWaitScenario(): MockScenario {
    return {
        name: 'delegate-and-wait',
        queryPattern: '^delegate and wait',
        iterations: [
            {
                thought: 'I need this answer before I can reply, so I will wait on it.',
                toolCalls: [
                    {
                        function_name: 'delegate_task',
                        arguments: {
                            title: 'Awaited task',
                            message: 'delegated slow work',
                            run_in_background: false,
                            timeout_seconds: 60,
                        },
                        tool_call_id: 'tc-delegate-wait-1',
                    },
                ],
            },
        ],
        finalResponse: 'The delegated task finished and I waited for it.',
    };
}

/** Work that runs for a few seconds, used as the body of a delegated task. */
export function delegatedSlowWorkScenario(): MockScenario {
    return {
        name: 'delegated-slow-work',
        queryPattern: '^delegated slow work',
        iterations: Array.from({ length: 3 }, (_, i) => ({
            thought: `Working through part ${i + 1}.`,
            toolCalls: [
                {
                    function_name: 'list_files',
                    arguments: { path: '.', pattern: '*' },
                    tool_call_id: `tc-delegated-work-${i + 1}`,
                },
            ],
        })),
        finalResponse: 'The delegated work is done.',
        iterationDelayMs: 1000,
    };
}

/**
 * Starts a command that outlives the tool call. The mock supplies only the tool call,
 * so a real process is spawned and reports its own exit back to the conversation.
 */
export function backgroundCommandScenario(): MockScenario {
    return {
        name: 'background-command',
        queryPattern: '^run something in the background',
        iterations: [
            {
                thought: 'This takes a while, so I will start it and stay responsive.',
                toolCalls: [
                    {
                        function_name: 'shell_command',
                        arguments: {
                            justification: 'Start the long job',
                            command: 'echo started-in-background; sleep 2; echo done-in-background',
                            operation_type: 'read-only',
                            run_in_background: true,
                        },
                        tool_call_id: 'tc-background-1',
                    },
                ],
            },
        ],
        finalResponse: 'That is running in the background now.',
    };
}

/** A backgrounded command whose exit is meant to land at a particular moment. */
function backgroundCommandIteration(command: string, toolCallId: string, thought: string): MockIteration {
    return {
        thought,
        toolCalls: [
            {
                function_name: 'shell_command',
                arguments: {
                    justification: 'Start the job',
                    command,
                    operation_type: 'read-only',
                    run_in_background: true,
                },
                tool_call_id: toolCallId,
            },
        ],
    };
}

/**
 * The command exits while the turn is still working, so the update it reports has to
 * reach the run in flight rather than wait for a run of its own.
 */
export function backgroundUpdateMidRunScenario(): MockScenario {
    return {
        name: 'background-update-mid-run',
        queryPattern: '^report the background command while working$',
        iterations: [
            backgroundCommandIteration(
                'echo mid-run-marker',
                'tc-bg-mid-run-1',
                'Starting the quick job, then carrying on.',
            ),
            // Steps for the update to arrive during, and iteration boundaries for it to
            // be picked up at.
            ...Array.from({ length: 3 }, (_, i) => ({
                thought: `Carrying on with part ${i + 1} while it runs.`,
                toolCalls: [
                    {
                        function_name: 'list_files',
                        arguments: { path: '.', pattern: `mid-run-${i + 1}` },
                        tool_call_id: `tc-bg-mid-run-list-${i + 1}`,
                    },
                ],
            })),
        ],
        finalResponse: 'The background command finished while I was still working.',
        iterationDelayMs: 300,
        // Only reached if the run missed the update and had to be woken - which is the
        // failure this scenario is about, so it must not start the command again.
        resumedResponse: 'I had to be woken to report the background command.',
    };
}

/**
 * The command exits while the final answer is being produced - past the last point the
 * run could pick it up, so the conversation is woken with no user message of its own.
 */
export function backgroundUpdateDuringFinalResponseScenario(): MockScenario {
    return {
        name: 'background-update-during-final-response',
        queryPattern: '^report the background command after answering$',
        iterations: [
            backgroundCommandIteration(
                'sleep 2; echo late-marker',
                'tc-bg-late-1',
                'Starting the job and answering while it runs.',
            ),
        ],
        finalResponse: 'Started it, I will report back.',
        // Held open long enough for the command to exit mid-answer.
        finalResponseDelayMs: 5000,
        resumedResponse: 'The background command finished while I was answering.',
    };
}

/**
 * Delegates work and then changes its mind, all within one turn. The stopped task
 * reports that it did not finish, which is the outcome that was asked for.
 */
export function delegateAndStopScenario(): MockScenario {
    return {
        name: 'delegate-and-stop',
        queryPattern: '^delegate and stop',
        iterations: [
            {
                thought: 'Handing this off.',
                toolCalls: [
                    {
                        function_name: 'delegate_task',
                        arguments: { title: 'Abandoned task', message: 'delegated slow work' },
                        tool_call_id: 'tc-delegate-stop-1',
                    },
                ],
            },
            {
                thought: 'On reflection that is not needed, so I will stop it.',
                toolCalls: [
                    {
                        function_name: 'stop_task',
                        // Preload fills in the id the delegate call returned.
                        arguments: { conversation_id: '__DELEGATED_IDS__' },
                        tool_call_id: 'tc-delegate-stop-2',
                    },
                ],
            },
        ],
        finalResponse: 'I started that task and then stopped it again.',
    };
}

/**
 * Starts a long command and then changes its mind, all within one turn - the case where
 * the stop's own exit event could push the conversation into answering twice.
 */
export function stopBackgroundCommandScenario(): MockScenario {
    return {
        name: 'stop-background-command',
        queryPattern: '^start and stop something in the background',
        iterations: [
            {
                thought: 'Starting the long job.',
                toolCalls: [
                    {
                        function_name: 'shell_command',
                        arguments: {
                            justification: 'Start the long job',
                            command: 'sleep 120',
                            operation_type: 'read-only',
                            run_in_background: true,
                        },
                        tool_call_id: 'tc-stop-background-1',
                    },
                ],
            },
            {
                thought: 'On reflection that is not needed, so I will stop it.',
                toolCalls: [
                    {
                        function_name: 'stop_process',
                        // Preload fills in the pid the background command returned.
                        arguments: { pid: '__BACKGROUND_PID__' },
                        tool_call_id: 'tc-stop-background-2',
                    },
                ],
            },
        ],
        finalResponse: 'I started it and then stopped it again.',
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
    interruptDuringFinalResponseScenario(),
    scrollBehaviorSetupScenario(),
    scrollBehaviorFollowupScenario(),
    liveOutlineScrollScenario(),
    shellCommandScenario(),
    readWriteShellCommandScenario(),
    writeFileScenario(),
    readFileScenario(),
    multiToolScenario(),
    pubSubReloadReproScenario(),
    delegationScenario(),
    slowDelegationScenario(),
    delegatedSlowWorkScenario(),
    delegateAndWaitScenario(),
    delegateTwoAndWaitScenario(),
    backgroundCommandScenario(),
    stopBackgroundCommandScenario(),
    backgroundUpdateMidRunScenario(),
    backgroundUpdateDuringFinalResponseScenario(),
    delegateAndStopScenario(),
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
