import OpenAI from 'openai';
import type { Responses } from 'openai/resources/responses/responses';
import type { ChatMessage, LlmStreamEvent, ResponseWithThought, ToolDefinition, UsageMetrics } from '../conversation';
import { toOpenaiTools, getReasoningText, getFunctionCallName } from './utils';
import { calculateCost, type PricingConfig } from '../costs';
import { createChildLogger } from '../../../logger';
import { getClientHeaders } from '../../../http/client-info';

const log = createChildLogger({ component: 'llm' });

export async function sendMessageToGpt(
    messages: ChatMessage[],
    model: string,
    apiKey?: string,
    apiBaseUrl?: string | null,
    tools?: ToolDefinition[],
    toolChoice: string = 'auto',
    pricing?: PricingConfig,
    conversationId?: string,
    runId?: string,
    onStreamEvent?: (event: LlmStreamEvent) => void,
): Promise<ResponseWithThought> {
    const openaiTools = toOpenaiTools(tools);

    const client = new OpenAI({
        apiKey: apiKey,
        baseURL: apiBaseUrl ?? undefined,
        defaultHeaders: getClientHeaders(),
    });

    // Build metadata to trace message provenance
    const tracer = {
        ...(conversationId && { conversation_id: conversationId }),
        ...(runId && { run_id: runId }),
    };

    // Use streaming to avoid timeout issues
    const stream = client.responses.stream({
        model: model,
        input: messages,
        tools: openaiTools,
        tool_choice: openaiTools ? toolChoice as Responses.ToolChoiceOptions : undefined,
        ...(Object.keys(tracer).length > 0 && { metadata: tracer }),
    });

    if (onStreamEvent) {
        // Keyed by output item id, so argument chunks can be attributed to a call
        const streamedToolCalls = new Map<string, { callId: string; name: string; argChars: number }>();

        stream.on('response.output_text.delta', (event) => {
            onStreamEvent({ kind: 'text', delta: event.delta });
        });

        stream.on('response.reasoning_summary_text.delta', (event) => {
            onStreamEvent({ kind: 'reasoning', delta: event.delta });
        });

        // Cast: a namespaced tool call carries a `namespace` the SDK's type omits
        stream.on('response.output_item.added', (event) => {
            const item = event.item as any;
            if (item.type !== 'function_call') return;
            // The two ids differ on OpenAI proper (fc_… vs call_…): argument chunks
            // arrive keyed by the item id, while the app routes calls by call_id
            const itemId = item.id ?? item.call_id;
            if (!itemId) return;
            const call = { callId: item.call_id ?? itemId, name: getFunctionCallName(item), argChars: 0 };
            streamedToolCalls.set(itemId, call);
            onStreamEvent({ kind: 'tool_call', ...call });
        });

        stream.on('response.function_call_arguments.delta', (event) => {
            const call = streamedToolCalls.get(event.item_id);
            if (!call) return;
            call.argChars += event.delta.length;
            onStreamEvent({ kind: 'tool_call', ...call });
        });
    }

    const response = await stream.finalResponse();

    if (!response) {
        throw new Error('No response received from model');
    }

    // Models that think between tool calls emit several reasoning items; join
    // them so the persisted thought matches what streamed.
    const thought = (response.output as Responses.ResponseOutputItem[])
        .filter((item): item is Responses.ResponseReasoningItem => item.type === 'reasoning')
        .map(getReasoningText)
        .filter((text): text is string => !!text)
        .join('\n\n') || undefined;

    // Extract text from message output items
    const outputText = (response.output as Responses.ResponseOutputItem[])
        .filter((item): item is Responses.ResponseOutputMessage => item.type === 'message')
        .flatMap(item => item.content)
        .filter((content): content is Responses.ResponseOutputText => content.type === 'output_text')
        .map(content => content.text)
        .join('') || undefined;

    // Extract usage metrics and compaction summary from response
    const metadata = (response as any).metadata;
    let usage: UsageMetrics | undefined;
    if (response.usage) {
        const usageData = response.usage;
        const promptTokens = usageData.input_tokens || 0;
        const completionTokens = usageData.output_tokens || 0;
        const cachedReadTokens = usageData.input_tokens_details?.cached_tokens || 0;
        const cacheWriteTokens = usageData.input_tokens_details?.cache_write_tokens || 0;

        // Use cost from platform metadata if available, else estimate locally
        const rawCostUsd = metadata?.cost_usd ?? metadata?.["cost_usd"];
        const platformCostUsd = typeof rawCostUsd === 'number' ? rawCostUsd : (rawCostUsd ? parseFloat(rawCostUsd) : undefined);
        const costUsd = platformCostUsd || calculateCost(model, promptTokens, completionTokens, cachedReadTokens, cacheWriteTokens, 0, pricing);

        usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            cached_tokens: cachedReadTokens,
            cache_write_tokens: cacheWriteTokens,
            cost_usd: costUsd,
        };
        log.info(`Usage: ${promptTokens} prompt, ${completionTokens} completion, ${cachedReadTokens} cache read, ${cacheWriteTokens} cache write, $${costUsd.toFixed(6)}`);
    }

    // Extract compaction summary if context was compacted by platform
    const compactionSummary = metadata?.compaction_summary as string | undefined;
    if (compactionSummary) {
        log.info('Context was compacted by platform');
    }

    return { thought, message: outputText?.trim(), raw: response.output, usage, compactionSummary };
}
