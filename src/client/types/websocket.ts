// WebSocket message types for server communication

export type WebSocketMessage = {
    type: 'iteration' | 'complete' | 'error' | 'research' | 'pause' | 'confirmation_request' | 'conversation_created';
    data?: any;
    error?: string;
    conversationId?: string;
};
