/**
 * An MCP server's `enabledTools` is a whitelist in which an empty list enables every tool.
 * The tool picker edits it as a Set under the same rule.
 */
export type EnabledTools = ReadonlySet<string>;

export function isToolEnabled(enabledTools: EnabledTools, tool: string): boolean {
    return enabledTools.size === 0 || enabledTools.has(tool);
}

export function countEnabledTools(enabledTools: EnabledTools, tools: readonly string[]): number {
    return tools.filter(tool => isToolEnabled(enabledTools, tool)).length;
}

/** Every tool enabled is the empty list, so tools the server adds later stay enabled. */
function toList(enabled: Set<string>, tools: readonly string[]): Set<string> {
    return enabled.size === tools.length ? new Set() : enabled;
}

/**
 * Flip one tool relative to what is effectively enabled, not relative to the raw list.
 * The last enabled tool cannot be disabled: the empty list means all, so a server with no
 * tools is turned off with the server toggle instead.
 */
export function toggleTool(enabledTools: EnabledTools, tools: readonly string[], tool: string): Set<string> {
    const next = new Set(tools.filter(name => isToolEnabled(enabledTools, name)));
    if (!next.delete(tool)) next.add(tool);
    if (next.size === 0) return new Set(enabledTools);
    return toList(next, tools);
}

/** Enable one tool and disable the rest, for narrowing a long list to a few tools. */
export function selectOnly(tools: readonly string[], tool: string): Set<string> {
    return toList(new Set([tool]), tools);
}
