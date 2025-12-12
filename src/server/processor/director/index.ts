import { type ChatMessage } from '../../db/schema';
import type { ToolDefinition } from '../conversation/conversation';
import { sendMessageToModel } from '../conversation/index';
import type { ResearchIteration, ToolCall } from './types';
import { listFiles, type ListFilesArgs } from '../actor/list_files';
import { readFile, type ReadFileArgs } from '../actor/read_file';
import { grepFiles, type GrepFilesArgs } from '../actor/grep_files';
import * as prompts from './prompts';

interface ResearchConfig {
    query: string;
    chatHistory: ChatMessage[];
    maxIterations?: number;
    currentDate?: string;
    dayOfWeek?: string;
    location?: string;
    username?: string;
    personality?: string;
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
        max_iterations: String(config.maxIterations || 5)
    });

    // Construct iteration history from previous iterations
    const iterationHistory: ChatMessage[] = [];

    // Add initial query if this is the first iteration
    iterationHistory.push({ by: 'user', message: query });

    // Add previous iterations as tool calls and results
    for (const iteration of previousIterations) {
        if (!iteration.query || typeof iteration.query === 'string') {
            // If query is not a tool call, add as user message
            iterationHistory.push({
                by: 'user',
                message: iteration.summarizedResult || iteration.warning || 'Please specify what you want to do next.'
            });
            continue;
        }

        // Add tool call from assistant
        iterationHistory.push({
            by: 'assistant',
            message: iteration.raw_response || [iteration.query],
            intent: { type: 'tool_call' }
        });

        // Add tool result as user message in structured format
        iterationHistory.push({
            by: 'user',
            message: [
                {
                    type: 'tool_result',
                    id: iteration.query.id,
                    name: iteration.query.name,
                    content: iteration.summarizedResult
                }
            ],
            intent: { type: 'tool_result' }
        });
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
            true
        );

        // Check if response is valid
        if (!response || (!response.message && !response.raw)) {
            throw new Error('No response from model');
        }

        // Parse response as tool call
        let toolCall: ToolCall;
        if (response.raw && Array.isArray(response.raw) && response.raw.length > 0) {
            let toolCalls = response.raw as ToolCall[];
            toolCall = toolCalls[0] || { name: 'text', args: { response: response.message }, id: null };
        } else {
            toolCall = { name: 'text', args: { response: response.message }, id: null };
        }

        // Check for repeated tool calls
        const previousToolQueries = new Set(
            previousIterations
                .filter(i => i.query && typeof i.query !== 'string')
                .map(i => {
                    const q = i.query as ToolCall;
                    return `${q.name}:${JSON.stringify(q.args)}`;
                })
        );

        const currentKey = `${toolCall.name}:${JSON.stringify(toolCall.args)}`;
        if (previousToolQueries.has(currentKey)) {
            return {
                query: toolCall,
                warning: `Repeated tool call detected. You've already called ${toolCall.name} with args: ${JSON.stringify(toolCall.args)}. Try something different.`,
                thought: response.message,
            };
        }

        return {
            query: toolCall,
            raw_response: response.raw,
            thought: response.message,
        };
    } catch (error) {
        console.error('Failed to pick next tool:', error);
        return {
            query: null,
            warning: `Failed to infer information sources to refer: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Execute a tool call and return the result
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
 * Main research function - iterates through tool calls until completion
 */
export async function* research(config: ResearchConfig): AsyncGenerator<ResearchIteration> {
    const { query, maxIterations = 5 } = config;
    const previousIterations: ResearchIteration[] = [];
    let currentIteration = 0;

    while (currentIteration < maxIterations) {
        // Pick next tool
        const iteration = await pickNextTool(query, previousIterations, config);
        yield iteration;

        // Check for warnings or completion
        if (iteration.warning) {
            console.warn('Research iteration warning:', iteration.warning);
            break;
        }

        if (!iteration.query || typeof iteration.query === 'string' || iteration.query.id === null) {
            break;
        }

        // Check if we're done (text tool selected)
        if (iteration.query.name === 'text') {
            iteration.summarizedResult = iteration.query.args.response || '';
            previousIterations.push(iteration);
            yield iteration;
            break;
        }

        // Execute the tool
        const result = await executeTool(iteration.query);
        iteration.summarizedResult = result;
        iteration.context = [{ compiled: result }];

        previousIterations.push(iteration);
        yield iteration;

        currentIteration++;
    }

    // If we hit max iterations, return a final message
    if (currentIteration >= maxIterations) {
        yield {
            query: null,
            warning: `Reached maximum iterations (${maxIterations}). Stopping research.`,
        };
    }
}
