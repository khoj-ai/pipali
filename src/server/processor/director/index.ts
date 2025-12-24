import { type User } from '../../db/schema';
import type { ToolDefinition } from '../conversation/conversation';
import { sendMessageToModel } from '../conversation/index';
import type { ResearchIteration, ToolCall, ToolResult, ToolExecutionContext } from './types';
import { listFiles, type ListFilesArgs } from '../actor/list_files';
import { readFile, type ReadFileArgs } from '../actor/read_file';
import { grepFiles, type GrepFilesArgs } from '../actor/grep_files';
import { editFile, type EditFileArgs } from '../actor/edit_file';
import { writeFile, type WriteFileArgs } from '../actor/write_file';
import { bashCommand, type BashCommandArgs } from '../actor/bash_command';
import { webSearch, type WebSearchArgs } from '../actor/search_web';
import { readWebpage, type ReadWebpageArgs } from '../actor/read_webpage';
import * as prompts from './prompts';
import { getLoadedSkills, formatSkillsForPrompt } from '../../skills';
import type { ATIFObservationResult, ATIFToolCall, ATIFTrajectory } from '../conversation/atif/atif.types';
import { addStepToTrajectory } from '../conversation/atif/atif.utils';
import type { ConfirmationContext } from '../confirmation';
import { getMcpToolDefinitions, executeMcpTool, isMcpTool } from '../mcp';

interface ResearchConfig {
    chatHistory: ATIFTrajectory;
    maxIterations: number;
    currentDate?: string;
    dayOfWeek?: string;
    location?: string;
    username?: string;
    personality?: string;
    user?: typeof User.$inferSelect;
    // For pause support
    abortSignal?: AbortSignal;
    // For user confirmation on dangerous operations
    confirmationContext?: ConfirmationContext;
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
        name: 'bash_command',
        description: 'Execute a bash command on the user\'s system. Use this to run shell commands, scripts, or CLI tools. Useful for tasks like: data analysis, generating reports, file manipulation via CLI tools, etc. All command runs are logged remotely for security audit.',
        schema: {
            type: 'object',
            properties: {
                justification: {
                    type: 'string',
                    description: 'A clear explanation of why this command needs to be run and what it will accomplish. This is shown to the user for approval.',
                },
                command: {
                    type: 'string',
                    description: 'The bash command to execute.',
                },
                operation_type: {
                    type: 'string',
                    enum: ['read-only', 'write-only', 'read-write'],
                    description: 'Whether the command is read-only (no side effects, e.g., ls, cat, grep, find), write-only (creates new state without reading, e.g., mkdir, touch, echo > newfile), or read-write (reads and modifies state, e.g., sed -i, mv, rm, apt install).',
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
        name: 'text',
        description: 'Use this when you have gathered enough information and are ready to respond to the user.',
        schema: {
            type: 'object',
            properties: {
                response: {
                    type: 'string',
                    description: 'Your final response to the user.',
                },
            },
            required: ['response'],
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
        console.error('[Director] Failed to load MCP tools:', error);
        return builtInTools;
    }
}

/**
 * Pick the next tool to use based on the current query and previous iterations
 */
async function pickNextTool(
    config: ResearchConfig
): Promise<ResearchIteration> {
    const { currentDate, dayOfWeek, location, username, personality } = config;
    const lastUserIndex = config.chatHistory.steps.findLastIndex(s => s.source === 'user') || 0;
    const isLast = config.chatHistory.steps.length - lastUserIndex == config.maxIterations - 1;
    const previousIterations = config.chatHistory.steps.slice(lastUserIndex + 1);
    const toolChoice = isLast ? 'none' : 'auto';

    // Get all tools (built-in + MCP)
    const tools = await getAllTools();

    // Build tool options string
    const toolOptionsStr = tools
        .map(tool => `- "${tool.name}": "${tool.description}"`)
        .join('\n');

    // Build personality context
    const personalityContext = personality
        ? prompts.personalityContext.format({ personality })
        : Promise.resolve('');

    // Build skills context
    const skillsContext = formatSkillsForPrompt(getLoadedSkills());

    // Build system prompt using ChatPromptTemplate
    const now = new Date();
    const systemPrompt = await prompts.planFunctionExecution.format({
        tools: toolOptionsStr,
        personality_context: await personalityContext,
        skills_context: skillsContext,
        current_date: currentDate ?? now.toLocaleDateString('en-CA'), // YYYY-MM-DD in local time
        current_time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
        day_of_week: dayOfWeek ?? now.toLocaleDateString('en-US', { weekday: 'long' }),
        location: location ?? 'Unknown',
        username: username ?? 'User',
        os_info: `${process.platform} ${process.arch}`,
        max_iterations: String(config.maxIterations)
    });

    // Add initial query if this is the first iteration
    const messages: ATIFTrajectory = config.chatHistory;
    try {
        // Send message to model to pick next tool
        const response = await sendMessageToModel(
            "",
            undefined,
            undefined,
            undefined,
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

        // Parse tool calls from response
        let toolCalls: ATIFToolCall[];
        if (response.raw && Array.isArray(response.raw) && response.raw.length > 0) {
            toolCalls = response.raw.map(tc => ({
                function_name: tc.name,
                arguments: tc.args,
                tool_call_id: tc.id,
            })) as ATIFToolCall[];
        } else {
            // No tool calls - model wants to respond directly
            toolCalls = [{ function_name: 'text', arguments: { response: response.message }, tool_call_id: crypto.randomUUID() }] as ATIFToolCall[];
        }

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
            };
        }

        return {
            toolCalls: newToolCalls,
            thought: response.thought,
            message: response.message,
        };
    } catch (error) {
        console.error('Failed to pick next tool:', error);
        return {
            toolCalls: [],
            warning: `Failed to infer information sources to refer: ${error instanceof Error ? error.message : String(error)}`,
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
                const result = await readFile(toolCall.arguments as ReadFileArgs);
                return result.compiled;
            }
            case 'grep_files': {
                const result = await grepFiles(toolCall.arguments as GrepFilesArgs);
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
            case 'bash_command': {
                const result = await bashCommand(
                    toolCall.arguments as BashCommandArgs,
                    { confirmationContext: context?.confirmation }
                );
                return result.compiled;
            }
            case 'search_web': {
                const result = await webSearch(toolCall.arguments as WebSearchArgs);
                return result.compiled;
            }
            case 'read_webpage': {
                const result = await readWebpage(toolCall.arguments as ReadWebpageArgs);
                return result.compiled;
            }
            case 'text': {
                // This is the final response
                return toolCall.arguments.response || '';
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
 * If any tool throws ResearchPausedError, it will propagate immediately.
 */
async function executeToolsInParallel(
    toolCalls: ATIFToolCall[],
    context?: ToolExecutionContext
): Promise<ATIFObservationResult[]> {
    const results: ATIFObservationResult[] = await Promise.all(
        toolCalls.map(async (toolCall) => {
            // executeTool will throw ResearchPausedError if paused, which propagates through Promise.all
            const result = await executeTool(toolCall, context);
            return { source_call_id: toolCall.tool_call_id, content: result };
        })
    );
    return results;
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
    for (let i = 0; i < config.maxIterations; i++) {
        // Check if paused before starting new iteration
        if (config.abortSignal?.aborted) {
            throw new ResearchPausedError();
        }

        const iteration = await pickNextTool(config);

        // Stop research if no tool calls
        if (iteration.toolCalls.length === 0) {
            yield iteration;
            break;
        }

        // Add warning to trajectory and skip tool execution
        if (iteration.warning) {
            const warningObservations: ATIFObservationResult[] = iteration.toolCalls.map(tc => ({ source_call_id: tc.tool_call_id, content: `Skipped due to warning: ${iteration.warning}` }));
            addStepToTrajectory(config.chatHistory, 'agent', '', iteration.toolCalls, { results: warningObservations });
            iteration.toolResults = warningObservations;
            yield iteration;
            continue;
        }

        // Check if done (text tool = final response)
        const textTool = iteration.toolCalls.find(tc => tc.function_name === 'text');
        if (textTool) {
            iteration.toolResults = [{ source_call_id: textTool.tool_call_id, content: textTool.arguments.response || '' }];
            yield iteration;
            break;
        }

        // Check if paused before executing tools
        if (config.abortSignal?.aborted) {
            throw new ResearchPausedError();
        }

        // Yield tool calls before execution so UI can show current step
        yield { ...iteration, isToolCallStart: true };

        // Execute all tools in parallel with confirmation context
        const executionContext: ToolExecutionContext = {
            confirmation: config.confirmationContext,
        };
        iteration.toolResults = await executeToolsInParallel(iteration.toolCalls, executionContext);
        addStepToTrajectory(config.chatHistory, 'agent', '', iteration.toolCalls, { results: iteration.toolResults });
        yield iteration;
    }
}
