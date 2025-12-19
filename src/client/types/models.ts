// Chat model types for LLM provider configuration

export type ChatModelInfo = {
    id: number;
    name: string;
    friendlyName: string | null;
    modelType: string;
    visionEnabled?: boolean;
    providerName: string | null;
};
