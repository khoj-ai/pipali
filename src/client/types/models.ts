// Chat model types for LLM provider configuration

export type ChatModelInfo = {
    id: number;
    name: string;
    friendlyName: string | null;
    modelType: string;
    visionEnabled?: boolean;
    inputCostPerMillion: number | null;
    outputCostPerMillion: number | null;
};
