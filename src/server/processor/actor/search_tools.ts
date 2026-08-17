/**
 * Tool Search Actor
 *
 * Lets the agent discover MCP tools on demand instead of loading every tool
 * schema into context upfront. Once more than MCP_TOOL_DEFER_THRESHOLD tools are
 * connected, only a compact name index is advertised (in the system prompt, see
 * buildMcpInventoryForPrompt); the agent searches by regex to load full tool
 * definitions into its tool list.
 *
 * Mirrors the client-executed tool search pattern in the OpenAI Responses API
 * and Anthropic Messages API * (`tool_search(_tool_*)` + `defer_loading`).
 */

import type { ToolDefinition } from '../conversation/conversation';
import { parseNamespacedToolName } from '../mcp';

/**
 * Defer MCP tool schemas behind search when more than this many are connected.
 * Set above the default install's tool count (chrome-browser seeds 17 enabled
 * tools) so deferral only engages once additional servers are connected.
 */
export const MCP_TOOL_DEFER_THRESHOLD = 30;

/**
 * Whether tool schemas leave the model's context for this tool list. The single
 * source of truth for the threshold: the prompt inventory, the app-side search
 * tool and the provider-side one must engage together, or the prompt describes
 * hidden schemas and a search tool that were never advertised.
 */
export function shouldDeferMcpTools(mcpTools: ToolDefinition[]): boolean {
    return mcpTools.length > MCP_TOOL_DEFER_THRESHOLD;
}

export const SEARCH_TOOLS_TOOL_NAME = 'search_tools';

const MAX_SEARCH_RESULTS = 15;
const MAX_RESULT_DESCRIPTION_CHARS = 500;
const MAX_PATTERN_CHARS = 200;

export interface SearchToolsArgs {
    /** Regex pattern matched case-insensitively against tool names and descriptions */
    query: string;
    /** Restrict the search to tools from this MCP server */
    server?: string;
}

export interface SearchToolsResult {
    compiled: string;
    matches: ToolDefinition[];
    /** Matches before the result limit was applied */
    totalMatches: number;
    truncated: boolean;
}

/** Group namespaced tool names by server into a compact one-line-per-server index */
function buildToolIndex(mcpTools: Array<{ name: string }>): string {
    const byServer = new Map<string, string[]>();
    for (const tool of mcpTools) {
        const parsed = parseNamespacedToolName(tool.name);
        const server = parsed?.serverName ?? 'other';
        const names = byServer.get(server) ?? [];
        names.push(parsed?.toolName ?? tool.name);
        byServer.set(server, names);
    }
    return Array.from(byServer.entries())
        .map(([server, names]) => `- ${server}: ${names.join(', ')}`)
        .join('\n');
}

/** Recovers the tool index a persisted system prompt or inventory step carried */
const CONNECTED_TOOLS_BLOCK = /<connected_tools>\n([\s\S]*?)\n<\/connected_tools>/;

/** Carried on an inventory step so the tool set it announced can be read back */
const MCP_TOOLS_KEY = 'mcp_tools';

export const MCP_INVENTORY_KIND = 'mcp_inventory';

/**
 * One writer for both emitters, as the <connected_tools> tags are a contract with
 * mcpInventoryState rather than formatting. A persisted system prompt's copy is
 * the only record of what a conversation was first told, recovered by parsing the
 * block back out. Only the lead differs, since the prompt and a mid-conversation
 * refresh take their snapshot at different moments.
 */
function renderInventory(lead: string, index: string): string {
    const INVENTORY_GUIDANCE = `Use tool search to load the ones you need.`;

    return `
# External Tools
${lead} ${INVENTORY_GUIDANCE}

<connected_tools>
${index}
</connected_tools>`;
}

/**
 * Name-only inventory of every connected MCP tool, for the system prompt.
 *
 * Tool schemas are hidden from context once deferral engages, and on the
 * provider-executed path (see applyProviderToolSearch) the model is given a
 * search tool with no index at all. Without this the model can search, get
 * results ranked and truncated by the provider, and conclude from their absence
 * that a connected capability does not exist. The inventory is the standing
 * contradiction to that inference, so both deferral paths emit it.
 *
 * Below the threshold it emits nothing: every schema is already in context and
 * the app-side path advertises no search tool, so an index promising hidden
 * schemas would cost tokens to point at a tool that does not exist.
 */
export function buildMcpInventoryForPrompt(mcpTools: ToolDefinition[]): string {
    if (!shouldDeferMcpTools(mcpTools)) {
        return '';
    }
    return renderInventory(
        'These external (MCP) tools were connected on conversation start.',
        buildToolIndex(mcpTools),
    );
}

export interface InventoryStep {
    source: string;
    message?: string;
    extra?: Record<string, unknown>;
}

/** Tool index a system prompt or inventory step carried, if it carried one */
function extractToolIndex(text: string): string | undefined {
    return text.match(CONNECTED_TOOLS_BLOCK)?.[1];
}

/** Namespaced tool names in a rendered index, for diffing one index against another */
function parseToolIndex(index: string): string[] {
    return index.split('\n').flatMap(line => {
        const match = line.match(/^- ([^:]+): (.+)$/);
        if (!match) return [];
        const [, server, names] = match;
        return names!.split(', ').map(name => `${server}__${name}`);
    });
}

/** Carried on an inventory step so the next turn can diff against what it announced */
function mcpInventoryExtra(index: string): Record<string, unknown> {
    return { kind: MCP_INVENTORY_KIND, [MCP_TOOLS_KEY]: index };
}

/**
 * The tool index this conversation has been told about: the one frozen into its
 * system prompt, then any refresh appended since.
 *
 * Derived from the steps rather than tracked alongside them, so it cannot drift
 * from what the model actually has in context. A refresh dropped by compaction
 * makes its tools eligible to be announced again, and the state survives a server
 * restart because it lives in the trajectory the model reads.
 */
export function mcpInventoryState(steps: InventoryStep[]): string | undefined {
    let shown: string | undefined;

    for (const step of steps) {
        if (step.source !== 'system') continue;

        const announced = step.extra?.[MCP_TOOLS_KEY];
        if (typeof announced === 'string') {
            shown = announced;
            continue;
        }

        const listed = extractToolIndex(step.message ?? '');
        if (listed !== undefined) {
            shown = listed;
        }
    }

    return shown;
}

/**
 * Describe how the connected tool set changed since this conversation last saw it.
 *
 * Both sides are rendered indexes, and the set diff rather than the string
 * comparison decides: MCP servers are iterated in connection order, so the same
 * tools can render in a different order between runs. String equality is only the
 * fast path out.
 */
function formatMcpInventoryUpdate(shownIndex: string, currentIndex: string): string | undefined {
    if (shownIndex === currentIndex) {
        return undefined;
    }

    const shown = new Set(parseToolIndex(shownIndex));
    const current = new Set(parseToolIndex(currentIndex));
    const added = [...current].filter(name => !shown.has(name));
    const removed = [...shown].filter(name => !current.has(name));

    if (!added.length && !removed.length) {
        return undefined;
    }

    const sections = ['# External Tools changed'];
    if (added.length) {
        sections.push(`Connected:\n${buildToolIndex(added.map(name => ({ name })))}`);
    }
    if (removed.length) {
        sections.push(`Disconnected:\n${buildToolIndex(removed.map(name => ({ name })))}`);
    }
    return sections.join('\n\n');
}

/**
 * System steps that bring a continuing conversation's tool inventory up to date.
 *
 * The initial system prompt is written once per conversation and never rewritten,
 * while the tool list is rebuilt every iteration. Appending keeps the cached prompt
 * prefix intact and the timeline consistent, which rewriting the prompt would not.
 */
export function resolveMcpInventoryContext(args: {
    steps: InventoryStep[];
    mcpTools: ToolDefinition[];
    isNewConversation: boolean;
}): { systemSteps: Array<{ message: string; extra: Record<string, unknown> }> } {
    const { steps, mcpTools, isNewConversation } = args;

    // A new conversation's prompt is built from the current tool set, so it is current
    // by construction, and a refresh now would only duplicate it
    if (isNewConversation) {
        return { systemSteps: [] };
    }

    const currentIndex = buildToolIndex(mcpTools);
    const shownIndex = mcpInventoryState(steps);

    // Started below the threshold, so there is no inventory to bring up to date.
    // One is owed only once deferral engages and schemas actually leave context.
    if (shownIndex === undefined) {
        if (!shouldDeferMcpTools(mcpTools)) {
            return { systemSteps: [] };
        }
        return {
            systemSteps: [{
                message: renderInventory(
                    'These external (MCP) tools are now connected.',
                    currentIndex,
                ),
                extra: mcpInventoryExtra(currentIndex),
            }],
        };
    }

    // Deliberately not gated on the threshold. Dropping back below it leaves the
    // prompt's inventory in context, still advertising tools that are now gone.
    const update = formatMcpInventoryUpdate(shownIndex, currentIndex);
    return {
        systemSteps: update ? [{ message: update, extra: mcpInventoryExtra(currentIndex) }] : [],
    };
}

/**
 * Build the search_tools ToolDefinition. The discoverable-tool index lives in
 * the system prompt (buildMcpInventoryForPrompt) rather than here, so the model
 * sees it on every path and pays for it once.
 */
export function buildSearchToolsDefinition(): ToolDefinition {
    return {
        name: SEARCH_TOOLS_TOOL_NAME,
        description: `Search the catalog of connected external (MCP) tools and load the ones you need.

Most external tools are not given to you upfront to keep your context lean. Search by regular expression to load their full definitions; matched tools become available to call from your next step onwards.

The External Tools section of your context lists every discoverable tool by server. Search by server name to load a whole server's tools.`,
        schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Regular expression matched case-insensitively against tool names and descriptions. Examples: "issue" substring, "create_.*_issue" wildcard, "issue|ticket|bug" alternation.',
                },
                server: {
                    type: 'string',
                    description: 'Optional. Restrict the search to tools from this server.',
                },
            },
            required: ['query'],
        },
    };
}

/**
 * Relevance tiers, most relevant first. A match on what a tool *is* (its server,
 * its name) outranks a match on prose about it. Parameter-schema text matches
 * last: it is where boilerplate like "Request message for CreateEvent" lives, so
 * it earns recall but must never displace an identity match.
 */
const enum Rank {
    ExactName,
    ServerName,
    ToolName,
    Description,
    SchemaText,
}

/** Rank a tool against the search pattern, or null when it does not match at all */
function rankTool(tool: ToolDefinition, regex: RegExp, exactRegex: RegExp): Rank | null {
    const parsed = parseNamespacedToolName(tool.name);
    const bareName = parsed?.toolName ?? tool.name;

    if (exactRegex.test(bareName) || exactRegex.test(tool.name)) return Rank.ExactName;
    if (parsed && regex.test(parsed.serverName)) return Rank.ServerName;
    if (regex.test(tool.name)) return Rank.ToolName;
    if (tool.description && regex.test(tool.description)) return Rank.Description;
    if (regex.test(JSON.stringify(tool.schema ?? {}))) return Rank.SchemaText;
    return null;
}

/** Count hidden matches per server, to name what the result limit cut off */
function summarizeHidden(hidden: ToolDefinition[]): string {
    const counts = new Map<string, number>();
    for (const tool of hidden) {
        const server = parseNamespacedToolName(tool.name)?.serverName ?? 'other';
        counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    return Array.from(counts.entries())
        .map(([server, count]) => `${server} (${count})`)
        .join(', ');
}

/**
 * Regex search over MCP tool names, descriptions and parameter schemas, ranked
 * by relevance so the result limit drops the least relevant matches rather than
 * whichever tools happen to be registered last.
 */
export function searchTools(args: SearchToolsArgs, mcpTools: ToolDefinition[]): SearchToolsResult {
    const empty = { matches: [], totalMatches: 0, truncated: false };
    const pattern = (args.query ?? '').trim();
    if (!pattern) {
        return { ...empty, compiled: 'No search pattern provided. Pass a regular expression to match against tool names and descriptions.' };
    }
    if (pattern.length > MAX_PATTERN_CHARS) {
        return { ...empty, compiled: `Search pattern exceeds ${MAX_PATTERN_CHARS} characters. Use a shorter regular expression.` };
    }

    let regex: RegExp;
    let exactRegex: RegExp;
    try {
        regex = new RegExp(pattern, 'i');
        exactRegex = new RegExp(`^(?:${pattern})$`, 'i');
    } catch (error) {
        return {
            ...empty,
            compiled: `Invalid regular expression "${pattern}": ${error instanceof Error ? error.message : String(error)}. Fix the pattern and search again.`,
        };
    }

    const candidates = args.server
        ? mcpTools.filter(t => parseNamespacedToolName(t.name)?.serverName === args.server)
        : mcpTools;

    // Stable sort keeps registration order within a tier
    const ranked = candidates
        .map(tool => ({ tool, rank: rankTool(tool, regex, exactRegex) }))
        .filter((entry): entry is { tool: ToolDefinition; rank: Rank } => entry.rank !== null)
        .sort((a, b) => a.rank - b.rank)
        .map(entry => entry.tool);

    if (ranked.length === 0) {
        const scope = args.server ? ` on server "${args.server}"` : '';
        return {
            ...empty,
            compiled: `No tools matched /${args.query}/i${scope}. Try a broader pattern, or search a server name from the External Tools section of your context.`,
        };
    }

    const matches = ranked.slice(0, MAX_SEARCH_RESULTS);
    const hidden = ranked.slice(MAX_SEARCH_RESULTS);

    const listing = matches
        .map(tool => {
            const description = (tool.description ?? '').slice(0, MAX_RESULT_DESCRIPTION_CHARS);
            return `- ${tool.name}: ${description}`;
        })
        .join('\n');

    const header = hidden.length > 0
        ? `Found ${ranked.length} matching tool(s), showing the ${matches.length} most relevant:`
        : `Found ${ranked.length} matching tool(s):`;
    const truncationNote = hidden.length > 0
        ? `\n\n${hidden.length} more matched but were not shown, on: ${summarizeHidden(hidden)}. Narrow the pattern or pass "server" to see them.`
        : '';

    return {
        compiled: `${header}\n${listing}${truncationNote}\n\nThese tools are now loaded and available to call from your next step.`,
        matches,
        totalMatches: ranked.length,
        truncated: hidden.length > 0,
    };
}

/**
 * Provider-executed variant of tool deferral for models that support tool
 * search (OpenAI gpt-5.4+, Anthropic Claude via platform translation): all MCP
 * tools are sent marked defer_loading alongside a provider-native tool_search
 * tool. The provider hides deferred schemas from model context, executes
 * searches server-side (no app round-trip), and injects matches at the end of
 * context — deferral state rides in the conversation's raw item history.
 *
 * With `namespaced` (models with tool search over the OpenAI Responses API),
 * each MCP server becomes a namespace tool holding its tools as deferred
 * children, per the OpenAI tool search guidance — the model sees server names
 * and descriptions upfront and can load a whole server via one search. The
 * model then calls tools with a bare name plus a separate namespace field;
 * getFunctionCallName() rejoins them into the server__tool convention.
 */
export function applyProviderToolSearch(
    mcpTools: ToolDefinition[],
    options: { namespaced?: boolean; serverDescriptions?: Map<string, string> } = {}
): ToolDefinition[] {
    if (!shouldDeferMcpTools(mcpTools)) {
        return mcpTools;
    }
    const searchTool: ToolDefinition = { name: 'tool_search', type: 'tool_search', schema: {} };
    if (!options.namespaced) {
        return [searchTool, ...mcpTools.map(tool => ({ ...tool, deferLoading: true }))];
    }

    // One namespace per MCP server; tools without a server prefix stay flat
    const byServer = new Map<string, ToolDefinition[]>();
    const flatTools: ToolDefinition[] = [];
    for (const tool of mcpTools) {
        const parsed = parseNamespacedToolName(tool.name);
        if (!parsed) {
            flatTools.push({ ...tool, deferLoading: true });
            continue;
        }
        const children = byServer.get(parsed.serverName) ?? [];
        children.push({
            name: parsed.toolName,
            // The [MCP: server] prefix is redundant inside the server's namespace
            description: tool.description?.replace(`[MCP: ${parsed.serverName}] `, ''),
            schema: tool.schema,
            deferLoading: true,
        });
        byServer.set(parsed.serverName, children);
    }

    const namespaces = Array.from(byServer.entries()).map(([server, tools]): ToolDefinition => ({
        type: 'namespace',
        name: server,
        description: options.serverDescriptions?.get(server) ?? `Tools provided by the ${server} MCP server.`,
        schema: {},
        tools,
    }));

    return [searchTool, ...namespaces, ...flatTools];
}

/**
 * Replace the full MCP tool list with the search_tools definition plus any
 * already-loaded tools. Below the threshold all tools pass through unchanged
 * and no search tool is advertised.
 */
export function applyToolDeferral(
    mcpTools: ToolDefinition[],
    loadedToolNames: Set<string>
): ToolDefinition[] {
    if (!shouldDeferMcpTools(mcpTools)) {
        return mcpTools;
    }
    const loaded = mcpTools.filter(t => loadedToolNames.has(t.name));
    return [buildSearchToolsDefinition(), ...loaded];
}
