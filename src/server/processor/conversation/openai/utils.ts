import type { ToolDefinition } from "../conversation";
import type { ToolDefinition as LcToolDefinition } from '@langchain/core/language_models/base';

export function toOpenaiTools(tools?: ToolDefinition[]): LcToolDefinition[] {
    if (!tools) return [];
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.schema,
        }
    }));
}
