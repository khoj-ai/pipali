import { readFile } from 'fs/promises';

/** What the mock LLM was handed, one line per request - see mock-preload. */
export type RequestRecord = {
    query: string;
    sessionId?: string;
    runId?: string;
    tail: { type?: string | null; role?: string; text: string };
    catalogue: string | null;
    userTurns: string[];
    systemUpdates: string[];
};

/** Every request the mock LLM was handed, oldest first */
export async function readRequests(): Promise<RequestRecord[]> {
    const path = process.env.TEST_REQUEST_LOG;
    if (!path) throw new Error('TEST_REQUEST_LOG not set - global-setup may not have run');
    const contents = await readFile(path, 'utf8').catch(() => '');
    return contents.split('\n').filter(Boolean).map(line => JSON.parse(line) as RequestRecord);
}

/** Requests from the most recent conversation that answered this prompt. */
export async function requestsFor(prompt: string): Promise<RequestRecord[]> {
    const records = (await readRequests()).filter(record => record.query === prompt);
    // A retried spec answers the same prompt again; only the last attempt is ours.
    const session = records.at(-1)?.sessionId;
    return records.filter(record => record.sessionId === session);
}

export function carriesUpdate(records: RequestRecord[], marker: string): boolean {
    return records.some(record => record.systemUpdates.some(update => update.includes(marker)));
}
