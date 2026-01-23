import { type User } from '../../db/schema';
import type { ToolDefinition } from '../conversation/conversation';
import { sendMessageToModel } from '../conversation/index';
import type { ResearchIteration, ToolExecutionContext, MetricsAccumulator } from './types';
import { listFiles, type ListFilesArgs } from '../actor/list_files';
import { readFile, type ReadFileArgs } from '../actor/read_file';
import { grepFiles, type GrepFilesArgs } from '../actor/grep_files';
import { editFile, type EditFileArgs } from '../actor/edit_file';
import { writeFile, type WriteFileArgs } from '../actor/write_file';
import { shellCommand, type ShellCommandArgs } from '../actor/shell_command';
import { webSearch, type WebSearchArgs } from '../actor/search_web';
import { readWebpage, type ReadWebpageArgs } from '../actor/read_webpage';
import { askUser, type AskUserArgs } from '../actor/ask_user';
import * as prompts from './prompts';
import { getLoadedSkills, formatSkillsForPrompt } from '../../skills';
import { type ATIFMetrics, type ATIFObservationResult, type ATIFToolCall, type ATIFTrajectory } from '../conversation/atif/atif.types';
import type { ConfirmationContext } from '../confirmation';
import { getMcpToolDefinitions, executeMcpTool, isMcpTool } from '../mcp';
import { PlatformBillingError } from '../../http/billing-errors';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'director' });

/** Maximum characters for tool output text content before truncation */
export const MAX_TOOL_OUTPUT_CHARS = 100_000;

/**
 * Truncate tool output content to prevent context window blowup and DB bloat.
 * - For strings: truncate to MAX_TOOL_OUTPUT_CHARS
 * - For arrays: truncate text items, preserve binary data (images/audio)
 */
export function truncateToolOutput(
    content: ATIFObservationResult['content']
): ATIFObservationResult['content'] {
    if (typeof content === 'string') {
        if (content.length <= MAX_TOOL_OUTPUT_CHARS) {
            return content;
        }
        return content.slice(0, MAX_TOOL_OUTPUT_CHARS) +
            `\n\n[Output truncated: showing first ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} of ${content.length.toLocaleString()} characters]`;
    }

    // For multimodal arrays, truncate text items only
    return content.map(item => {
        if (item.type === 'text' && typeof item.text === 'string') {
            if (item.text.length <= MAX_TOOL_OUTPUT_CHARS) {
                return item;
            }
            return {
                ...item,
                text: item.text.slice(0, MAX_TOOL_OUTPUT_CHARS) +
                    `\n\n[Output truncated: showing first ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} of ${item.text.length.toLocaleString()} characters]`,
            };
        }
        // Preserve non-text items (images, audio) as-is
        return item;
    });
}

/** Returns a human-readable time of day based on the hour */
function getTimeOfDay(date: Date): string {
    const hour = date.getHours();
    if (hour >= 5 && hour < 9) return 'early morning';
    if (hour >= 9 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    if (hour >= 21 && hour < 24) return 'night';
    return 'late night'; // 0-4
}

interface ResearchConfig {
    chatHistory: ATIFTrajectory;
    maxIterations: number;
    currentIteration?: number;
    currentDate?: string;
    dayOfWeek?: string;
    location?: string;
    username?: string;
    personality?: string;
    user?: typeof User.$inferSelect;
    /** Optional system prompt override (persisted at run start) */
    systemPrompt?: string;
    // For pause support
    abortSignal?: AbortSignal;
    // For user confirmation on dangerous operations
    confirmationContext?: ConfirmationContext;
    // Step count when iteration threshold was first reached, for stable warning injection
    thresholdStepCount?: number;
}

export async function buildSystemPrompt(args: {
    currentDate?: string;
    dayOfWeek?: string;
    location?: string;
    username?: string;
    personality?: string;
    now?: Date;
}): Promise<string> {
    const now = args.now ?? new Date();

    const personalityContext = args.personality
        ? await prompts.personalityContext.format({ personality: args.personality })
        : '';

    const skillsContext = formatSkillsForPrompt(getLoadedSkills());

    return prompts.planFunctionExecution.format({
        personality_context: personalityContext,
        skills_context: skillsContext,
        current_date: args.currentDate ?? now.toLocaleDateString('en-CA'),
        current_time: getTimeOfDay(now),
        day_of_week: args.dayOfWeek ?? now.toLocaleDateString('en-US', { weekday: 'long' }),
        location: args.location ?? 'Unknown',
        username: args.username ?? 'User',
        os_info: `${process.platform} ${process.arch}`,
    });
}

// Built-in tool definitions for the research agent
const builtInTools: ToolDefinition[] = [
    {
        name: 'view_file',
        description: 'To view the contents of specific files including text, images, PDFs, and Office documents. For text files, use offset and limit to efficiently read large files. Supports images (jpg, jpeg, png, webp), PDFs, Word docs, Excel spreadsheets, and PowerPoint presentations.',
        schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The file path to view (can be absolute or relative to home directory).',
                },
                offset: {
                    type: 'integer',
                    description: 'Optional starting line offset (0-based) for text files. Default is 0.',
                    minimum: 0,
                },
                limit: {
                    type: 'integer',
                    description: 'Optional maximum number of lines to read for text files. Default is 50.',
                    minimum: 1,
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'list_files',
        description: 'To list files under a specified path. Supports glob pattern filtering. Returns files sorted by modification time (newest first).',
        schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The directory path to list files from (absolute or relative to home directory).',
                },
                pattern: {
                    type: 'string',
                    description: "Optional glob pattern to filter files (e.g., '*.md', '*.ts').",
                },
                ignore: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "Optional glob patterns to exclude from results (e.g., ['node_modules', '*.log']).",
                },
            },
        },
    },
    {
        name: 'grep_files',
        description: 'A grep-like line oriented search tool. Search through files under specified path using regex patterns. Returns all lines matching the pattern. Use this when you need to find all relevant files. The regex pattern will ONLY match content on a single line. Use lines_before, lines_after to show context around matches.',
        schema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'The regex pattern to search for content in files.',
                },
                path: {
                    type: 'string',
                    description: 'Optional directory or file path to search in. Default is home directory.',
                },
                include: {
                    type: 'string',
                    description: 'Optional glob pattern to filter which files to search (e.g., "*.ts", "*.{js,jsx}").',
                },
                lines_before: {
                    type: 'integer',
                    description: 'Optional number of lines to show before each line match for context (0-20).',
                    minimum: 0,
                    maximum: 20,
                },
                lines_after: {
                    type: 'integer',
                    description: 'Optional number of lines to show after each line match for context (0-20).',
                    minimum: 0,
                    maximum: 20,
                },
                max_results: {
                    type: 'integer',
                    description: 'Optional cap on number of output lines returned (1-5000). Lower values are faster. Default is 500.',
                    minimum: 1,
                    maximum: 5000,
                },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'edit_file',
        description: 'Edit files using exact string replacements. The old_string must be unique in the file unless replace_all is true. Use this to modify existing files. REQUIRED: Must read the file before editing to ensure accurate updates. Provide at least 3 lines of context before and after the target text to ensure accurate matching.',
        schema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'The absolute path to the file to modify.',
                },
                old_string: {
                    type: 'string',
                    description: `The exact literal text to replace.

REQUIRED:
- The text must be unique in the file unless replace_all is true.
- Include at least 3 lines of context immediately before and 3 lines immediately after the target text, matching whitespace and indentation exactly.`,
                },
                new_string: {
                    type: 'string',
                    description: 'The literal text to replace old_string with. Must be different from old_string.',
                },
                replace_all: {
                    type: 'boolean',
                    description: 'If true, replace all occurrences of old_string. Default is false.',
                },
            },
            required: ['file_path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'write_file',
        description: 'Creates a new file or overwrites an existing file with the specified content. Creates parent directories if needed.',
        schema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'The absolute path to the file to write.',
                },
                content: {
                    type: 'string',
                    description: 'The content to write to the file.',
                },
            },
            required: ['file_path', 'content'],
        },
    },
    {
        name: 'shell_command',
        description: process.platform === 'win32'
            ? 'Execute a PowerShell command on the user\'s Windows system. Use this to run shell commands, scripts, or CLI tools. Useful for tasks like: data analysis, generating reports, file manipulation via CLI tools, etc. All command runs are logged remotely for security audit. Use PowerShell syntax (Get-ChildItem/ls, Get-Content/cat, Copy-Item/cp, Move-Item/mv, Remove-Item/rm, etc.).'
            : 'Execute a Bash command on the user\'s system. Use this to run shell commands, scripts, or CLI tools. Useful for tasks like: data analysis, generating reports, file manipulation via CLI tools, etc. All command runs are logged remotely for security audit.',
        schema: {
            type: 'object',
            properties: {
                justification: {
                    type: 'string',
                    description: 'A clear explanation of why this command needs to be run and what it will accomplish. This is shown to the user for approval.',
                },
                command: {
                    type: 'string',
                    description: process.platform === 'win32'
                        ? 'The PowerShell command to execute.'
                        : 'The bash command to execute.',
                },
                operation_type: {
                    type: 'string',
                    enum: ['read-only', 'write-only', 'read-write'],
                    description: process.platform === 'win32'
                        ? 'Whether the command is read-only (no side effects, e.g., Get-ChildItem, Get-Content), write-only (creates new state without reading, e.g., New-Item, Set-Content), or read-write (reads and modifies state, e.g., Move-Item, Remove-Item, Copy-Item).'
                        : 'Whether the command is read-only (no side effects, e.g., ls, cat, grep, find), write-only (creates new state without reading, e.g., mkdir, touch, echo > newfile), or read-write (reads and modifies state, e.g., sed -i, mv, rm, apt install).',
                },
                execution_mode: {
                    type: 'string',
                    enum: ['sandbox', 'direct'],
                    description: process.platform === 'win32'
                        ? 'Execution mode. Only "direct" is available on Windows (requires user confirmation).'
                        : 'Execution mode: "sandbox" runs in OS-enforced sandbox (no confirmation needed, but restricted to allowed paths like /tmp/pipali and ~/.pipali). "direct" runs without sandbox (requires user confirmation, but has full access). Default: sandbox if available.',
                },
                cwd: {
                    type: 'string',
                    description: 'Optional working directory for command execution (absolute path or relative to home). Defaults to home directory.',
                },
                timeout: {
                    type: 'integer',
                    description: 'The timeout for the command in milliseconds. Range: 1000-300000 ms. Default: 30000 ms.',
                    minimum: 1000,
                    maximum: 300000,
                },
            },
            required: ['justification', 'command', 'operation_type'],
        },
    },
    {
        name: 'search_web',
        description: 'Search the internet for information. Use this to find current information, research topics, or discover relevant web pages. Returns search results with titles, links, and snippets.',
        schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The search query to find information about.',
                },
                max_results: {
                    type: 'integer',
                    description: 'Maximum number of results to return (1-20). Default is 10.',
                    minimum: 1,
                    maximum: 20,
                },
                country_code: {
                    type: 'string',
                    description: 'Two-letter country code for localized results (e.g., "US", "GB", "DE"). Default is "US".',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'read_webpage',
        description: 'Read and extract content from a specific webpage URL. Use this after search_web to read full content from interesting search results, or when given a specific URL to read. Automatically extracts relevant information based on the query.',
        schema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'The URL of the webpage to read (must start with http:// or https://).',
                },
                query: {
                    type: 'string',
                    description: 'Query to focus the content extraction. Only information relevant to the query will be extracted from the webpage.',
                },
            },
            required: ['url', 'query'],
        },
    },
    {
        name: 'ask_user',
        description: `Ask the user a question or send them a notification. This tool displays a structured prompt that the user can see and respond to even when not actively viewing the chat - making it ideal for background tasks and automations.

Use this tool to:
- Gather user preferences or requirements before proceeding
- Clarify ambiguous instructions when multiple interpretations are possible
- Get decisions on implementation choices (e.g., which approach to take, which files to modify)
- Offer choices to the user about what direction to take
- Send important status updates or notifications that require acknowledgment

Benefits over plain text responses:
- Notifications are visible even when user is not in the chat (appears as a toast)
- Structured options make it easy for users to respond with a single click
- Users can always provide a custom text response if none of the options fit

Tips:
- If you recommend a specific option, list it first and add "(Recommended)" to the label
- Keep options concise (1-5 words) with clear, distinct choices
- Use 2-4 options for best user experience
- Omit options entirely to send a notification that requires acknowledgment`,
        schema: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: 'Short heading for the question or notification. Should be clear and specific.',
                },
                description: {
                    type: 'string',
                    description: 'Longer explanation providing context, trade-offs, or implications of each choice.',
                },
                options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Multiple choice option labels (2-4 recommended). If empty, functions as a notification requiring acknowledgment. Users can always type a custom response instead of selecting an option.',
                },
                input_type: {
                    type: 'string',
                    enum: ['choice', 'text_input'],
                    description: "Type of input: 'choice' for multiple choice options (default), 'text_input' for free-form text response.",
                },
            },
            required: ['title'],
        },
    },
];

/**
 * Get all available tools including built-in tools and MCP tools
 */
async function getAllTools(): Promise<ToolDefinition[]> {
    try {
        const mcpTools = await getMcpToolDefinitions();
        return [...builtInTools, ...mcpTools];
    } catch (error) {
        log.error({ err: error }, 'Failed to load MCP tools');
        return builtInTools;
    }
}

/**
 * Pick the next tool to use based on the current query and previous iterations
 */
async function pickNextTool(
    config: ResearchConfig
): Promise<ResearchIteration> {
    const { currentDate, dayOfWeek, location, username, personality, currentIteration = 0, maxIterations, thresholdStepCount } = config;
    const lastUserIndex = config.chatHistory.steps.findLastIndex(s => s.source === 'user') || 0;
    const isLast = currentIteration >= maxIterations - 1;
    const previousIterations = config.chatHistory.steps.slice(lastUserIndex + 1);

    // Get all tools (built-in + MCP)
    const tools = await getAllTools();
    const toolChoice = isLast ? 'none' : 'auto';

    // Build personality context
    const personalityContext = personality
        ? prompts.personalityContext.format({ personality })
        : Promise.resolve('');

    // Build skills context
    const skillsContext = formatSkillsForPrompt(getLoadedSkills());

    const now = new Date();
    const systemPrompt = config.systemPrompt ?? await buildSystemPrompt({
        currentDate,
        dayOfWeek,
        location,
        username,
        personality,
        now,
    });

    // Check if this is the first agent iteration
    const hasSystemStep = config.chatHistory.steps.some(s => s.source === 'system');
    const isFirstIteration = !hasSystemStep;

    // Inject iteration warning when at 90%+ of max iterations
    // Warning is stably inserted after threshold step to preserve context cache.
    // Warning is only shown to model, not persisted in DB
    const iterationThreshold = Math.floor(maxIterations * 0.9) - 1;
    let messages: ATIFTrajectory = config.chatHistory;

    if (currentIteration >= iterationThreshold && thresholdStepCount !== undefined) {
        const remainingIterations = maxIterations - iterationThreshold;
        const iterationWarning = await prompts.iterationWarning.format({
            current_iteration: String(iterationThreshold),
            max_iterations: String(maxIterations),
            remaining_iterations: String(remainingIterations),
        });

        const warningStep = {
            step_id: -1, // Ephemeral, not persisted
            timestamp: now.toISOString(),
            source: 'user' as const,
            message: iterationWarning,
        };

        // Insert at the stable position captured when threshold was first reached
        messages = {
            ...config.chatHistory,
            steps: [
                ...config.chatHistory.steps.slice(0, thresholdStepCount),
                warningStep,
                ...config.chatHistory.steps.slice(thresholdStepCount),
            ],
        };
    }

    try {
        // Send message to model to pick next tool
        const response = await sendMessageToModel(
            "",
            messages,
            systemPrompt,
            tools,
            toolChoice,
            true,      // deepThought
            false,     // fastMode
            config.user // user - for user's selected model
        );

        // Check if response is valid
        if (!response || (!response.message && !response.raw)) {
            throw new Error('No response from model');
        }

        // Extract usage metrics from response
        let metrics: ATIFMetrics | undefined;
        if (response.usage) {
            metrics = {
                prompt_tokens: response.usage.prompt_tokens,
                completion_tokens: response.usage.completion_tokens,
                cached_tokens: response.usage.cached_tokens,
                cost_usd: response.usage.cost_usd,
            };
        }

        // Parse tool calls from raw output items (Responses API format)
        // Raw output contains items like: { type: 'reasoning', ... }, { type: 'message', ... }, { type: 'function_call', ... }
        const functionCalls = response.raw?.filter((item: any) => item.type === 'function_call') ?? [];

        // No tool calls - model wants to respond directly
        if (functionCalls.length === 0) {
            return {
                toolCalls: [],
                thought: response.thought,
                message: response.message,
                metrics,
                raw: response.raw,
                systemPrompt: isFirstIteration ? systemPrompt : undefined,
            };
        }

        const toolCalls: ATIFToolCall[] = functionCalls.map((fc: any) => ({
            function_name: fc.name,
            arguments: typeof fc.arguments === 'string' ? JSON.parse(fc.arguments) : fc.arguments,
            tool_call_id: fc.call_id,
        }));

        // Check for repeated tool calls
        const previousToolKeys = new Set(
            previousIterations.flatMap(i =>
                i.tool_calls?.map(tc => `${tc.function_name}:${JSON.stringify(tc.arguments)}`)
            )
        );

        const newToolCalls = toolCalls.filter(tc => {
            const key = `${tc.function_name}:${JSON.stringify(tc.arguments)}`;
            return !previousToolKeys.has(key);
        });

        // All tool calls are repeated
        if (newToolCalls.length === 0 && toolCalls.length > 0) {
            return {
                toolCalls,
                warning: `Repeated tool calls detected. You've already called these tools with the same arguments. Try something different.`,
                thought: response.thought,
                message: response.message,
                metrics,
                raw: response.raw,
                systemPrompt: isFirstIteration ? systemPrompt : undefined,
            };
        }

        return {
            toolCalls: newToolCalls,
            thought: response.thought,
            message: response.message,
            metrics,
            raw: response.raw,
            systemPrompt: isFirstIteration ? systemPrompt : undefined,
        };
    } catch (error) {
        // Re-throw billing errors so they can be handled by the caller (ws.ts)
        if (error instanceof PlatformBillingError) {
            throw error;
        }
        log.error({ err: error }, 'Failed to pick next tool');
        return {
            toolCalls: [],
            warning: `Failed to infer information sources to refer: ${error instanceof Error ? error.message : String(error)}`,
            systemPrompt: isFirstIteration ? systemPrompt : undefined,
        };
    }
}

/**
 * Execute a single tool call and return the result
 */
async function executeTool(
    toolCall: ATIFToolCall,
    context?: ToolExecutionContext
): Promise<string | Array<{ type: string;[key: string]: any }>> {
    try {
        // Check if this is an MCP tool (contains "__" in name, e.g., "github__create_issue")
        if (isMcpTool(toolCall.function_name)) {
            return await executeMcpTool(
                toolCall.function_name,
                toolCall.arguments as Record<string, unknown>,
                context?.confirmation
            );
        }

        // Built-in tools
        switch (toolCall.function_name) {
            case 'list_files': {
                const result = await listFiles(toolCall.arguments as ListFilesArgs);
                return result.compiled;
            }
            case 'view_file': {
                const result = await readFile(
                    toolCall.arguments as ReadFileArgs,
                    { confirmationContext: context?.confirmation }
                );
                return result.compiled;
            }
            case 'grep_files': {
                const result = await grepFiles(
                    toolCall.arguments as GrepFilesArgs,
                    { confirmationContext: context?.confirmation }
                );
                return result.compiled;
            }
            case 'edit_file': {
                const result = await editFile(
                    toolCall.arguments as EditFileArgs,
                    { confirmationContext: context?.confirmation }
                );
                return result.compiled;
            }
            case 'write_file': {
                const result = await writeFile(
                    toolCall.arguments as WriteFileArgs,
                    { confirmationContext: context?.confirmation }
                );
                return result.compiled;
            }
            case 'shell_command': {
                const result = await shellCommand(
                    toolCall.arguments as ShellCommandArgs,
                    { confirmationContext: context?.confirmation }
                );
                return result.compiled;
            }
            case 'search_web': {
                const result = await webSearch(toolCall.arguments as WebSearchArgs);
                return result.compiled;
            }
            case 'read_webpage': {
                const result = await readWebpage(
                    toolCall.arguments as ReadWebpageArgs,
                    {
                        confirmationContext: context?.confirmation,
                        metricsAccumulator: context?.metricsAccumulator,
                    }
                );
                return result.compiled;
            }
            case 'ask_user': {
                const result = await askUser(
                    toolCall.arguments as AskUserArgs,
                    context?.confirmation
                );
                return result.compiled;
            }
            default:
                return `Unknown tool: ${toolCall.function_name}`;
        }
    } catch (error) {
        // Re-throw pause errors so the research loop can exit cleanly
        if (error instanceof Error && error.message === 'Research paused') {
            throw new ResearchPausedError();
        }
        return `Error executing tool ${toolCall.function_name}: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * Execute multiple tool calls in parallel and return their results.
 * Uses Promise.allSettled to ensure all tools complete (or fail gracefully).
 * This allows partial results to be returned even if some tools are interrupted.
 */
async function executeToolsInParallel(
    toolCalls: ATIFToolCall[],
    context?: ToolExecutionContext,
    abortSignal?: AbortSignal
): Promise<ATIFObservationResult[]> {
    const interruptResult = (toolCall: ATIFToolCall): ATIFObservationResult => ({
        source_call_id: toolCall.tool_call_id,
        content: '[interrupted]',
    });

    const toolPromises = toolCalls.map((toolCall) => {
        const toolPromise: Promise<ATIFObservationResult> = (async () => {
            try {
                const result = await executeTool(toolCall, context);
                return { source_call_id: toolCall.tool_call_id, content: truncateToolOutput(result) };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return { source_call_id: toolCall.tool_call_id, content: `[error: ${errorMessage}]` };
            }
        })();

        if (!abortSignal) return toolPromise;
        if (abortSignal.aborted) return Promise.resolve(interruptResult(toolCall));

        const abortPromise: Promise<ATIFObservationResult> = new Promise((resolve) => {
            abortSignal.addEventListener('abort', () => resolve(interruptResult(toolCall)), { once: true });
        });

        return Promise.race([toolPromise, abortPromise]);
    });

    return await Promise.all(toolPromises);
}

// Custom error for pause signal
export class ResearchPausedError extends Error {
    constructor() {
        super('Research paused');
        this.name = 'ResearchPausedError';
    }
}

/**
 * Main research function - iterates through tool calls until completion
 * Supports pause via abortSignal. Resume is handled by reloading chat history from DB.
 */
export async function* research(config: ResearchConfig): AsyncGenerator<ResearchIteration> {
    const iterationThreshold = Math.floor(config.maxIterations * 0.9) - 1;
    let thresholdStepCount: number | undefined = config.thresholdStepCount;

    for (let i = 0; i < config.maxIterations; i++) {
        // Check if paused before starting new iteration
        if (config.abortSignal?.aborted) {
            throw new ResearchPausedError();
        }

        // Capture step count when we first hit the threshold
        if (i === iterationThreshold && thresholdStepCount === undefined) {
            thresholdStepCount = config.chatHistory.steps.length;
        }

        const iteration = await pickNextTool({ ...config, currentIteration: i, thresholdStepCount });

        // Stop research if no tool calls
        if (iteration.toolCalls.length === 0) {
            yield iteration;
            // Check if paused after yielding final response
            // This prevents sending 'complete' if interrupt arrived during model generation
            if (config.abortSignal?.aborted) {
                throw new ResearchPausedError();
            }
            break;
        }

        // Add warning to trajectory and skip tool execution
        if (iteration.warning) {
            const warningObservations: ATIFObservationResult[] = iteration.toolCalls.map(tc => ({ source_call_id: tc.tool_call_id, content: `Skipped due to warning: ${iteration.warning}` }));
            iteration.toolResults = warningObservations;
            yield iteration;
            continue;
        }

        // Yield tool calls before execution so UI can show current step
        yield { ...iteration, isToolCallStart: true };

        // Check if paused before executing tools - but after yielding tool_call_start
        // If paused here, yield results with [interrupted] markers so UI can clear pending state
        if (config.abortSignal?.aborted) {
            const interruptedResults: ATIFObservationResult[] = iteration.toolCalls.map(tc => ({
                source_call_id: tc.tool_call_id,
                content: '[interrupted]',
            }));
            iteration.toolResults = interruptedResults;
            yield iteration;
            throw new ResearchPausedError();
        }

        // Create metrics accumulator to capture LLM usage from tool executions
        const metricsAccumulator: MetricsAccumulator = {
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            cost_usd: 0,
        };

        // Execute all tools in parallel with confirmation context and metrics accumulator
        const executionContext: ToolExecutionContext = {
            confirmation: config.confirmationContext,
            metricsAccumulator,
        };
        iteration.toolResults = await executeToolsInParallel(iteration.toolCalls, executionContext, config.abortSignal);

        // Merge tool execution metrics with director's LLM metrics
        if (metricsAccumulator.prompt_tokens > 0 || metricsAccumulator.completion_tokens > 0) {
            if (iteration.metrics) {
                iteration.metrics.prompt_tokens += metricsAccumulator.prompt_tokens;
                iteration.metrics.completion_tokens += metricsAccumulator.completion_tokens;
                iteration.metrics.cached_tokens = (iteration.metrics.cached_tokens || 0) + metricsAccumulator.cached_tokens;
                iteration.metrics.cost_usd += metricsAccumulator.cost_usd;
            } else {
                iteration.metrics = {
                    prompt_tokens: metricsAccumulator.prompt_tokens,
                    completion_tokens: metricsAccumulator.completion_tokens,
                    cached_tokens: metricsAccumulator.cached_tokens || undefined,
                    cost_usd: metricsAccumulator.cost_usd,
                };
            }
        }

        yield iteration;

        // Check if paused after completing current step (graceful pause)
        if (config.abortSignal?.aborted) {
            throw new ResearchPausedError();
        }
    }
}
