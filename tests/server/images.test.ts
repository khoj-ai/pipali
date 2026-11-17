import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { randomBytes } from 'crypto';
import { research } from '../../src/server/processor/director';
import { IMAGE_OVER_REQUEST_BUDGET_NOTE, type ContentItem } from '../../src/server/processor/conversation/images';
import { generateChatmlMessagesWithContext } from '../../src/server/processor/conversation/utils';
import type { ATIFObservationResult, ATIFStep, ATIFTrajectory } from '../../src/server/processor/conversation/atif/atif.types';

/** Requests larger than this are rejected before the platform reads them */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

describe('images a tool returns', () => {
    const dir = path.join(os.tmpdir(), `pipali-images-test-${process.pid}`);
    const largePath = path.join(dir, 'large.png');
    const smallPath = path.join(dir, 'small.png');
    const small = randomBytes(1_000_000);

    beforeAll(async () => {
        await fs.mkdir(dir, { recursive: true });
        // view_file sends an image's bytes as they are, so any bytes of the right size will do
        await fs.writeFile(largePath, randomBytes(5_000_000));
        await fs.writeFile(smallPath, small);
    });

    afterAll(async () => {
        await fs.rm(largePath, { force: true });
        await fs.rm(smallPath, { force: true });
        await fs.rmdir(dir);
    });

    test('view_file leaves out an image too large to send, saying how large it is, and returns a smaller one', async () => {
        const previousMock = globalThis.__pipaliMockLLM;
        let modelCalls = 0;
        globalThis.__pipaliMockLLM = () => modelCalls++ === 0
            ? {
                raw: [largePath, smallPath].map((file, i) => ({
                    type: 'function_call' as const, id: `fc-${i}`, call_id: `call-${i}`, name: 'view_file', arguments: JSON.stringify({ path: file }),
                })),
            } as never
            : { message: 'Done.', raw: [] };

        const chatHistory: ATIFTrajectory = {
            schema_version: 'ATIF-v1.4',
            session_id: 'images-test',
            agent: { name: 'pipali', version: 'test', model_name: 'test' },
            steps: [{ step_id: 1, timestamp: new Date().toISOString(), source: 'user', message: 'look at these' }],
        };
        let results: ATIFObservationResult[] = [];
        try {
            for await (const iteration of research({ chatHistory, maxIterations: 3 })) {
                if (iteration.toolResults) results = iteration.toolResults;
            }
        } finally {
            globalThis.__pipaliMockLLM = previousMock;
        }

        const [large, smaller] = results.map(result => result.content as ContentItem[]);
        expect(large).toEqual([
            { type: 'text', text: expect.stringContaining(`Read image file: ${largePath}`) },
            { type: 'text', text: '[Image omitted: 5.0 MB is over the 4.5 MB limit for one image. View a smaller copy instead.]' },
        ]);
        expect(smaller![1]).toEqual({ type: 'image', source_type: 'base64', mime_type: 'image/png', data: small.toString('base64') });
    });
});

describe('images a request carries', () => {
    /** A conversation where each image, of the given base64 megabytes, was viewed in its own step */
    const conversation = (imageMegabytes: number[]): ATIFStep[] => [
        { step_id: 1, timestamp: new Date(0).toISOString(), source: 'user', message: 'look at these' },
        ...imageMegabytes.map((megabytes, i): ATIFStep => ({
            step_id: i + 2,
            timestamp: new Date(0).toISOString(),
            source: 'agent',
            tool_calls: [{ tool_call_id: `call-${i}`, function_name: 'view_file', arguments: { path: `/shots/${i}.png` } }],
            observation: {
                results: [{
                    source_call_id: `call-${i}`,
                    content: [
                        { type: 'text', text: `Read image file: /shots/${i}.png` },
                        { type: 'image', source_type: 'base64', mime_type: 'image/png', data: String(i % 10).repeat(megabytes * 1_000_000) },
                    ],
                }],
            },
        })),
    ];

    const request = (steps: ATIFStep[]) => generateChatmlMessagesWithContext('', steps, 'You are Pipali.');

    /** Whether each image of the conversation is sent, oldest first */
    const imagesSent = (steps: ATIFStep[]): boolean[] => request(steps)
        .filter((message: any) => message.type === 'function_call_output')
        .map((message: any) => message.output.some((part: any) => part.type === 'input_image'));

    test('stays within the request size limit when a conversation holds more images than fit', () => {
        // Images stored by a conversation that failed with 413: none over the limit, 37 MB together
        const steps = conversation([0.35, 2.84, 1.32, 11.55, 9.25, 11.67]);

        const messages = request(steps);

        expect(JSON.stringify(messages).length).toBeLessThan(MAX_REQUEST_BYTES);
        expect(imagesSent(steps)).toEqual([false, false, false, false, true, true]);
        const firstOutput = messages.find((message: any) => message.type === 'function_call_output') as any;
        expect(firstOutput.output).toEqual([
            { type: 'input_text', text: 'Read image file: /shots/0.png' },
            { type: 'input_text', text: IMAGE_OVER_REQUEST_BUDGET_NOTE },
        ]);
    });

    test('keeps sending the same earlier images as a full conversation grows, so its prompt cache holds', () => {
        const sizes = [3, 3, 3, 3, 3, 3, 3, 3, 3];
        const full = request(conversation(sizes));
        expect(imagesSent(conversation(sizes))).toEqual([false, false, false, false, false, true, true, true, true]);

        // Three more images fit the room made, so nothing sent before changes
        const grown = request(conversation([...sizes, 3, 3, 3]));

        expect(grown.slice(0, full.length)).toEqual(full);
        expect(JSON.stringify(grown).length).toBeLessThan(MAX_REQUEST_BYTES);
    });

    test('leaves out an image that alone is over the budget, and sends the ones after it', () => {
        expect(imagesSent(conversation([1, 30, 1]))).toEqual([false, false, true]);
    });
});
