import { type User } from '../../db/schema';
import type { ToolDefinition } from '../conversation/conversation';
import { sendMessageToModel } from '../conversation/index';
import type { ResearchIteration, ToolCall, ToolResult } from './types';
import { listFiles, type ListFilesArgs } from '../actor/list_files';
import { readFile, type ReadFileArgs } from '../actor/read_file';
import { grepFiles, type GrepFilesArgs } from '../actor/grep_files';
import * as prompts from './prompts';
import type { ATIFObservationResult, ATIFStep, ATIFToolCall, ATIFTrajectory } from '../conversation/atif/atif.types';
import { addStepToTrajectory } from '../conversation/atif/atif.utils';

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
}

// Tool definitions for the research agent
const tools: ToolDefinition[] = [
    {
        name: 'view_file',
        description: 'To view the contents of specific files including text and images. For text files, specify a line range to efficiently read relevant sections (up to 50 lines at a time). For images (jpg, jpeg, png, webp), the full image will be provided for analysis.',
        schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The file path to view (can be absolute or relative). Supports text files and image files (jpg, jpeg, png, webp).',
                },
                start_line: {
                    type: 'integer',
                    description: 'Optional starting line number for viewing a specific range of text files (1-indexed). Ignored for image files.',
                },
                end_line: {
                    type: 'integer',
                    description: 'Optional ending line number for viewing a specific range of text files (1-indexed). Ignored for image files.',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'list_files',
        description: 'To list files under a specified path. Use the path parameter to only show files under the specified path. Use the pattern parameter to filter by glob patterns.',
        schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The directory path to list files from.',
                },
                pattern: {
                    type: 'string',
                    description: "Optional glob pattern to filter files (e.g., '*.md').",
                },
            },
        },
    },
    {
        name: 'regex_search_files',
        description: 'To search through files under specified path using regex patterns. Returns all lines matching the pattern. Use this when you need to find all relevant files. The regex pattern will ONLY match content on a single line. Use lines_before, lines_after to show context around matches.',
        schema: {
            type: 'object',
            properties: {
                regex_pattern: {
                    type: 'string',
                    description: 'The regex pattern to search for content in files.',
                },
                path_prefix: {
                    type: 'string',
                    description: 'Optional path prefix to limit the search to files under a specified path. Default is home directory.',
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
            required: ['regex_pattern'],
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

    // Build tool options string
    const toolOptionsStr = tools
        .map(tool => `- "${tool.name}": "${tool.description}"`)
        .join('\n');

    // Build personality context
    const personalityContext = personality
        ? prompts.personalityContext.format({ personality })
        : Promise.resolve('');

    // Build system prompt using ChatPromptTemplate
    const systemPrompt = await prompts.planFunctionExecution.format({
        tools: toolOptionsStr,
        personality_context: await personalityContext,
        current_date: currentDate ?? new Date().toISOString().split('T')[0],
        day_of_week: dayOfWeek ?? new Date().toLocaleDateString('en-US', { weekday: 'long' }),
        location: location ?? 'Unknown',
        username: username ?? 'User',
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
                thought: response.message,
            };
        }

        return {
            toolCalls: newToolCalls,
            thought: response.message,
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
async function executeTool(toolCall: ATIFToolCall): Promise<string | Array<{ type: string;[key: string]: any }>> {
    try {
        switch (toolCall.function_name) {
            case 'list_files': {
                const result = await listFiles(toolCall.arguments as ListFilesArgs);
                return result.compiled;
            }
            case 'view_file': {
                const result = await readFile(toolCall.arguments as ReadFileArgs);
                return result.compiled;
            }
            case 'regex_search_files': {
                const result = await grepFiles(toolCall.arguments as GrepFilesArgs);
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
        return `Error executing tool ${toolCall.function_name}: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * Execute multiple tool calls in parallel and return their results
 */
async function executeToolsInParallel(toolCalls: ATIFToolCall[]): Promise<ATIFObservationResult[]> {
    const results: ATIFObservationResult[] = await Promise.all(
        toolCalls.map(async (toolCall) => {
            const result = await executeTool(toolCall);
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

        // Execute all tools in parallel
        iteration.toolResults = await executeToolsInParallel(iteration.toolCalls);
        addStepToTrajectory(config.chatHistory, 'agent', '', iteration.toolCalls, { results: iteration.toolResults });
        yield iteration;
    }
}
