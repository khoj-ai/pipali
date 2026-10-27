/**
 * The capability a request needs to change what the sandbox allows.
 *
 * Commands Pipali runs can reach its API, and any header they can read they can send, so an
 * Origin proves nothing. This token lives only in the server's memory. The desktop app
 * learns it from the server's stdout, a pipe only the app reads and never logs, and hands it
 * to its own webview over Tauri IPC. It is in no environment, file or response.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { SETTINGS_TOKEN_HEADER } from '../../shared';

// The desktop app reads the token from the stdout line that starts with this
const ANNOUNCEMENT_PREFIX = 'pipali-settings-token:';

const settingsToken = randomBytes(32).toString('hex');

/** Hand the token to the desktop app, when it launched this server and asked for it. */
export function announceSettingsToken(): void {
    if (process.env.PIPALI_ANNOUNCE_SETTINGS_TOKEN === '1') {
        process.stdout.write(`${ANNOUNCEMENT_PREFIX}${settingsToken}\n`);
    }
}

/** Whether a request presents the settings token. */
export function hasSettingsToken(req: Request): boolean {
    const presented = Buffer.from(req.headers.get(SETTINGS_TOKEN_HEADER) ?? '');
    const expected = Buffer.from(settingsToken);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** The token, for tests that stand in for the desktop app. */
export function settingsTokenForTesting(): string {
    return settingsToken;
}
