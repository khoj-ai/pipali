/**
 * Centralized CSS Selectors for E2E Tests
 *
 * All selectors are derived from actual component class names.
 * When components change, update these selectors to match.
 */

export const Selectors = {
    // Layout
    mainContent: '.main-content',
    messagesContainer: '.messages-container',
    sidebar: '.sidebar',

    // Input Area
    inputArea: '.input-area',
    inputForm: '.input-form',
    inputTextarea: '.input-form textarea',
    inputHint: '.input-hint',

    // Action Buttons
    sendButton: '.action-button.send',
    pauseButton: '.action-button.pause',
    playButton: '.action-button.play',

    // Messages
    messages: '.messages',
    message: '.message',
    userMessage: '.user-message',
    assistantMessage: '.assistant-message',
    messageLabel: '.message-label',
    messageContent: '.message-content',

    // Thoughts / Train of Thought
    thoughtsSection: '.thoughts-section',
    thoughtsToggle: '.thoughts-toggle',
    thoughtsSummary: '.thoughts-summary',
    thoughtsList: '.thoughts-list',
    thoughtItem: '.thought-item',
    thoughtStep: '.thought-step',
    thoughtTool: '.thought-tool',

    // Home Page
    emptyState: '.empty-state',
    homeEmpty: '.home-empty',
    taskGallery: '.task-gallery',
    taskGalleryHeader: '.task-gallery-header',
    taskCount: '.task-count',
    taskCards: '.task-cards',
    taskCard: '.task-card',
    taskCardPaused: '.task-card.paused',
    taskCardHeader: '.task-card-header',
    taskStatusIcon: '.task-status-icon',
    taskStatusIconSpinning: '.task-status-icon.spinning',
    taskStatusIconPaused: '.task-status-icon.paused',
    taskStatusText: '.task-status-text',
    taskStepCount: '.task-step-count',
    taskCardTitle: '.task-card-title',
    taskCardReasoning: '.task-card-reasoning',

    // Sidebar
    conversationItem: '.conversation-item',
    conversationItemActive: '.conversation-item.active',
    conversationItemWithActiveTask: '.conversation-item.has-active-task',
    conversationTitle: '.conversation-title',
    conversationSubtitle: '.conversation-subtitle',
    newChatButton: '.new-chat-button',

    // Header
    header: 'header',
    logo: '.logo.clickable',

    // Streaming
    streamingIndicator: '.streaming-indicator',

    // Confirmation Dialog
    confirmationDialog: '.confirmation-dialog',
    confirmationTitle: '.confirmation-title',
    confirmationButtons: '.confirmation-btn',
    confirmationBtnPrimary: '.confirmation-btn.primary',
    confirmationBtnSecondary: '.confirmation-btn.secondary',
    confirmationBtnDanger: '.confirmation-btn.danger',
    operationTypePill: '.operation-type-pill',

    // Confirmation Toast
    confirmationToast: '.confirmation-toast',
    toastBtn: '.toast-btn',
} as const;

export type SelectorKey = keyof typeof Selectors;
