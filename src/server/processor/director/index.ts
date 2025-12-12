import { type ChatMessage, type User } from '../../db/schema';
import type { ToolDefinition } from '../conversation/conversation';
import { sendMessageToModel } from '../conversation/index';
import type { ResearchIteration, ToolCall, ToolResult } from './types';
import { listFiles, type ListFilesArgs } from '../actor/list_files';
import { readFile, type ReadFileArgs } from '../actor/read_file';
import { grepFiles, type GrepFilesArgs } from '../actor/grep_files';
import * as prompts from './prompts';

interface ResearchConfig {
    query: string;
    chatHistory: ChatMessage[];
    maxIterations: number;
    currentDate?: string;
    dayOfWeek?: string;
    location?: string;
    username?: string;
    personality?: string;
    user?: typeof User.$inferSelect;
}

// Tool definitions for the research agent
const tools: ToolDefinition[] = [
    {
        name: 'view_file',
        description: 'To view the contents of specific files. Specify a line range to efficiently read relevant sections. You can view up to 50 lines at a time.',
        schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The file path to view (can be absolute or relative).',
                },
                start_line: {
                    type: 'integer',
                    description: 'Optional starting line number for viewing a specific range (1-indexed).',
                },
                end_line: {
                    type: 'integer',
                    description: 'Optional ending line number for viewing a specific range (1-indexed).',
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
                    description: 'Optional path prefix to limit the search to files under a specified path.',
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
    query: string,
    previousIterations: ResearchIteration[],
    config: ResearchConfig
): Promise<ResearchIteration> {
    const { currentDate, dayOfWeek, location, username, personality } = config;

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

    // Construct iteration history from previous iterations
    const iterationHistory: ChatMessage[] = [];

    // Add initial query if this is the first iteration
    iterationHistory.push({ by: 'user', message: query });

    // Add previous iterations as tool calls and results
    for (const iteration of previousIterations) {
        if (iteration.toolCalls.length === 0) {
            continue;
        }

        // Add tool calls from assistant
        iterationHistory.push({
            by: 'assistant',
            message: iteration.toolCalls.map(tc => ({
                type: 'tool_call',
                id: tc.id,
                name: tc.name,
                args: tc.args
            })),
            intent: { type: 'tool_call' }
        });

        // Add tool results
        if (iteration.toolResults) {
            iterationHistory.push({
                by: 'user',
                message: iteration.toolResults.map(tr => ({
                    type: 'tool_result',
                    id: tr.toolCall.id,
                    name: tr.toolCall.name,
                    content: tr.result
                })),
                intent: { type: 'tool_result' }
            });
        }
    }

    // Combine with conversation history
    const messages = [...config.chatHistory, ...iterationHistory];

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
            true,      // deepThought
            false,     // fastMode
            undefined, // agentChatModel
            config.user // user - for user's selected model
        );

        // Check if response is valid
        if (!response || (!response.message && !response.raw)) {
            throw new Error('No response from model');
        }

        // Parse tool calls from response
        let toolCalls: ToolCall[];
        if (response.raw && Array.isArray(response.raw) && response.raw.length > 0) {
            toolCalls = response.raw as ToolCall[];
        } else {
            // No tool calls - model wants to respond directly
            toolCalls = [{ name: 'text', args: { response: response.message }, id: crypto.randomUUID() }];
        }

        // Check for repeated tool calls
        const previousToolKeys = new Set(
            previousIterations.flatMap(i =>
                i.toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.args)}`)
            )
        );

        const newToolCalls = toolCalls.filter(tc => {
            const key = `${tc.name}:${JSON.stringify(tc.args)}`;
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
            toolCalls: newToolCalls.length > 0 ? newToolCalls : toolCalls,
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
async function executeTool(toolCall: ToolCall): Promise<string> {
    try {
        switch (toolCall.name) {
            case 'list_files': {
                const result = await listFiles(toolCall.args as ListFilesArgs);
                return result.compiled;
            }
            case 'view_file': {
                const result = await readFile(toolCall.args as ReadFileArgs);
                return result.compiled;
            }
            case 'regex_search_files': {
                const result = await grepFiles(toolCall.args as GrepFilesArgs);
                return result.compiled;
            }
            case 'text': {
                // This is the final response
                return toolCall.args.response || '';
            }
            default:
                return `Unknown tool: ${toolCall.name}`;
        }
    } catch (error) {
        return `Error executing tool ${toolCall.name}: ${error instanceof Error ? error.message : String(error)}`;
    }
}

/**
 * Execute multiple tool calls in parallel and return their results
 */
async function executeToolsInParallel(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results = await Promise.all(
        toolCalls.map(async (toolCall) => {
            const result = await executeTool(toolCall);
            return { toolCall, result };
        })
    );
    return results;
}

/**
 * Main research function - iterates through tool calls until completion
 */
export async function* research(config: ResearchConfig): AsyncGenerator<ResearchIteration> {
    const { query, maxIterations } = config;
    const previousIterations: ResearchIteration[] = [];

    for (let i = 0; i < maxIterations; i++) {
        const iteration = await pickNextTool(query, previousIterations, config);

        // Check for warnings or no tool calls
        if (iteration.warning || iteration.toolCalls.length === 0) {
            yield iteration;
            break;
        }

        // Check if done (text tool = final response)
        const textTool = iteration.toolCalls.find(tc => tc.name === 'text');
        if (textTool) {
            iteration.toolResults = [{ toolCall: textTool, result: textTool.args.response || '' }];
            yield iteration;
            break;
        }

        // Execute all tools in parallel
        iteration.toolResults = await executeToolsInParallel(iteration.toolCalls);
        previousIterations.push(iteration);
        yield iteration;
    }
}
