import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import { NotificationSettings, PushSubscription } from '../../src/server/db/schema';
import type {
    ConfirmationOption,
    ConfirmationRequest,
    ConfirmationResponse,
} from '../../src/server/processor/confirmation/confirmation.types';
import { clearAllBuses, createRunHandle, getOrCreateBus } from '../../src/server/events/conversation-event-bus';

/**
 * Only the HTTP boundary is stubbed. Everything under test — payload construction, the
 * per-device loop, and what a delivery failure does to the stored subscription — is the
 * real module.
 */
type Delivery = { endpoint: string; payload: string; options: Record<string, unknown> };

const delivered: Delivery[] = [];
let rejectWith: Record<string, number> = {};

mock.module('web-push', () => ({
    default: {
        generateVAPIDKeys: () => ({ publicKey: 'test-public', privateKey: 'test-private' }),
        sendNotification: async (
            sub: { endpoint: string },
            payload: string,
            options: Record<string, unknown>,
        ) => {
            const status = rejectWith[sub.endpoint];
            if (status) throw Object.assign(new Error('push service refused'), { statusCode: status });
            delivered.push({ endpoint: sub.endpoint, payload, options });
        },
    },
}));

const { pushConfirmationRequest, pushRunComplete, __test__ } = await import('../../src/server/push');
const pushRoutes = (await import('../../src/server/routes/push')).default;

function confirmation(options: ConfirmationOption[], overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
    return {
        requestId: 'req-9',
        inputType: 'choice',
        title: 'Run rm -rf build/',
        operation: 'shell_command',
        options,
        ...overrides,
    };
}

const YES_NO: ConfirmationOption[] = [
    { id: 'yes', label: 'Yes' },
    { id: 'yes_dont_ask', label: "Yes, don't ask again", persistPreference: true },
    { id: 'no', label: 'No' },
];

const USER_ID = 7;
const PHONE = 'https://web.push.apple.com/phone';
const LAPTOP = 'https://fcm.googleapis.com/laptop';

let deletes = 0;
let notifiedStamps = 0;

function withDevices(...endpoints: string[]) {
    const rows = endpoints.map((endpoint, i) => ({
        id: i + 1,
        userId: USER_ID,
        endpoint,
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
        label: endpoint.includes('apple') ? 'iPhone' : 'Mac',
    }));

    globalThis.__pipaliUnitDb = {
        select: (table: unknown) => {
            if (table === NotificationSettings) {
                return Promise.resolve([{ vapidPublicKey: 'test-public', vapidPrivateKey: 'test-private' }]);
            }
            if (table === PushSubscription) return Promise.resolve(rows);
            return Promise.resolve([]);
        },
        update: (_table: unknown, values: unknown) => {
            if (values && typeof values === 'object' && 'lastNotifiedAt' in values) notifiedStamps++;
            return Promise.resolve([]);
        },
        delete: () => {
            deletes++;
            return Promise.resolve([]);
        },
    };
}

beforeEach(() => {
    delivered.length = 0;
    rejectWith = {};
    deletes = 0;
    notifiedStamps = 0;
});

afterEach(() => {
    globalThis.__pipaliUnitDb = undefined;
});

describe('delivering a push', () => {
    test('a confirmation carries the fields sw.js reads, marked urgent', async () => {
        withDevices(PHONE);

        await pushConfirmationRequest(USER_ID, confirmation(YES_NO), 'conv-1');

        expect(delivered).toHaveLength(1);
        // These four field names are a contract with the service worker's push handler;
        // renaming one here silently stops notifications rendering or tapping through.
        expect(JSON.parse(delivered[0]!.payload)).toEqual({
            title: 'Pipali needs your approval',
            body: 'Run rm -rf build/',
            conversationId: 'conv-1',
            tag: 'confirmation:req-9',
            requestId: 'req-9',
            actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
        });
        expect(delivered[0]!.options).toMatchObject({ urgency: 'high', TTL: 3600 });
        expect(notifiedStamps).toBe(1);
    });

    test('a completion is unurgent, held longer, and flattened to one line', async () => {
        withDevices(PHONE);

        await pushRunComplete(USER_ID, 'Wrote the report\n\nand  filed it', 'conv-2');

        const payload = JSON.parse(delivered[0]!.payload);
        expect(payload.body).toBe('Wrote the report and filed it');
        expect(payload.tag).toBe('complete:conv-2');
        expect(delivered[0]!.options).toMatchObject({ urgency: 'normal', TTL: 86_400 });
    });

    test('reaches every registered device', async () => {
        withDevices(PHONE, LAPTOP);

        await pushRunComplete(USER_ID, 'done', 'conv-3');

        expect(delivered.map(d => d.endpoint).sort()).toEqual([LAPTOP, PHONE].sort());
        expect(notifiedStamps).toBe(2);
    });
});

describe('when a push service refuses', () => {
    /**
     * The consequential half of the failure path: 410 means the browser threw the
     * subscription away, so keeping it would retry forever. Anything else is transient,
     * and deleting on it would silently unregister the user's phone the first time a push
     * service hiccups — with nothing in the UI to explain why notifications stopped.
     */
    test('410 removes that device and leaves the others alone', async () => {
        withDevices(PHONE, LAPTOP);
        rejectWith = { [PHONE]: 410 };

        await pushRunComplete(USER_ID, 'done', 'conv-4');

        expect(deletes).toBe(1);
        expect(delivered.map(d => d.endpoint)).toEqual([LAPTOP]);
        expect(notifiedStamps).toBe(1);
    });

    test('a transient failure keeps the device registered', async () => {
        withDevices(PHONE);
        rejectWith = { [PHONE]: 500 };

        await pushRunComplete(USER_ID, 'done', 'conv-5');

        expect(deletes).toBe(0);
        expect(notifiedStamps).toBe(0);
    });

    test('one dead device does not stop the run', async () => {
        withDevices(PHONE);
        rejectWith = { [PHONE]: 500 };

        // These fire from inside the run loop, so the promise must settle rather than reject.
        await expect(pushRunComplete(USER_ID, 'done', 'conv-6')).resolves.toBeUndefined();
    });
});

describe('buttons on a confirmation', () => {
    async function actionsFor(request: ConfirmationRequest) {
        withDevices(PHONE);
        await pushConfirmationRequest(USER_ID, request, 'conv-1');
        return JSON.parse(delivered[0]!.payload).actions;
    }

    test("offers an ask_user question's own answers, trimmed to fit a button", async () => {
        const actions = await actionsFor(confirmation([
            { id: 'postgres', label: 'Postgres' },
            { id: 'sqlite', label: 'SQLite, with the WAL journal enabled' },
        ]));

        expect(actions[0]).toEqual({ id: 'postgres', label: 'Postgres' });
        expect(actions[1].id).toBe('sqlite');
        expect(actions[1].label.length).toBeLessThanOrEqual(24);
    });

    test('shows at most the two a notification can fit', async () => {
        const actions = await actionsFor(confirmation([
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
            { id: 'c', label: 'C' },
        ]));

        expect(actions.map((a: { id: string }) => a.id)).toEqual(['a', 'b']);
    });

    /**
     * A button resolves the request outright, and free text is exactly what it cannot
     * carry. Options are present here so the input type is what decides, not their absence.
     */
    test('a free-text question gets none, even when it carries options', async () => {
        const request = confirmation([{ id: 'a', label: 'A' }], { inputType: 'text_input' });
        expect(await actionsFor(request)).toBeUndefined();
    });
});

/**
 * A notification is answered from a lock screen, where the only things to go on are the
 * line of text and the buttons. Both have to describe this question rather than the shape
 * of every question, or the tap lands on the wrong one.
 */
describe('what a confirmation says it is about', () => {
    async function bodyFor(request: ConfirmationRequest) {
        withDevices(PHONE);
        await pushConfirmationRequest(USER_ID, request, 'conv-1');
        return JSON.parse(delivered[0]!.payload).body;
    }

    /** Two of these can wait at once, and every one of them is titled the same. */
    test('a command confirmation carries the command', async () => {
        const body = await bodyFor(confirmation(YES_NO, {
            title: 'Confirm Command Execution',
            context: {
                toolName: 'shell_command',
                toolArgs: {},
                commandInfo: { command: 'git add -A', reason: 'stage the fix', workdir: '/repo' },
            },
        }));

        expect(body).toBe('git add -A');
    });

    test('a file confirmation carries the file', async () => {
        const body = await bodyFor(confirmation(YES_NO, {
            title: 'Confirm File Edit',
            context: { toolName: 'edit_file', toolArgs: {}, affectedFiles: ['/repo/src/index.ts'] },
        }));

        expect(body).toBe('Confirm File Edit: /repo/src/index.ts');
    });

    /**
     * Two buttons out of three read as the whole question, so the answer someone came for
     * looks absent rather than elsewhere - and the nearest button gets the tap instead.
     */
    test('counts the answers that did not fit as buttons', async () => {
        const body = await bodyFor(confirmation([
            { id: 'option_0', label: 'Looks done' },
            { id: 'option_1', label: 'Needs more time' },
            { id: 'option_2', label: 'Ask me in 5 min' },
        ], { title: 'Chicken check' }));

        expect(body).toBe('Chicken check\n+1 more in the app');
    });

    /** "Don't ask again" is withheld on purpose, so it is not an answer gone missing. */
    test('says nothing about an option it withheld by design', async () => {
        expect(await bodyFor(confirmation(YES_NO, { title: 'Run rm -rf build/' }))).toBe('Run rm -rf build/');
    });
});

describe('payload budget', () => {
    const { encodePayload, MAX_PAYLOAD_BYTES } = __test__;

    test('trims an oversized body without losing the fields that make the tap useful', () => {
        const encoded = encodePayload({
            title: 'Pipali finished',
            body: 'x'.repeat(10_000),
            conversationId: 'conv-1',
            tag: 'complete:conv-1',
        });

        expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
        expect(JSON.parse(encoded)).toMatchObject({ conversationId: 'conv-1', tag: 'complete:conv-1' });
    });

    /**
     * The trim slices by character while the budget is in bytes, so multi-byte text is the
     * case that overshoots if the loop treats length as a proxy for size. Safari rejects an
     * oversized payload outright, which reads as notifications simply never arriving.
     */
    test('respects the byte budget for multi-byte text', () => {
        for (const glyph of ['あ', '😀', 'é']) {
            const encoded = encodePayload({ title: 'Pipali finished', body: glyph.repeat(4_000) });
            expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
        }
    });
});

/**
 * The tap-to-answer path, driven through the real service worker.
 *
 * A wrong answer here is the most expensive bug this feature can have - it runs a command
 * someone declined - and it lives in the seam between three pieces: the buttons the server
 * offers, the notification sw.js builds from them, and the option the run is settled with.
 * So the worker is loaded from disk and driven rather than described, and the confirmation
 * is a real one waiting on a real bus.
 */
describe('answering from a notification', () => {
    /** Run the real sw.js against a fake service worker global. */
    async function serviceWorker() {
        const source = await Bun.file('src/client/sw.js').text();
        const listeners: Record<string, ((event: unknown) => void)[]> = {};
        const shown: { title: string; options: Record<string, any> }[] = [];
        const sent: { url: string; body: Record<string, unknown> }[] = [];
        let reply: { ok: boolean; status: number; body?: unknown } = { ok: true, status: 200, body: {} };

        const scope = {
            addEventListener: (type: string, fn: (event: unknown) => void) => { (listeners[type] ||= []).push(fn); },
            skipWaiting: () => {},
            clients: { claim: () => {}, matchAll: async () => [], openWindow: async () => {} },
            registration: {
                showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); },
            },
        };
        const fetchStub = async (url: string, init: { body: string }) => {
            sent.push({ url, body: JSON.parse(init.body) });
            return { ok: reply.ok, status: reply.status, json: async () => reply.body };
        };
        new Function('self', 'fetch', source)(scope, fetchStub);

        const settled: Promise<unknown>[] = [];
        const event = (extra: Record<string, unknown>) => ({
            waitUntil: (p: Promise<unknown>) => settled.push(Promise.resolve(p)),
            ...extra,
        });
        const drain = async () => { await Promise.all(settled.splice(0)); };

        return {
            shown,
            sent,
            answersWith(next: typeof reply) { reply = next; },
            async receivePush(payload: unknown) {
                for (const fn of listeners.push!) fn(event({ data: { json: () => payload } }));
                await drain();
            },
            /** Tap the button at this position, the way a thumb does - by what it says. */
            async tapButton(index: number) {
                const notification = shown[shown.length - 1]!.options;
                const button = notification.actions[index];
                for (const fn of listeners.notificationclick!) {
                    fn(event({
                        action: button.action,
                        notification: { close: () => {}, data: notification.data, actions: notification.actions },
                    }));
                }
                await drain();
                return button;
            },
        };
    }

    async function pushedPayload(request: ConfirmationRequest) {
        withDevices(PHONE);
        await pushConfirmationRequest(USER_ID, request, 'conv-1');
        return JSON.parse(delivered[0]!.payload);
    }

    /** The whole point of the feature: the run takes the answer that was under the finger. */
    test('the answer names the button that was tapped', async () => {
        const request = confirmation([
            { id: 'option_0', label: 'Looks done' },
            { id: 'option_1', label: 'Needs more time' },
            { id: 'option_2', label: 'Ask me in 5 min' },
        ], { title: 'Chicken check' });

        const sw = await serviceWorker();
        await sw.receivePush(await pushedPayload(request));

        const buttons = sw.shown[0]!.options.actions;
        expect(buttons).toEqual([
            { action: 'option_0', title: 'Looks done' },
            { action: 'option_1', title: 'Needs more time' },
        ]);

        sw.answersWith({ ok: true, status: 200, body: { ok: true, option: 'Looks done' } });
        await sw.tapButton(0);

        expect(sw.sent).toEqual([{
            url: '/api/push/confirm',
            body: { conversationId: 'conv-1', requestId: 'req-9', optionId: 'option_0' },
        }]);
    });

    /**
     * A tap that lands is worth a word back. Without one, the only way to find out which
     * answer a run took is to watch what it does next - which is how a mis-tap goes
     * unnoticed until the work is already done.
     */
    test('says what the run took, in place of the question', async () => {
        const sw = await serviceWorker();
        await sw.receivePush(await pushedPayload(confirmation(YES_NO)));

        sw.answersWith({ ok: true, status: 200, body: { ok: true, option: 'Yes' } });
        await sw.tapButton(0);

        const receipt = sw.shown[sw.shown.length - 1]!;
        expect(receipt.options.body).toBe('Answered: Yes');
        // Same tag as the question, so the receipt replaces it rather than piling on.
        expect(receipt.options.tag).toBe('confirmation:req-9');
    });

    test('a refused tap says so rather than leaving it looking answered', async () => {
        const sw = await serviceWorker();
        await sw.receivePush(await pushedPayload(confirmation(YES_NO)));

        sw.answersWith({ ok: false, status: 422 });
        await sw.tapButton(1);

        expect(sw.shown[sw.shown.length - 1]!.options.body).toBe('Open Pipali to answer this one.');
    });
});

/**
 * The server half of the same seam.
 *
 * The route is the only place that still knows both what was put on the lock screen and
 * what the run is waiting for, so it is where a tap for an answer that was never a button
 * has to stop. Everything here is the real route against a real bus; only delivery is
 * stubbed.
 */
describe('the confirm route', () => {
    const CONVERSATION = 'conv-confirm';
    let answered: ConfirmationResponse | undefined;
    let runHandle: ReturnType<typeof createRunHandle>;

    function waitingOn(request: ConfirmationRequest) {
        const bus = getOrCreateBus(CONVERSATION);
        runHandle = createRunHandle('run-1', 'msg-1', CONVERSATION);
        bus.activeRun = runHandle;
        runHandle.pendingConfirmations.set(request.requestId, {
            requestId: request.requestId,
            request,
            resolve: (response) => { answered = response; },
            reject: () => {},
        });
    }

    function tap(body: Record<string, string>) {
        return pushRoutes.request('/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: CONVERSATION, requestId: 'req-9', ...body }),
        });
    }

    beforeEach(() => {
        answered = undefined;
        clearAllBuses();
    });

    test('settles the run with the option whose button was tapped', async () => {
        waitingOn(confirmation(YES_NO));

        const response = await tap({ optionId: 'no' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, option: 'No' });
        expect(answered?.selectedOptionId).toBe('no');
    });

    /** "Don't ask again" never reaches a lock screen, so it cannot come back from one. */
    test('refuses an option the notification never offered, leaving it waiting', async () => {
        waitingOn(confirmation(YES_NO));

        const response = await tap({ optionId: 'yes_dont_ask' });

        expect(response.status).toBe(422);
        expect(answered).toBeUndefined();
        expect(runHandle.pendingConfirmations.size).toBe(1);
    });

    test('reports a question that is no longer waiting, rather than answering another', async () => {
        waitingOn(confirmation(YES_NO));
        runHandle.pendingConfirmations.clear();

        const response = await tap({ optionId: 'yes' });

        expect(response.status).toBe(409);
        expect(answered).toBeUndefined();
    });
});
