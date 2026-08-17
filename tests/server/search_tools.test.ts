import { test, expect, describe } from 'bun:test';
import {
    searchTools,
    buildSearchToolsDefinition,
    buildMcpInventoryForPrompt,
    applyToolDeferral,
    applyProviderToolSearch,
    shouldDeferMcpTools,
    MCP_TOOL_DEFER_THRESHOLD,
    SEARCH_TOOLS_TOOL_NAME,
} from '../../src/server/processor/actor/search_tools';
import { toOpenaiTools, getFunctionCallName } from '../../src/server/processor/conversation/openai/utils';
import type { ToolDefinition } from '../../src/server/processor/conversation/conversation';

function makeTool(server: string, name: string, description: string): ToolDefinition {
    return {
        name: `${server}__${name}`,
        description: `[MCP: ${server}] ${description}`,
        schema: { type: 'object', properties: {} },
    };
}

const TOOLS: ToolDefinition[] = [
    makeTool('github', 'create_issue', 'Create a new issue in a GitHub repository'),
    makeTool('github', 'list_pull_requests', 'List pull requests in a repository'),
    makeTool('github', 'merge_pull_request', 'Merge an open pull request'),
    makeTool('linear', 'create_issue', 'Create a new issue in Linear'),
    makeTool('linear', 'search_issues', 'Search Linear issues by keyword'),
    makeTool('slack', 'send_message', 'Send a message to a Slack channel'),
];

/** TOOLS padded just past MCP_TOOL_DEFER_THRESHOLD, where deferral engages */
const DEFERRING_TOOLS: ToolDefinition[] = [
    ...TOOLS,
    ...Array.from({ length: MCP_TOOL_DEFER_THRESHOLD - TOOLS.length + 1 }, (_, i) =>
        makeTool('notion', `page_action_${i}`, `Notion page action ${i}`)
    ),
];

describe('searchTools', () => {
    test('matches tools by substring pattern in name', () => {
        const result = searchTools({ query: 'issue' }, TOOLS);
        const names = result.matches.map(t => t.name);
        expect(names).toContain('github__create_issue');
        expect(names).toContain('linear__create_issue');
        expect(names).toContain('linear__search_issues');
        expect(names).not.toContain('slack__send_message');
        expect(result.compiled).toContain('github__create_issue');
    });

    test('matches tools by pattern in description', () => {
        const result = searchTools({ query: 'channel' }, TOOLS);
        expect(result.matches.map(t => t.name)).toEqual(['slack__send_message']);
    });

    test('supports regex wildcards', () => {
        const result = searchTools({ query: 'merge.*request' }, TOOLS);
        expect(result.matches.map(t => t.name)).toEqual(['github__merge_pull_request']);
    });

    test('supports regex alternation', () => {
        const result = searchTools({ query: 'channel|merge' }, TOOLS);
        const names = result.matches.map(t => t.name);
        expect(names).toContain('slack__send_message');
        expect(names).toContain('github__merge_pull_request');
        expect(names).toHaveLength(2);
    });

    test('restricts search to a server when specified', () => {
        const result = searchTools({ query: 'issue', server: 'linear' }, TOOLS);
        const names = result.matches.map(t => t.name);
        expect(names).toContain('linear__create_issue');
        expect(names.every(n => n.startsWith('linear__'))).toBe(true);
    });

    test('is case-insensitive', () => {
        const result = searchTools({ query: 'SLACK' }, TOOLS);
        expect(result.matches.map(t => t.name)).toContain('slack__send_message');
    });

    test('reports invalid regex with the parse error', () => {
        const result = searchTools({ query: '(unclosed' }, TOOLS);
        expect(result.matches).toEqual([]);
        expect(result.compiled).toContain('Invalid regular expression');
    });

    test('rejects patterns over the length limit', () => {
        const result = searchTools({ query: 'a'.repeat(201) }, TOOLS);
        expect(result.matches).toEqual([]);
        expect(result.compiled).toContain('exceeds 200 characters');
    });

    test('reports no matches gracefully', () => {
        const result = searchTools({ query: 'quantum_teleportation' }, TOOLS);
        expect(result.matches).toEqual([]);
        expect(result.compiled).toContain('No tools matched');
    });

    test('handles empty query gracefully', () => {
        const result = searchTools({ query: '   ' }, TOOLS);
        expect(result.matches).toEqual([]);
        expect(result.compiled).toContain('No search pattern');
    });

    test('tells the model matched tools are now available', () => {
        const result = searchTools({ query: 'slack' }, TOOLS);
        expect(result.compiled).toContain('now loaded');
    });
});

describe('searchTools ranking', () => {
    function makeToolWithSchema(server: string, name: string, description: string, schema: object): ToolDefinition {
        return { name: `${server}__${name}`, description: `[MCP: ${server}] ${description}`, schema };
    }

    /**
     * The shape that makes ranking fail: two servers whose *parameter schemas*
     * mention a query word, outnumbering the one server whose name matches it.
     * That server is registered last, so order cannot be what rescues it.
     */
    const INCIDENT_TOOLS: ToolDefinition[] = [
        ...Array.from({ length: 17 }, (_, i) => makeToolWithSchema(
            'chrome-browser', `browser_action_${i}`,
            'Type text into a input, text area or content editable element',
            { type: 'object', properties: { text: { type: 'string', description: 'Request message for BrowserAction' } } },
        )),
        ...Array.from({ length: 8 }, (_, i) => makeToolWithSchema(
            'calendar', `calendar_action_${i}`,
            'Manage calendar events',
            { type: 'object', properties: { request: { type: 'string', description: 'Request message for CreateEvent' } } },
        )),
        ...['search_threads', 'get_thread', 'create_draft', 'list_drafts', 'list_labels',
            'label_thread', 'unlabel_thread', 'label_message', 'unlabel_message'
        ].map(name => makeToolWithSchema('mailbox', name, 'Work with mail threads and labels', { type: 'object', properties: {} })),
    ];

    test('ranks a server-name match above schema-text noise that outnumbers it', () => {
        const result = searchTools({ query: 'email|mail|inbox|message' }, INCIDENT_TOOLS);
        const names = result.matches.map(t => t.name);
        expect(names).toContain('mailbox__search_threads');
        expect(names).toContain('mailbox__create_draft');
        // Every mailbox tool ranks above the schema-text matches that displaced them
        expect(names.slice(0, 9).every(n => n.startsWith('mailbox__'))).toBe(true);
    });

    test('returns a whole server for a bare server-name query', () => {
        const result = searchTools({ query: 'mailbox' }, INCIDENT_TOOLS);
        expect(result.matches).toHaveLength(9);
        expect(result.matches.every(t => t.name.startsWith('mailbox__'))).toBe(true);
        expect(result.truncated).toBe(false);
    });

    test('reports the total, the number shown, and which servers were cut off', () => {
        const result = searchTools({ query: 'email|mail|inbox|message' }, INCIDENT_TOOLS);
        expect(result.totalMatches).toBe(34);
        expect(result.matches).toHaveLength(15);
        expect(result.truncated).toBe(true);
        expect(result.compiled).toContain('Found 34 matching tool(s), showing the 15 most relevant');
        expect(result.compiled).toContain('19 more matched but were not shown');
        expect(result.compiled).toContain('chrome-browser');
        expect(result.compiled).toContain('Narrow the pattern');
    });

    test('reports no truncation when every match fits', () => {
        const result = searchTools({ query: 'issue' }, TOOLS);
        expect(result.truncated).toBe(false);
        expect(result.totalMatches).toBe(result.matches.length);
        expect(result.compiled).not.toContain('not shown');
    });

    test('exact tool name outranks a description mentioning it', () => {
        const tools = [
            makeTool('wiki', 'search_docs', 'Prefer create_issue for filing bugs'),
            makeTool('github', 'create_issue', 'File a bug'),
        ];
        const result = searchTools({ query: 'create_issue' }, tools);
        expect(result.matches.map(t => t.name)).toEqual(['github__create_issue', 'wiki__search_docs']);
    });

    test('tool name outranks description text', () => {
        const tools = [
            makeTool('wiki', 'read_page', 'Read a page about pull requests'),
            makeTool('github', 'list_pull_requests', 'List them'),
        ];
        const result = searchTools({ query: 'pull_request' }, tools);
        expect(result.matches[0]?.name).toBe('github__list_pull_requests');
    });

    test('matches parameter schema text but ranks it last', () => {
        const tools = [
            makeToolWithSchema('calendar', 'create_event', 'Create an event',
                { type: 'object', properties: { body: { type: 'string', description: 'Request message for CreateEvent' } } }),
            makeTool('slack', 'send_message', 'Post to a channel'),
        ];
        const result = searchTools({ query: 'message' }, tools);
        // Schema-only match is found (recall) but never displaces the name match
        expect(result.matches.map(t => t.name)).toEqual(['slack__send_message', 'calendar__create_event']);
    });
});

describe('buildSearchToolsDefinition', () => {
    test('points at the inventory instead of duplicating it', () => {
        const definition = buildSearchToolsDefinition();
        expect(definition.name).toBe(SEARCH_TOOLS_TOOL_NAME);
        expect(definition.description).toContain('External Tools');
        expect(definition.description).not.toContain('- github:');
        expect(definition.schema.required).toEqual(['query']);
    });
});

describe('buildMcpInventoryForPrompt', () => {
    test('indexes tool names grouped by server', () => {
        const inventory = buildMcpInventoryForPrompt(DEFERRING_TOOLS);
        expect(inventory).toContain('- github: create_issue, list_pull_requests, merge_pull_request');
        expect(inventory).toContain('- linear: create_issue, search_issues');
        expect(inventory).toContain('- slack: send_message');
    });

    test('tells the model a listed tool exists even when search misses it', () => {
        expect(buildMcpInventoryForPrompt(DEFERRING_TOOLS)).toContain('exists even if a search does not return it');
    });

    test('is empty when no MCP tools are connected', () => {
        expect(buildMcpInventoryForPrompt([])).toBe('');
    });

    /**
     * Below the threshold every tool schema is already in context and
     * applyToolDeferral advertises no search tool, so an inventory promising
     * hidden schemas would spend tokens pointing at a tool that does not exist.
     */
    test('is empty below the deferral threshold, where nothing is hidden and no search tool exists', () => {
        expect(applyToolDeferral(TOOLS, new Set())).toEqual(TOOLS);
        expect(buildMcpInventoryForPrompt(TOOLS)).toBe('');
    });

    test('carries names only, never schemas or descriptions', () => {
        const inventory = buildMcpInventoryForPrompt(DEFERRING_TOOLS);
        expect(inventory).not.toContain('Create a new issue in a GitHub repository');
        expect(inventory).not.toContain('properties');
    });

    /**
     * Guards the token cost of the inventory, which every request above the
     * threshold pays. Measured with o200k_base: an 81-token fixed preamble plus
     * ~3.5 tokens per tool at realistic name lengths, so ~360 tokens for an
     * 80-tool install. The marginal cost below is in characters, which tracks
     * tokens closely here and needs no tokenizer dependency.
     */
    test('stays compact as installs grow', () => {
        const install = (count: number) => Array.from({ length: count }, (_, i) =>
            makeTool(`server-${i % 4}`, `list_calendar_events_${i}`, `Description of tool ${i} that must not be indexed`)
        );
        const perTool = (buildMcpInventoryForPrompt(install(120)).length - buildMcpInventoryForPrompt(install(60)).length) / 60;
        expect(perTool).toBeLessThan(30);
    });
});

describe('shouldDeferMcpTools', () => {
    const atThreshold = Array.from({ length: MCP_TOOL_DEFER_THRESHOLD }, (_, i) =>
        makeTool('server', `tool_${i}`, `Tool number ${i}`)
    );
    const overThreshold = [...atThreshold, makeTool('server', 'one_more', 'One more tool')];

    /**
     * The prompt inventory and both search paths must turn on at the same count.
     * They drifted once — the inventory was unconditional while deferral was
     * not — and the prompt told users below the threshold that their schemas
     * were hidden behind a search_tools that had never been advertised.
     */
    test('gates the inventory and both search paths at the same count', () => {
        expect(shouldDeferMcpTools(atThreshold)).toBe(false);
        expect(buildMcpInventoryForPrompt(atThreshold)).toBe('');
        expect(applyToolDeferral(atThreshold, new Set())).toEqual(atThreshold);
        expect(applyProviderToolSearch(atThreshold)).toEqual(atThreshold);

        expect(shouldDeferMcpTools(overThreshold)).toBe(true);
        expect(buildMcpInventoryForPrompt(overThreshold)).toContain('<connected_tools>');
        expect(applyToolDeferral(overThreshold, new Set())[0]?.name).toBe(SEARCH_TOOLS_TOOL_NAME);
        expect(applyProviderToolSearch(overThreshold)[0]?.type).toBe('tool_search');
    });
});

describe('applyToolDeferral', () => {
    const manyTools = Array.from({ length: MCP_TOOL_DEFER_THRESHOLD + 5 }, (_, i) =>
        makeTool('server', `tool_${i}`, `Tool number ${i}`)
    );

    test('passes all tools through below the threshold', () => {
        const few = TOOLS.slice(0, 3);
        const result = applyToolDeferral(few, new Set());
        expect(result).toEqual(few);
        expect(result.some(t => t.name === SEARCH_TOOLS_TOOL_NAME)).toBe(false);
    });

    test('defers all tools behind search_tools above the threshold', () => {
        const result = applyToolDeferral(manyTools, new Set());
        expect(result).toHaveLength(1);
        expect(result[0]?.name).toBe(SEARCH_TOOLS_TOOL_NAME);
    });

    test('advertises loaded tools alongside search_tools', () => {
        const loaded = new Set(['server__tool_3', 'server__tool_7']);
        const result = applyToolDeferral(manyTools, loaded);
        expect(result.map(t => t.name)).toEqual([SEARCH_TOOLS_TOOL_NAME, 'server__tool_3', 'server__tool_7']);
    });

    test('provider: passes all tools through below the threshold', () => {
        const few = TOOLS.slice(0, 3);
        expect(applyProviderToolSearch(few)).toEqual(few);
        expect(applyProviderToolSearch(few, { namespaced: true })).toEqual(few);
    });

    test('provider: defers all tools with a provider tool_search entry above the threshold', () => {
        const result = applyProviderToolSearch(manyTools);
        expect(result[0]?.type).toBe('tool_search');
        expect(result).toHaveLength(manyTools.length + 1);
        expect(result.slice(1).every(t => t.deferLoading === true)).toBe(true);
    });

    test('provider namespaced: groups tools into one namespace per server', () => {
        const multiServer = [
            ...Array.from({ length: MCP_TOOL_DEFER_THRESHOLD }, (_, i) => makeTool('github', `tool_${i}`, `GitHub tool ${i}`)),
            makeTool('slack', 'send_message', 'Send a message to a Slack channel'),
        ];
        const result = applyProviderToolSearch(multiServer, {
            namespaced: true,
            serverDescriptions: new Map([['github', 'Manage GitHub repositories, issues and pull requests.']]),
        });

        expect(result[0]?.type).toBe('tool_search');
        const namespaces = result.filter(t => t.type === 'namespace');
        expect(namespaces.map(n => n.name)).toEqual(['github', 'slack']);
        // Configured server description is used; servers without one get a generic fallback
        expect(namespaces[0]?.description).toBe('Manage GitHub repositories, issues and pull requests.');
        expect(namespaces[1]?.description).toBe('Tools provided by the slack MCP server.');

        const github = namespaces[0]!;
        expect(github.tools).toHaveLength(MCP_TOOL_DEFER_THRESHOLD);
        // Children carry bare names, deferred schemas, and no redundant server prefix
        expect(github.tools?.[0]).toMatchObject({ name: 'tool_0', deferLoading: true, description: 'GitHub tool 0' });
        // Namespaces themselves are not deferred
        expect(namespaces.every(n => n.deferLoading === undefined)).toBe(true);
    });

    test('keeps the search_tools description stable as tools are loaded, for cache reuse', () => {
        const before = applyToolDeferral(manyTools, new Set())[0]?.description;
        const after = applyToolDeferral(manyTools, new Set(['server__tool_3']))[0]?.description;
        expect(before).toBeDefined();
        expect(after).toBe(before!);
    });
});

describe('toOpenaiTools provider tool search mapping', () => {
    test('maps tool_search type to a provider tool_search tool', () => {
        const [mapped] = toOpenaiTools([{ name: 'tool_search', type: 'tool_search', schema: {} }]) ?? [];
        expect(mapped).toEqual({ type: 'tool_search' });
    });

    test('maps deferLoading to defer_loading on function tools', () => {
        const tool = makeTool('github', 'create_issue', 'Create an issue');
        const [mapped] = toOpenaiTools([{ ...tool, deferLoading: true }]) ?? [];
        expect(mapped).toMatchObject({ type: 'function', name: tool.name, defer_loading: true });
    });

    test('omits defer_loading on regular function tools', () => {
        const [mapped] = toOpenaiTools([makeTool('github', 'create_issue', 'Create an issue')]) ?? [];
        expect(mapped).toMatchObject({ type: 'function' });
        expect(mapped && 'defer_loading' in mapped).toBe(false);
    });

    test('maps namespace definitions with deferred children', () => {
        const [mapped] = toOpenaiTools([{
            type: 'namespace',
            name: 'github',
            description: 'Tools provided by the github MCP server.',
            schema: {},
            tools: [{ name: 'create_issue', description: 'Create an issue', schema: { type: 'object' }, deferLoading: true }],
        }]) ?? [];
        expect(mapped).toEqual({
            type: 'namespace',
            name: 'github',
            description: 'Tools provided by the github MCP server.',
            tools: [{
                type: 'function',
                name: 'create_issue',
                description: 'Create an issue',
                parameters: { type: 'object' },
                defer_loading: true,
            }],
        });
    });
});

describe('getFunctionCallName', () => {
    test('rejoins namespaced calls into the server__tool convention', () => {
        expect(getFunctionCallName({ name: 'create_issue', namespace: 'github' })).toBe('github__create_issue');
    });

    test('passes plain calls through unchanged', () => {
        expect(getFunctionCallName({ name: 'search_web' })).toBe('search_web');
        expect(getFunctionCallName({ name: 'github__create_issue', namespace: null })).toBe('github__create_issue');
    });
});
