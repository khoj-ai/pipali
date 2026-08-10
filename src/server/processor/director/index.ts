import { existsSync } from 'node:fs';
import { type User } from '../../db/schema';
import type { ToolDefinition } from '../conversation/conversation';
import { sendMessageToModel } from '../conversation/index';
import type { ResearchIteration, ToolExecutionContext, MetricsAccumulator } from './types';
import { listFiles, type ListFilesArgs } from '../actor/list_files';
import { resolvePath, isBroadSearch } from '../actor/actor.utils';
import { readFile, type ReadFileArgs } from '../actor/read_file';
import { grepFiles, type GrepFilesArgs } from '../actor/grep_files';
import { editFile, type EditFileArgs } from '../actor/edit_file';
import { writeFile, type WriteFileArgs } from '../actor/write_file';
import { shellCommand, stopProcess, type ShellCommandArgs, type StopProcessArgs } from '../actor/shell_command';
import { webSearch, type WebSearchArgs } from '../actor/search_web';
import { readWebpage, type ReadWebpageArgs } from '../actor/read_webpage';
import { askUser, type AskUserArgs } from '../actor/ask_user';
import type { ConversationRole } from '../conversation/atif/atif.service';
import {
    delegateTask,
    inspectTask,
    stopTask,
    waitForTasks,
    type DelegateTaskArgs,
    type InspectTaskArgs,
    type StopTaskArgs,
    type WaitForTasksArgs,
} from '../actor/delegate_task';
import { generateImage, type GenerateImageArgs } from '../actor/generate_image';
import { emailUser, type EmailUserArgs } from '../actor/email_user';
import { applyProviderToolSearch, applyToolDeferral, buildMcpInventoryForPrompt, searchTools, SEARCH_TOOLS_TOOL_NAME, type SearchToolsArgs } from '../actor/search_tools';
import { getFunctionCallName } from '../conversation/openai/utils';
import { getChatModelById, getDefaultChatModel } from '../../db';
import * as prompts from './prompts';
import { getLoadedSkills, formatSkillsForPrompt } from '../../skills';
import { formatMemoryForPrompt, MEMORY_RECALL_KIND } from '../../memory';
import { type ATIFMetrics, type ATIFObservationResult, type ATIFStep, type ATIFToolCall, type ATIFTrajectory } from '../conversation/atif/atif.types';
import { addMetrics } from '../conversation/atif/atif.utils';
import type { ConfirmationContext } from '../confirmation';
import { getMcpToolDefinitions, getMcpServerDescriptions, executeMcpTool, isMcpTool } from '../mcp';
import { PlatformBillingError } from '../../http/billing-errors';
import { PlatformAuthError } from '../../http/platform-fetch';
import { createChildLogger } from '../../logger';

const log = createChildLogger({ component: 'director' });

function getPlatformRecoverableByModel(error: unknown): boolean | undefined {
    const candidates = [
        (error as { error?: unknown })?.error,
        (error as { body?: { error?: unknown } })?.body?.error,
        (error as { response?: { error?: unknown } })?.response?.error,
    ];

    for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object' && 'recoverable_by_model' in candidate) {
            const value = candidate.recoverable_by_model;
            if (typeof value === 'boolean') return value;
        }
    }

    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
    if (!message) return undefined;

    const jsonStart = message.indexOf('{');
    if (jsonStart === -1) return undefined;

    try {
        const parsed = JSON.parse(message.slice(jsonStart)) as { error?: { recoverable_by_model?: unknown } };
        return typeof parsed.error?.recoverable_by_model === 'boolean'
            ? parsed.error.recoverable_by_model
            : undefined;
    } catch {
        return undefined;
    }
}

function isNonRecoverablePlatformModelError(error: unknown): boolean {
    return getPlatformRecoverableByModel(error) === false;
}

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

/** Get time of day from hour to balance model context with context cache.
 *  Distinguish next date after midnight from previous date night for LLM.
 */
function getTimeOfDay(date: Date): string {
    const hour = date.getHours();
    if (hour >= 0 && hour < 4) return 'after midnight';
    if (hour >= 4 && hour < 8) return 'early morning';
    if (hour >= 8 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    if (hour >= 21 && hour < 24) return 'night';
    return '';
}

interface ResearchConfig {
    chatHistory: ATIFTrajectory;
    maxIterations: number;
    currentIteration?: number;
    currentDate?: string;
    dayOfWeek?: string;
    location?: string;
    username?: string;
    userContext?: string;
    /** Catalogue the conversation's system prompt lists, frozen at conversation start */
    memoryCatalogue?: string;
    /** Whether persistent memories may be exposed to this run. */
    memoriesEnabled?: boolean;
    user?: typeof User.$inferSelect;
    /** Optional system prompt override (persisted at run start) */
    systemPrompt?: string;
    // For pause support
    abortSignal?: AbortSignal;
    // For user confirmation on dangerous operations
    confirmationContext?: ConfirmationContext;
    // Chat model ID to use for this conversation (overrides user's default)
    chatModelId?: number;
    // Row-less platform model alias to use while retaining the selected model's configuration
    chatModelAlias?: string;
    // Unique ID of current research run
    runId?: string;
    // Step count when iteration threshold was first reached, for stable warning injection
    thresholdStepCount?: number;
    // Whether this is the user's very first conversation ever
    isFirstEverConversation?: boolean;
    // Conversation ID for tools that need to reference the current conversation
    conversationId?: string;
    // Whether this conversation may itself delegate
    conversationRole?: ConversationRole;
    // Callback for real-time text delta streaming
    onTextChunk?: (chunk: string) => void;
    // MCP tools whose full schemas are advertised to the model (others are deferred behind search_tools)
    loadedMcpTools?: Set<string>;
    // How MCP tools defer for this run: provider tool search ('namespaced' over the
    // OpenAI Responses API, 'flat' via provider translation) or the app-side
    // search_tools actor ('off')
    providerToolSearch?: ProviderToolSearchMode;
    // Returns and clears steps delivered to this conversation while the run is in flight
    drainInjectedSteps?: () => ATIFStep[];
}

export type ProviderToolSearchMode = 'off' | 'flat' | 'namespaced';

/**
 * Name-only inventory of connected MCP tools for the system prompt. Kept
 * non-fatal: an unreachable MCP server must not block the prompt.
 */
async function buildMcpContext(): Promise<string> {
    try {
        return buildMcpInventoryForPrompt(await getMcpToolDefinitions());
    } catch (error) {
        log.warn({ err: error }, 'Failed to build MCP tool inventory for system prompt');
        return '';
    }
}

export async function buildSystemPrompt(args: {
    currentDate?: string;
    dayOfWeek?: string;
    location?: string;
    language?: string;
    username?: string;
    userContext?: string;
    provideUpdatesPreamble?: string;
    isFirstEverConversation?: boolean;
    conversationRole?: ConversationRole;
    /** Catalogue to list, frozen at conversation start by the caller. Live changes arrive as steps. */
    memoryCatalogue?: string;
    memoriesEnabled?: boolean;
    now?: Date;
}): Promise<string> {
    const now = args.now ?? new Date();

    const userContext = args.userContext
        ? await prompts.userContext.format({ userContext: args.userContext })
        : '';

    const provideUpdatesPreamble = args.provideUpdatesPreamble
        ? `\n- ${args.provideUpdatesPreamble}`
        : '';

    const memoryContext = args.memoriesEnabled === false
        ? ''
        : formatMemoryForPrompt(args.memoryCatalogue ?? '', {
            canWrite: args.conversationRole !== 'delegated',
        });

    const skillsContext = formatSkillsForPrompt(getLoadedSkills().filter(s => s.visible));

    const mcpContext = await buildMcpContext();

    const firstConversationContext = args.isFirstEverConversation
        ? await prompts.firstConversation.format({})
        : '';

    return prompts.director.format({
        user_context: userContext,
        memory_context: memoryContext,
        skills_context: skillsContext,
        mcp_context: mcpContext,
        first_conversation_context: firstConversationContext,
        current_date: args.currentDate ?? now.toLocaleDateString('en-CA'),
        current_time: getTimeOfDay(now),
        day_of_week: args.dayOfWeek ?? now.toLocaleDateString('en-US', { weekday: 'long' }),
        location: args.location ?? 'Unknown',
        username: args.username ?? 'User',
        language: new Intl.DisplayNames(['en'], { type: 'language' }).of(args.language || Intl.DateTimeFormat().resolvedOptions().locale) ?? 'English',
        os_info: `${process.platform} ${process.arch}`,
        provide_updates_preamble: provideUpdatesPreamble,
    });
}

// Built-in tool definitions for the research agent
const builtInTools: ToolDefinition[] = [
    {
        name: 'view_file',
        description: 'To view the contents of specific files including text, images (jpeg, png, webp), PDFs, and common office documents (docx, xlsx, pptx, odt, ods, odp). Use offset and limit to efficiently read large text content.',
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
        description: 'A grep-like line oriented search tool. Search through plaintext and readable documents (pdf, docx, xlsx, pptx, odt, ods, odp) under a specified path using regex patterns. Returns all lines matching the pattern. Use this when you need to find all relevant files. The regex pattern will ONLY match content on a single line. Use lines_before, lines_after to show context around matches.',
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
            ? 'Execute a PowerShell command on the user\'s Windows system. Use this to run shell commands, scripts, or CLI tools. Useful for tasks like: data analysis, generating reports, file manipulation via CLI tools, etc. All command runs are logged remotely for security audit. Use PowerShell syntax (Get-ChildItem/ls, Get-Content/cat, Copy-Item/cp, Move-Item/mv, Remove-Item/rm, etc.). Available runtimes: bun (js/ts), uv/uvx (python - auto-install Python if needed).'
            : 'Execute a Bash command on the user\'s system. Use this to run shell commands, scripts, or CLI tools. Useful for tasks like: data analysis, generating reports, file manipulation via CLI tools, etc. All command runs are logged remotely for security audit. Available runtimes: bun (js/ts), uv/uvx (python - auto-install Python if needed).',
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
                        ? 'The PowerShell command to execute. Escape literal `$` to prevent expansion.'
                        : 'The bash command to execute. Escape literal `$` to prevent expansion.',
                },
                operation_type: {
                    type: 'string',
                    enum: ['read-only', 'write-only', 'read-write'],
                    description: process.platform === 'win32'
                        ? 'Whether the command is read-only (no side effects, e.g., Get-ChildItem, Get-Content), write-only (creates new state without reading, e.g., New-Item, Set-Content), or read-write (reads and modifies state, e.g., Move-Item, Remove-Item, Copy-Item).'
                        : 'Whether the command is read-only (no side effects, e.g., ls, cat, grep), write-only (creates new state without reading, e.g., mkdir, touch, echo > newfile), or read-write (reads and modifies state, e.g., sed -i, mv, rm, apt install).',
                },
                execution_mode: {
                    type: 'string',
                    enum: process.platform === 'win32' ? ['direct'] : ['sandbox', 'direct'],
                    description: process.platform === 'win32'
                        ? 'Only direct mode is available on Windows, this requires user confirmation.'
                        : '- Sandbox mode (default): OS-enforced sandbox, no user confirmation needed but with restricted write paths like /tmp/pipali, ~/.pipali and allowed domains like localhost, github, package registries, ai cloud APIs\n- Direct mode: No sandbox, requires user confirmation but has full access',
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
                run_in_background: {
                    type: 'boolean',
                    description: 'Set true for work that outlives a tool call: builds, test suites, dev servers. Returns the pid and a log file to tail or grep, and you are told when the command exits. Ignores timeout.',
                },
            },
            required: ['justification', 'command', 'operation_type'],
        },
    },
    {
        name: 'stop_process',
        description: 'Stop a background command started by shell_command, along with anything it spawned.',
        schema: {
            type: 'object',
            properties: {
                pid: {
                    type: 'integer',
                    description: 'The pid returned when the command was started.',
                },
            },
            required: ['pid'],
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
                fresh: {
                    type: 'boolean',
                    description: 'Set true only when cached content could make the answer wrong: live/current/latest values like rankings, prices, status, or feeds. Otherwise false.',
                },
            },
            required: ['url', 'query', 'fresh'],
        },
    },
    {
        name: 'generate_image',
        description: 'Generate a raster image from a text description. Use this to create icons, illustrations, posters, unstructured diagrams or other visual assets for branding, education, documents, communication etc.',
        schema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'A detailed text description of the image to generate. Be specific about subject, style, composition, colors, lighting, and mood for best results.',
                },
                aspect_ratio: {
                    type: 'string',
                    enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
                    description: 'Aspect ratio of the generated image. Default is 1:1 (square). Use 4:3 or 16:9 for landscape, 3:4 or 9:16 for portrait.',
                },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'email_user',
        description: 'Send an email to the user. Use this to deliver reports, summaries, notifications, or any content the user should receive in their inbox. Especially useful for background tasks and automations where the user may not be actively watching the chat.',
        schema: {
            type: 'object',
            properties: {
                subject: {
                    type: 'string',
                    description: 'The email subject line. Keep it concise and descriptive.',
                },
                body: {
                    type: 'string',
                    description: 'The email body content in HTML format. Use proper HTML tags for formatting (paragraphs, lists, headings, etc.).',
                },
                attachments: {
                    type: 'array',
                    description: 'Optional array of file attachments to include with the email. Provide the local file path for each attachment.',
                    items: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description: 'Local file path of the file to attach (e.g., /tmp/pipali/chart.png).',
                            },
                            filename: {
                                type: 'string',
                                description: 'Optional filename to display for the attachment. Defaults to path basename if unspecified.',
                            },
                        },
                        required: ['path'],
                    },
                },
            },
            required: ['subject', 'body'],
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

/** Held apart from builtInTools because which conversations get them varies by role. */
const delegationTools: ToolDefinition[] = [
    {
        name: 'delegate_task',
        description: `Hand a task to a separate conversation to work on independently.

Delegate when a task will take more than a few steps or can be parallelized.

If run_in_background is true, the task is delegated to and returns immediately with its conversation id, and you are notified when it finishes. Otherwise this one call waits till the task is completed and returns the result.
You can also start several tasks in the background and wait_for_tasks on all of them together.`,
        schema: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: 'Short label for the task, shown to the user in the sidebar and task cards. A few words.',
                },
                message: {
                    type: 'string',
                    description: 'The complete, standalone brief for the task, including what "done" looks like. The task sees only this.',
                },
                model_tier: {
                    type: 'string',
                    enum: ['flagship', 'balanced', 'lite'],
                    description: 'Model intelligence tier for this task. Choose based on difficulty and cost; omit to use the same tier as this conversation.',
                },
                conversation_id: {
                    type: 'string',
                    description: 'Omit to start a new task. Pass the id of a task you already started to send it a follow-up, which reaches it even mid-work.',
                },
                run_in_background: {
                    type: 'boolean',
                    description: 'Set false to wait for the result and get it back from this call.',
                },
                timeout_seconds: {
                    type: 'number',
                    description: 'Only used when run_in_background is false. How long to wait before returning current state. Defaults to 300, maximum 1800.',
                    minimum: 1,
                    maximum: 1800,
                },
            },
            required: ['title', 'message', 'run_in_background'],
        },
    },
    {
        name: 'inspect_task',
        description: `Read any of the user's conversations - a task you delegated, or an earlier chat you want to recall.

Once a task has finished, every detail level returns its complete final response, since that is the answer you were waiting for.

Detail levels for a task still in progress:
- "latest" (default): the most recent step. The cheap way to check on progress.
- "outline": the current turn - any message, and which tools ran (names with a short identifying argument, never their output).
- "full": a pointer plus recent steps. For a long conversation, follow the instructions it returns to query your own API and pull only the parts you need.`,
        schema: {
            type: 'object',
            properties: {
                conversation_id: { type: 'string', description: 'The conversation to read.' },
                detail: {
                    type: 'string',
                    enum: ['latest', 'outline', 'full'],
                    description: 'How much to return while a task is still running. Defaults to "latest".',
                },
            },
            required: ['conversation_id'],
        },
    },
    {
        name: 'wait_for_tasks',
        description: `Wait for delegated tasks to finish and get their results.
Use this for tasks already running in the background. If you are starting a task you intend to wait for, pass run_in_background: false to delegate_task instead - that is one call rather than two.
Pass every task you are waiting on in one call so they run concurrently. Tasks that have already finished return immediately.
Returns each task's final response. The wait ends early if the user interrupts you or stops the run, and returns whatever state the tasks are in if it reaches the timeout.`,
        schema: {
            type: 'object',
            properties: {
                conversation_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Conversation ids of the tasks to wait for, as returned by delegate_task.',
                },
                timeout_seconds: {
                    type: 'number',
                    description: 'How long to wait before giving up and reporting current state. Defaults to 300, maximum 1800.',
                    minimum: 1,
                    maximum: 1800,
                },
            },
            required: ['conversation_ids'],
        },
    },
    {
        name: 'stop_task',
        description: 'Stop a running conversation, such as a delegated task that is no longer needed or has gone off track. The conversation stays readable afterwards.',
        schema: {
            type: 'object',
            properties: {
                conversation_id: { type: 'string', description: 'The conversation whose run should be stopped.' },
            },
            required: ['conversation_id'],
        },
    },
];

/**
 * Get all available tools including built-in tools and MCP tools.
 * When many MCP tools are connected, their schemas are deferred behind tool
 * search: models with provider tool search get provider-side deferral (MCP tools
 * marked defer_loading); others get the app-side search_tools actor, where
 * only tools in `loadedMcpTools` are advertised in full.
 */
async function getAllTools(
    loadedMcpTools: Set<string> = new Set(),
    providerToolSearch: ProviderToolSearchMode = 'off',
    conversationRole: ConversationRole = 'manual',
): Promise<ToolDefinition[]> {
    // A delegated task does the work but cannot split it further.
    const baseTools = conversationRole === 'delegated' ? builtInTools : [...builtInTools, ...delegationTools];
    try {
        const mcpTools = await getMcpToolDefinitions();
        const deferredMcpTools = providerToolSearch !== 'off'
            ? applyProviderToolSearch(mcpTools, {
                namespaced: providerToolSearch === 'namespaced',
                serverDescriptions: getMcpServerDescriptions(),
            })
            : applyToolDeferral(mcpTools, loadedMcpTools);
        return [...baseTools, ...deferredMcpTools];
    } catch (error) {
        log.error({ err: error }, 'Failed to load MCP tools');
        return baseTools;
    }
}

/**
 * How the research run's chat model defers MCP tools. Models with provider
 * tool search get namespaced grouping when served over the OpenAI Responses
 * API (passthrough), or flat defer_loading otherwise.
 */
async function resolveProviderToolSearchMode(chatModelId?: number, user?: typeof User.$inferSelect): Promise<ProviderToolSearchMode> {
    try {
        const chatModelWithApi = chatModelId
            ? await getChatModelById(chatModelId)
            : await getDefaultChatModel(user);
        if (!chatModelWithApi?.chatModel.supportsToolSearch) return 'off';
        return chatModelWithApi.chatModel.useResponsesApi ? 'namespaced' : 'flat';
    } catch (error) {
        log.warn({ err: error }, 'Failed to resolve model tool search capability');
        return 'off';
    }
}

/**
 * Pick the next tool to use based on the current query and previous iterations
 */
async function pickNextTool(
    config: ResearchConfig
): Promise<ResearchIteration> {
    const { currentDate, dayOfWeek, location, username, userContext, currentIteration = 0, maxIterations, thresholdStepCount } = config;
    const isLast = currentIteration >= maxIterations - 1;

    // Get all tools (built-in + delegation + MCP). A delegated task does its own work
    // rather than splitting it further, so delegation is withheld there.
    const tools = await getAllTools(
        config.loadedMcpTools,
        config.providerToolSearch,
        config.conversationRole,
    );
    const toolChoice = isLast ? 'none' : 'auto';

    const now = new Date();
    const systemPrompt = config.systemPrompt ?? await buildSystemPrompt({
        currentDate,
        dayOfWeek,
        location,
        username,
        userContext,
        isFirstEverConversation: config.isFirstEverConversation,
        conversationRole: config.conversationRole,
        memoryCatalogue: config.memoryCatalogue,
        memoriesEnabled: config.memoriesEnabled,
        now,
    });

    // Check if this is the first agent iteration. Auxiliary system steps like a
    // recalled memory can precede the base system prompt in a new conversation.
    const hasSystemStep = config.chatHistory.steps.some(
        s => s.source === 'system' && s.extra?.kind !== MEMORY_RECALL_KIND);
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
            source: 'system' as const,
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
            config.user, // user - for user's selected model
            config.chatModelId,
            config.conversationId,
            config.runId,
            config.onTextChunk,
            config.chatModelAlias,
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
                cache_write_tokens: response.usage.cache_write_tokens,
                cost_usd: response.usage.cost_usd,
            };
        }

        // Parse tool calls from raw output items (Responses API format)
        // Raw output contains items like: { type: 'reasoning', ... }, { type: 'message', ... }, { type: 'function_call', ... }
        const functionCalls = response.raw?.filter((item: any) => item.type === 'function_call') ?? [];

        // No tool calls - model wants to respond directly
        if (functionCalls.length === 0) {
            if (!response.message) {
                log.warn({ hasThought: !!response.thought, rawOutputTypes: response.raw?.map((item: any) => item.type) }, 'Model returned no tool calls and no message');
            }
            return {
                toolCalls: [],
                thought: response.thought,
                message: response.message,
                metrics,
                raw: response.raw,
                systemPrompt: isFirstIteration ? systemPrompt : undefined,
                compactionSummary: response.compactionSummary,
            };
        }

        // Parse tool calls, handling malformed JSON arguments gracefully
        const toolCalls: ATIFToolCall[] = [];
        const parseErrors: string[] = [];
        const failedCallIds = new Set<string>();

        for (const fc of functionCalls as any[]) {
            try {
                const args = typeof fc.arguments === 'string' ? JSON.parse(fc.arguments) : fc.arguments;
                toolCalls.push({
                    function_name: getFunctionCallName(fc),
                    arguments: args,
                    tool_call_id: fc.call_id,
                });
            } catch (parseError) {
                log.warn({ toolName: fc.name, callId: fc.call_id, arguments: fc.arguments?.substring?.(0, 200), err: parseError }, 'Failed to parse tool call arguments');
                parseErrors.push(`Tool "${fc.name}" has invalid JSON arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
                failedCallIds.add(fc.call_id);
            }
        }

        // Filter out malformed function_calls from raw output to prevent them from being
        // passed through to subsequent API requests (which would cause 400 errors)
        const sanitizedRaw = parseErrors.length > 0
            ? response.raw?.filter((item: any) => item.type !== 'function_call' || !failedCallIds.has(item.call_id))
            : response.raw;

        // If all tool calls failed to parse, return warning asking model to retry
        if (toolCalls.length === 0 && parseErrors.length > 0) {
            return {
                toolCalls: [],
                warning: `Failed to parse tool call arguments. Please retry with valid JSON.\n${parseErrors.join('\n')}`,
                thought: response.thought,
                metrics,
                raw: sanitizedRaw,
                systemPrompt: isFirstIteration ? systemPrompt : undefined,
                compactionSummary: response.compactionSummary,
            };
        }

        // If some tool calls failed, log but continue with the valid ones
        if (parseErrors.length > 0) {
            log.warn({ parseErrors, validCount: toolCalls.length }, 'Some tool calls had invalid JSON, continuing with valid ones');
        }

        return {
            toolCalls,
            thought: response.thought,
            message: response.message,
            metrics,
            raw: sanitizedRaw,
            systemPrompt: isFirstIteration ? systemPrompt : undefined,
            compactionSummary: response.compactionSummary,
        };
    } catch (error) {
        // Re-throw platform errors that should be handled by the caller instead of fed back to the model.
        if (error instanceof PlatformBillingError || error instanceof PlatformAuthError || isNonRecoverablePlatformModelError(error)) {
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
 * Extract shell text preceding any heredoc body to scan for (chained) commands.
 * Interpreter payloads (`python3 << 'EOF' ...`) are not shell syntax that need to scanned.
 */
function shellPortion(command: string): string {
    return command.split(/<<-?\s*['"]?\w+/)[0] ?? command;
}

/**
 * Detect if a shell command is a `find` invocation.
 * Matches `find /path ...` at the start or after pipe/chain operators.
 */
export function isShellFindCommand(command: string): boolean {
    const shell = shellPortion(command);
    const trimmed = shell.trimStart();
    if (trimmed.startsWith('find ') || trimmed === 'find') return true;
    // Check for find after pipe or chain operators
    return /[|;&]\s*find\s/.test(shell);
}

/**
 * Extract the search path from a `find` command (first non-option argument).
 * Returns undefined if no path can be extracted.
 */
export function extractFindPath(command: string): string | undefined {
    // Split on chain operators to get the segment containing `find`
    const segments = shellPortion(command).split(/[|;&]+/);
    const findSegment = segments.reverse().find(s => s.trimStart().startsWith('find '));
    if (!findSegment) return undefined;
    const afterFind = findSegment.trimStart().slice('find '.length).trimStart();
    // First token is the path unless it starts with - (an option flag)
    const firstToken = afterFind.split(/\s/)[0];
    if (!firstToken || firstToken.startsWith('-')) return undefined;
    return firstToken;
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
            // Direct calls to deferred tools work without a prior search; mark
            // them loaded so their schemas are advertised from the next iteration
            context?.loadedMcpTools?.add(toolCall.function_name);
            return await executeMcpTool(
                toolCall.function_name,
                toolCall.arguments as Record<string, unknown>,
                context?.confirmation
            );
        }

        // Built-in tools
        switch (toolCall.function_name) {
            case SEARCH_TOOLS_TOOL_NAME: {
                const mcpTools = await getMcpToolDefinitions();
                const result = searchTools(toolCall.arguments as SearchToolsArgs, mcpTools);
                for (const match of result.matches) {
                    context?.loadedMcpTools?.add(match.name);
                }
                return result.compiled;
            }
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
                    { confirmationContext: context?.confirmation, conversationId: context?.conversationId }
                );
                return result.compiled;
            }
            case 'write_file': {
                const result = await writeFile(
                    toolCall.arguments as WriteFileArgs,
                    { confirmationContext: context?.confirmation, conversationId: context?.conversationId }
                );
                return result.compiled;
            }
            case 'shell_command': {
                const args = toolCall.arguments as ShellCommandArgs;

                // On macOS, intercept the first broad `find` command and block it with a warning.
                // Running `find` on broad paths (~ or ~/Documents) is slow and triggers TCC permission dialogs.
                // Narrow finds (e.g., find ~/Documents/notes/ -name "*.md") are fast and allowed through.
                if (process.platform === 'darwin'
                    && isShellFindCommand(args.command)
                    && context?.shownReminders
                    && !context.shownReminders.has('find_warned')
                ) {
                    const findPath = extractFindPath(args.command);
                    const resolvedFindPath = findPath ? resolvePath(findPath) : resolvePath('~');
                    // A find on a missing path fails instantly, so there is no slow scan to warn about
                    if (isBroadSearch(resolvedFindPath) && existsSync(resolvedFindPath)) {
                        context.shownReminders.add('find_warned');
                        return '[System Warning]: prefer `mdfind` over `find` for instant results and to avoid TCC permission dialogs.\n'
                            + 'Examples: `mdfind -name "report" -onlyin ~/Documents` (find by name substring), '
                            + '`mdfind "kMDItemFSName == \'*.py\'" -onlyin ~/projects` (find by extension), '
                            + '`mdfind "meeting notes" -onlyin ~/` (full-text content search).\n'
                            + 'If you still need `find`, call shell_command again with the same command.';
                    }
                }

                const result = await shellCommand(
                    args,
                    {
                        confirmationContext: context?.confirmation,
                        conversationId: context?.conversationId,
                        user: context?.user,
                    }
                );
                return result.compiled;
            }
            case 'stop_process': {
                return stopProcess(toolCall.arguments as StopProcessArgs).compiled;
            }
            case 'search_web': {
                const result = await webSearch(toolCall.arguments as WebSearchArgs, context?.conversationId);
                return result.compiled;
            }
            case 'read_webpage': {
                const result = await readWebpage(
                    toolCall.arguments as ReadWebpageArgs,
                    {
                        confirmationContext: context?.confirmation,
                        metricsAccumulator: context?.metricsAccumulator,
                    },
                    context?.conversationId,
                    context?.runId,
                );
                return result.compiled;
            }
            case 'generate_image': {
                const result = await generateImage(toolCall.arguments as GenerateImageArgs, context?.conversationId);
                return result.compiled;
            }
            case 'email_user': {
                const result = await emailUser(toolCall.arguments as EmailUserArgs, context?.conversationId);
                return result.compiled;
            }
            case 'ask_user': {
                const result = await askUser(
                    toolCall.arguments as AskUserArgs,
                    context?.confirmation
                );
                return result.compiled;
            }
            case 'delegate_task': {
                const result = await delegateTask(
                    toolCall.arguments as DelegateTaskArgs,
                    {
                        user: context?.user,
                        parentConversationId: context?.conversationId,
                        confirmationPreferences: context?.confirmation?.preferences,
                        abortSignal: context?.abortSignal,
                        parentChatModelId: context?.chatModelId,
                    },
                );
                return result.compiled;
            }
            case 'inspect_task': {
                const result = await inspectTask(
                    toolCall.arguments as InspectTaskArgs,
                    { user: context?.user },
                );
                return result.compiled;
            }
            case 'stop_task': {
                const result = await stopTask(
                    toolCall.arguments as StopTaskArgs,
                    { user: context?.user },
                );
                return result.compiled;
            }
            case 'wait_for_tasks': {
                const result = await waitForTasks(
                    toolCall.arguments as WaitForTasksArgs,
                    {
                        user: context?.user,
                        abortSignal: context?.abortSignal,
                        parentConversationId: context?.conversationId,
                    },
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

/** Maximum retries per task run for recoverable errors (malformed output, API errors, empty responses) */
const MAX_RETRY_WARNINGS = 2;

/**
 * Main research function - iterates through tool calls until completion
 * Supports pause via abortSignal. Resume is handled by reloading chat history from DB.
 */
export async function* research(config: ResearchConfig): AsyncGenerator<ResearchIteration> {
    const iterationThreshold = Math.floor(config.maxIterations * 0.9) - 1;
    let thresholdStepCount: number | undefined = config.thresholdStepCount;
    let retryWarnings = 0;
    let lastWarning = '';
    // Persists across iterations so one-time reminders only fire once per research run
    const shownReminders = new Set<string>();

    // Models with provider tool search defer MCP tools provider-side; others use
    // the app-side search_tools actor. Resolved once — model is fixed per run.
    const providerToolSearch = config.providerToolSearch
        ?? await resolveProviderToolSearchMode(config.chatModelId, config.user);

    // MCP tools whose schemas are advertised to the model when deferral is active.
    // Seeded from tools called earlier in the conversation so they stay available
    // across turns; grows when search_tools finds tools or a deferred tool is called.
    const loadedMcpTools = new Set<string>(config.loadedMcpTools);
    for (const step of config.chatHistory.steps) {
        for (const tc of step.tool_calls ?? []) {
            if (isMcpTool(tc.function_name)) {
                loadedMcpTools.add(tc.function_name);
            }
        }
    }

    for (let i = 0; i < config.maxIterations; i++) {
        // Check if paused before starting new iteration
        if (config.abortSignal?.aborted) {
            throw new ResearchPausedError();
        }

        // Updates delivered while this run was in flight - a background command
        // exiting, a delegated task reporting back. Already persisted, so this only
        // brings them into the trajectory the next request is built from.
        const injectedSteps = config.drainInjectedSteps?.() ?? [];
        if (injectedSteps.length > 0) {
            config.chatHistory.steps.push(...injectedSteps);
            log.info({ count: injectedSteps.length, iteration: i }, 'Picked up updates delivered mid-run');
        }

        // Capture step count when we first hit the threshold
        if (i === iterationThreshold && thresholdStepCount === undefined) {
            thresholdStepCount = config.chatHistory.steps.length;
        }

        const iteration = await pickNextTool({ ...config, currentIteration: i, thresholdStepCount, loadedMcpTools, providerToolSearch });

        // Handle warnings (e.g., invalid JSON in tool arguments, API errors) - feed back to model for retry
        // Must check before empty tool calls check, since warnings with no valid tool calls should continue loop
        if (iteration.warning) {
            if (iteration.warning === lastWarning) {
                retryWarnings++;
            } else {
                retryWarnings = 1;
                lastWarning = iteration.warning;
            }
            if (retryWarnings > MAX_RETRY_WARNINGS) {
                log.error({ attempt: retryWarnings, warning: iteration.warning }, 'Too many retry warnings, stopping research');
                // End research with an empty message so the warning doesn't surface
                // as a top-level assistant response to the user
                iteration.message = '';
                iteration.toolCalls = [];
                yield iteration;
                break;
            }
            // Create a synthetic observation to feed the warning back to the model
            const syntheticCallId = `warning-${Date.now()}`;
            iteration.toolCalls = [{
                function_name: '_system_warning',
                arguments: {},
                tool_call_id: syntheticCallId,
            }];
            iteration.toolResults = [{
                source_call_id: syntheticCallId,
                content: iteration.warning,
            }];
            // Add synthetic function_call to raw so it round-trips correctly through conversation history
            iteration.raw = [...(iteration.raw || []), {
                type: 'function_call',
                id: syntheticCallId,
                call_id: syntheticCallId,
                name: '_system_warning',
                arguments: '{}',
                status: 'completed',
            }];
            yield iteration;
            continue;
        }

        // Retry if model returned no message or tool call (only reasoning/thought)
        // This handles cases where the LLM produces malformed output with no parseable response
        if (iteration.toolCalls.length === 0 && !iteration.message && retryWarnings < MAX_RETRY_WARNINGS) {
            retryWarnings++;
            log.warn(
                { attempt: retryWarnings, maxRetries: MAX_RETRY_WARNINGS, hasThought: !!iteration.thought, rawOutputTypes: iteration.raw?.map((item: any) => item.type) },
                'Model returned no tool calls and no message, retrying'
            );

            // Feed a warning back to the model asking it to produce a valid response
            const syntheticCallId = `empty-response-retry-${Date.now()}`;
            iteration.toolCalls = [{
                function_name: '_system_warning',
                arguments: {},
                tool_call_id: syntheticCallId,
            }];
            iteration.toolResults = [{
                source_call_id: syntheticCallId,
                content: 'Your previous response did not contain a message or parsable tool calls.',
            }];
            iteration.raw = [...(iteration.raw || []), {
                type: 'function_call',
                id: syntheticCallId,
                call_id: syntheticCallId,
                name: '_system_warning',
                arguments: '{}',
                status: 'completed',
            }];
            yield iteration;
            continue;
        }

        // Stop research if no tool calls (model wants to respond directly)
        if (iteration.toolCalls.length === 0) {
            yield iteration;
            // Reset retry counters on successful response
            retryWarnings = 0;
            lastWarning = '';
            // Check if paused after yielding final response
            // This prevents sending 'complete' if interrupt arrived during model generation
            if (config.abortSignal?.aborted) {
                throw new ResearchPausedError();
            }
            break;
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
            cache_write_tokens: 0,
            cost_usd: 0,
        };

        // Execute all tools in parallel with confirmation context and metrics accumulator
        const executionContext: ToolExecutionContext = {
            confirmation: config.confirmationContext,
            metricsAccumulator,
            conversationId: config.conversationId,
            runId: config.runId,
            shownReminders,
            loadedMcpTools,
            user: config.user,
            chatModelId: config.chatModelId,
            abortSignal: config.abortSignal,
        };
        iteration.toolResults = await executeToolsInParallel(iteration.toolCalls, executionContext, config.abortSignal);

        // Merge tool execution metrics with director's LLM metrics
        if (metricsAccumulator.prompt_tokens > 0 || metricsAccumulator.completion_tokens > 0) {
            iteration.metrics = addMetrics(iteration.metrics, metricsAccumulator);
        }

        yield iteration;

        // Check if paused after completing current step (graceful pause)
        if (config.abortSignal?.aborted) {
            throw new ResearchPausedError();
        }
    }
}
