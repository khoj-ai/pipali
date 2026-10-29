/**
 * Sandbox permissions are the user's boundary around what Pipali may do unsupervised, so
 * Pipali does not get to move that boundary quietly. A change asked for anywhere other
 * than the settings UI - Pipali calling its own API is how this happens - is put to the
 * user first and applies only if they approve it.
 *
 * The ask is raised on a run, so it travels the paths confirmations already travel:
 * inline in the conversation, as a toast elsewhere, as a push notification, and recorded
 * for a routine nobody is watching.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SandboxConfig } from './config';
import { getSandboxConfig } from './index';
import { previewSandboxSettings } from './settings';
import {
    CONFIRMATION_OPTIONS,
    createPermissionChangeConfirmation,
    processConfirmationResponse,
} from '../processor/confirmation';
import { newestActiveRun } from '../events/conversation-event-bus';
import { resolveConfirmationOnBus } from '../routes/ws/confirmation-manager';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'sandbox-permissions' });

/**
 * How long the ask stays up when the caller is still connected.
 *
 * A confirmation answered after its run ends has nowhere to land, and this one does not
 * hold its run open the way a tool call does. Pipali's own deadline for a command is a
 * minute, so by then the answer has no one left to reach either way.
 */
const ANSWER_WINDOW_MS = 60_000;

/** The path and domain lists, worded as the change to them. */
const LIST_CHANGES: ReadonlyArray<{
    field: 'allowedDomains' | 'allowedWritePaths' | 'deniedWritePaths' | 'deniedReadPaths';
    added: string;
    removed: string;
}> = [
    { field: 'allowedDomains', added: 'Let commands reach', removed: 'Stop commands reaching' },
    { field: 'allowedWritePaths', added: 'Write without asking in', removed: 'Ask again before writing in' },
    { field: 'deniedWritePaths', added: 'Never write in', removed: 'Drop the block on writing in' },
    { field: 'deniedReadPaths', added: 'Ask before reading', removed: 'Read without asking' },
];

function missingFrom(items: string[], other: string[]): string[] {
    const present = new Set(other);
    return items.filter(item => !present.has(item));
}

/**
 * Where a path entry leads, home shown as ~, when that is not plain from how it is written:
 * it climbs with .. or passes through a link. Undefined for name patterns such as .env.
 */
function whereItLeads(entry: string): string | undefined {
    const home = os.homedir();
    const expanded = entry === '~' || /^~[\\/]/.test(entry) ? path.join(home, entry.slice(1)) : entry;
    if (!path.isAbsolute(expanded)) return undefined;
    const normalized = path.resolve(expanded);
    let resolved = normalized;
    try {
        // Resolving opens the path, which blocks on a pipe
        const stats = fs.statSync(normalized);
        if (stats.isDirectory() || stats.isFile()) resolved = fs.realpathSync(normalized);
    } catch {
        // Not there yet, so it leads where it says
    }
    if (resolved === normalized && !/(^|[\\/])\.\.?([\\/]|$)/.test(entry)) return undefined;
    if (resolved === home) return '~';
    return resolved.startsWith(home + path.sep) ? `~${resolved.slice(home.length)}` : resolved;
}

/** A list entry as the user should read it before approving it */
function describeEntry(field: typeof LIST_CHANGES[number]['field'], entry: string): string {
    if (field === 'allowedDomains') return entry === '*' ? '* (every domain)' : entry;
    const leadsTo = whereItLeads(entry);
    return leadsTo ? `${entry} (which is ${leadsTo})` : entry;
}

/**
 * What changes between two sandbox configurations, in the words of the change.
 * An empty list means the two allow exactly the same things.
 */
export function describeSandboxChanges(current: SandboxConfig, next: SandboxConfig): string[] {
    const lines: string[] = [];

    if (next.enabled !== current.enabled) {
        lines.push(next.enabled
            ? 'Run commands in the sandbox again'
            : 'Turn the sandbox off, so commands run unconfined');
    }

    for (const { field, added, removed } of LIST_CHANGES) {
        const gained = missingFrom(next[field], current[field]).map(entry => describeEntry(field, entry));
        const lost = missingFrom(current[field], next[field]).map(entry => describeEntry(field, entry));
        if (gained.length > 0) lines.push(`${added}: ${gained.join(', ')}`);
        if (lost.length > 0) lines.push(`${removed}: ${lost.join(', ')}`);
    }

    if (next.allowLocalBinding !== current.allowLocalBinding) {
        lines.push(next.allowLocalBinding
            ? 'Let commands open local network ports'
            : 'Stop commands opening local network ports');
    }

    return lines;
}

export type SandboxChangeDecision =
    /** Approved, or nothing in the request that changes what is allowed. */
    | { verdict: 'approved' }
    /** The user said no. */
    | { verdict: 'declined'; error: string }
    /** The ask went up and came back unanswered, or its run ended under it. */
    | { verdict: 'unanswered'; error: string }
    /** Nothing was running to ask from. */
    | { verdict: 'unreachable'; error: string }
    /** Approved, but the settings changed while the user decided. */
    | { verdict: 'outdated'; error: string };

/**
 * Put a sandbox settings change to the user and report what they said.
 *
 * @param signal Abort signal of the request asking for the change. When the caller gives
 *               up, the ask comes down with it rather than outliving what it was for.
 */
export async function confirmSandboxChange(
    update: Partial<SandboxConfig>,
    options: { signal?: AbortSignal } = {},
): Promise<SandboxChangeDecision> {
    const current = getSandboxConfig();
    const changes = describeSandboxChanges(current, previewSandboxSettings(current, update));
    if (changes.length === 0) return { verdict: 'approved' };

    const target = newestActiveRun();
    const confirmationContext = target?.run.confirmationContext;
    if (!target || !confirmationContext) {
        log.info({ changes }, 'Sandbox permission change had no run to ask from');
        return {
            verdict: 'unreachable',
            error: 'Changing sandbox permissions needs the user to approve the change. Nothing was running to ask them from, so the permissions are unchanged.',
        };
    }

    const { bus, run } = target;
    const request = createPermissionChangeConfirmation(changes);

    let withdrawn = false;
    const withdraw = (reason: string) => {
        if (!run.pendingConfirmations.has(request.requestId)) return;
        withdrawn = true;
        log.info({ requestId: request.requestId, reason }, 'Withdrew sandbox permission ask');
        resolveConfirmationOnBus(bus, run, {
            requestId: request.requestId,
            selectedOptionId: CONFIRMATION_OPTIONS.NO,
            timestamp: new Date().toISOString(),
        });
    };

    const expiry = setTimeout(() => withdraw('unanswered'), ANSWER_WINDOW_MS);
    const abandon = () => withdraw('caller gave up');
    options.signal?.addEventListener('abort', abandon, { once: true });

    try {
        const response = await confirmationContext.requestConfirmation(request);
        const result = processConfirmationResponse(response);
        if (result.approved) {
            // The request carries whole lists, so applying it over settings changed since
            // the ask would drop those changes
            if (JSON.stringify(getSandboxConfig()) !== JSON.stringify(current)) {
                return {
                    verdict: 'outdated',
                    error: 'The sandbox settings changed while the user was deciding. The permissions are unchanged.',
                };
            }
            log.info({ conversationId: bus.conversationId, changes }, 'Sandbox permission change approved');
            return { verdict: 'approved' };
        }
        if (withdrawn) {
            return { verdict: 'unanswered', error: 'The user did not answer. The sandbox permissions are unchanged.' };
        }
        return {
            verdict: 'declined',
            error: `${result.denialReason ?? 'The user declined the change.'} The sandbox permissions are unchanged.`,
        };
    } catch (error) {
        // The run was stopped or interrupted under the ask, taking the answer with it.
        log.info({ err: error, requestId: request.requestId }, 'Sandbox permission ask ended without an answer');
        return { verdict: 'unanswered', error: 'The ask ended without an answer. The sandbox permissions are unchanged.' };
    } finally {
        clearTimeout(expiry);
        options.signal?.removeEventListener('abort', abandon);
    }
}
