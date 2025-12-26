import { test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { webSearch } from '../../src/server/processor/actor/search_web';

describe('webSearch', () => {
    const originalEnv = { ...process.env };
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // Reset environment
        process.env = { ...originalEnv };
        // Clear all search provider API keys to start fresh
        delete process.env.SERPER_DEV_API_KEY;
        delete process.env.EXA_API_KEY;
    });

    afterEach(() => {
        // Restore original env and clear spy
        process.env = originalEnv;
        fetchSpy?.mockRestore();
    });

    test('should return error when query is empty', async () => {
        const result = await webSearch({ query: '' });

        expect(result.compiled).toContain('Error');
        expect(result.compiled).toContain('required');
    });

    test('should return error when query is only whitespace', async () => {
        const result = await webSearch({ query: '   ' });

        expect(result.compiled).toContain('Error');
        expect(result.compiled).toContain('required');
    });

    test('should return appropriate message when no API key configured', async () => {
        // Ensure no API key is set
        delete process.env.EXA_API_KEY;

        const result = await webSearch({ query: 'test query' });

        // Should indicate that search provider is not configured
        expect(result.compiled).toContain('No search results found');
    });

    test('should format search results correctly when Exa returns data', async () => {
        // Mock successful Exa response
        process.env.EXA_API_KEY = 'test-api-key';

        fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                results: [
                    {
                        title: 'Test Result 1',
                        url: 'https://example.com/1',
                        highlights: ['This is a test snippet'],
                    },
                    {
                        title: 'Test Result 2',
                        url: 'https://example.com/2',
                        highlights: ['Another test snippet'],
                    },
                ],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        );

        const result = await webSearch({ query: 'test query' });

        expect(result.query).toContain('test query');
        expect(result.compiled).toContain('2 found');
        expect(result.compiled).toContain('Test Result 1');
        expect(result.compiled).toContain('https://example.com/1');
        expect(result.compiled).toContain('This is a test snippet');
        expect(result.compiled).toContain('Test Result 2');
    });

    test('should respect max_results parameter', async () => {
        process.env.EXA_API_KEY = 'test-api-key';

        let capturedPayload: any;
        const preconnect = (globalThis.fetch as typeof fetch).preconnect;
        const fetchImpl = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
                const [_url, options] = args;
                capturedPayload = JSON.parse(options?.body as string);
                return new Response(JSON.stringify({ results: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            { preconnect }
        ) satisfies typeof fetch;

        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

        await webSearch({ query: 'test', max_results: 5 });

        expect(capturedPayload.numResults).toBe(5);
    });

    test('should clamp max_results to valid range', async () => {
        process.env.EXA_API_KEY = 'test-api-key';

        let capturedPayload: any;
        const preconnect = (globalThis.fetch as typeof fetch).preconnect;
        const fetchImpl = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
                const [_url, options] = args;
                capturedPayload = JSON.parse(options?.body as string);
                return new Response(JSON.stringify({ results: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            { preconnect }
        ) satisfies typeof fetch;

        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

        // Test max limit (should be clamped to 20)
        await webSearch({ query: 'test', max_results: 100 });
        expect(capturedPayload.numResults).toBe(20);
    });

    test('should pass country_code to Exa', async () => {
        process.env.EXA_API_KEY = 'test-api-key';

        let capturedPayload: any;
        const preconnect = (globalThis.fetch as typeof fetch).preconnect;
        const fetchImpl = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
                const [_url, options] = args;
                capturedPayload = JSON.parse(options?.body as string);
                return new Response(JSON.stringify({ results: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            { preconnect }
        ) satisfies typeof fetch;

        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

        await webSearch({ query: 'test', country_code: 'GB' });

        expect(capturedPayload.userLocation).toBe('GB');
    });

    test('should handle Exa API error gracefully', async () => {
        process.env.EXA_API_KEY = 'test-api-key';

        fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('Internal Server Error', {
                status: 500,
            })
        );

        const result = await webSearch({ query: 'test query' });

        expect(result.compiled).toContain('No search results found');
    });

    test('should handle network errors gracefully', async () => {
        process.env.EXA_API_KEY = 'test-api-key';

        fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

        const result = await webSearch({ query: 'test query' });

        expect(result.compiled).toContain('No search results found');
    });

    test('should handle empty results from Exa', async () => {
        process.env.EXA_API_KEY = 'test-api-key';

        fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ results: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        );

        const result = await webSearch({ query: 'obscure query no results' });

        expect(result.compiled).toContain('No search results found');
    });

    test('should include search results in result object', async () => {
        process.env.EXA_API_KEY = 'test-api-key';

        fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                results: [
                    {
                        title: 'Result Title',
                        url: 'https://example.com',
                        highlights: ['Snippet text'],
                    },
                ],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        );

        const result = await webSearch({ query: 'test' });

        expect(result.compiled).toContain('Result Title');
        expect(result.compiled).toContain('https://example.com');
        expect(result.compiled).toContain('Snippet text');
    });

    test('should use correct Exa API endpoint', async () => {
        process.env.EXA_API_KEY = 'test-api-key';

        let capturedUrl: string | URL | Request = '';
        const preconnect = (globalThis.fetch as typeof fetch).preconnect;
        const fetchImpl = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
                const [url] = args;
                capturedUrl = url;
                return new Response(JSON.stringify({ results: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            { preconnect }
        ) satisfies typeof fetch;

        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

        await webSearch({ query: 'test' });

        expect(capturedUrl.toString()).toContain('api.exa.ai/search');
    });

    test('should use custom Exa API URL if provided', async () => {
        process.env.EXA_API_KEY = 'test-api-key';
        process.env.EXA_API_URL = 'https://custom-exa.example.com';

        let capturedUrl: string | URL | Request = '';
        const preconnect = (globalThis.fetch as typeof fetch).preconnect;
        const fetchImpl = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
                const [url] = args;
                capturedUrl = url;
                return new Response(JSON.stringify({ results: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            { preconnect }
        ) satisfies typeof fetch;

        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

        await webSearch({ query: 'test' });

        expect(capturedUrl.toString()).toContain('custom-exa.example.com/search');
    });

    // Serper-specific tests
    test('should format Serper search results correctly', async () => {
        process.env.SERPER_DEV_API_KEY = 'test-serper-key';

        fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                organic: [
                    {
                        title: 'Serper Result 1',
                        link: 'https://example.com/serper/1',
                        snippet: 'This is a Serper snippet',
                    },
                    {
                        title: 'Serper Result 2',
                        link: 'https://example.com/serper/2',
                        snippet: 'Another Serper snippet',
                    },
                ],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        );

        const result = await webSearch({ query: 'test serper' });

        expect(result.query).toContain('test serper');
        expect(result.compiled).toContain('2 found');
        expect(result.compiled).toContain('Serper Result 1');
        expect(result.compiled).toContain('https://example.com/serper/1');
    });

    test('should include Serper answerBox in results', async () => {
        process.env.SERPER_DEV_API_KEY = 'test-serper-key';

        fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                organic: [
                    {
                        title: 'Organic Result',
                        link: 'https://example.com/organic',
                        snippet: 'Organic snippet',
                    },
                ],
                answerBox: {
                    title: 'Featured Answer Title',
                    snippet: 'This is the featured answer',
                    link: 'https://example.com/answer',
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        );

        const result = await webSearch({ query: 'what is something' });

        expect(result.compiled).toContain('Featured Answer');
        expect(result.compiled).toContain('Featured Answer Title');
        expect(result.compiled).toContain('This is the featured answer');
    });

    test('should include Serper knowledgeGraph in results', async () => {
        process.env.SERPER_DEV_API_KEY = 'test-serper-key';

        fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({
                organic: [
                    {
                        title: 'Organic Result',
                        link: 'https://example.com/organic',
                        snippet: 'Organic snippet',
                    },
                ],
                knowledgeGraph: {
                    title: 'Albert Einstein',
                    type: 'Physicist',
                    description: 'German-born theoretical physicist',
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        );

        const result = await webSearch({ query: 'Albert Einstein' });

        expect(result.compiled).toContain('Albert Einstein');
        expect(result.compiled).toContain('Physicist');
    });

    test('should use correct Serper API endpoint', async () => {
        process.env.SERPER_DEV_API_KEY = 'test-serper-key';

        let capturedUrl: string | URL | Request = '';
        const preconnect = (globalThis.fetch as typeof fetch).preconnect;
        const fetchImpl = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
                const [url] = args;
                capturedUrl = url;
                return new Response(JSON.stringify({ organic: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            { preconnect }
        ) satisfies typeof fetch;

        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

        await webSearch({ query: 'test' });

        expect(capturedUrl.toString()).toContain('google.serper.dev/search');
    });

    test('should prefer Serper over Exa when both are configured', async () => {
        process.env.SERPER_DEV_API_KEY = 'test-serper-key';
        process.env.EXA_API_KEY = 'test-exa-key';

        let capturedUrl: string | URL | Request = '';
        const preconnect = (globalThis.fetch as typeof fetch).preconnect;
        const fetchImpl = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
                const [url] = args;
                capturedUrl = url;
                return new Response(JSON.stringify({
                    organic: [{ title: 'Result', link: 'https://example.com', snippet: 'Test' }],
                }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            { preconnect }
        ) satisfies typeof fetch;

        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

        await webSearch({ query: 'test' });

        // Serper should be tried first
        expect(capturedUrl.toString()).toContain('serper.dev');
    });

    test('should truncate long queries for Serper', async () => {
        process.env.SERPER_DEV_API_KEY = 'test-serper-key';

        let capturedPayload: any;
        const preconnect = (globalThis.fetch as typeof fetch).preconnect;
        const fetchImpl = Object.assign(
            async (...args: Parameters<typeof fetch>) => {
                const [_url, options] = args;
                capturedPayload = JSON.parse(options?.body as string);
                return new Response(JSON.stringify({ organic: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
            { preconnect }
        ) satisfies typeof fetch;

        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchImpl);

        // Create a query longer than 2048 characters
        const longQuery = 'a'.repeat(3000);
        await webSearch({ query: longQuery });

        // Should be truncated to 2048 characters
        expect(capturedPayload.q.length).toBe(2048);
    });
});
