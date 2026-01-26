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
    stopButton: '.action-button.stop',

    // Messages
    messages: '.messages',
    message: '.message',
    userMessage: '.user-message',
    assistantMessage: '.assistant-message',
    messageLabel: '.message-label',
    messageContent: '.message-content',
    messageActions: '.message-actions',
    messageActionBtn: '.message-action-btn',

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
    taskCardStopped: '.task-card.stopped',
    taskCardHeader: '.task-card-header',
    taskStatusIcon: '.task-status-icon',
    taskStatusIconSpinning: '.task-status-icon.spinning',
    taskStatusIconStopped: '.task-status-icon.stopped',
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
    newChatButton: '.new-chat-btn',

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

    // Skills Page
    skillsGallery: '.skills-gallery',
    skillsHeader: '.skills-header',
    skillsCount: '.skills-count',
    skillsCreateBtn: '.skills-create-btn',
    skillsReloadBtn: '.skills-reload-btn',
    skillsCards: '.skills-cards',
    skillsEmpty: '.skills-empty',
    skillsErrors: '.skills-errors',
    skillsError: '.skills-error',
    skillsLoading: '.skills-loading',

    // Skill Card
    skillCard: '.skill-card',
    skillCardTitle: '.skill-card-title',
    skillCardDescription: '.skill-card-description',
    skillSourceBadge: '.skill-source-badge',
    skillLocation: '.skill-location',

    // Skill Detail Modal
    skillDetailModal: '.skill-detail-modal',
    skillDetailDescriptionInput: '.skill-detail-description-input',
    skillDetailInstructionsInput: '.skill-detail-instructions-input',
    skillDetailLocation: '.skill-detail-location',
    skillDetailLoading: '.skill-detail-loading',
    deleteConfirmText: '.delete-confirm-text',

    // Create Skill Modal
    skillModal: '.skill-modal',
    skillForm: '.skill-form',
    skillNameInput: '#skill-name',
    createSkillDescriptionInput: '#skill-description',
    createSkillInstructionsInput: '#skill-instructions',
    sourceOptions: '.source-options',
    sourceOptionLocal: '.source-option:has(span:text("Local"))',
    sourceOptionGlobal: '.source-option:has(span:text("Global"))',
    sourceOptionSelected: '.source-option.selected',

    // Modal Common
    modalBackdrop: '.modal-backdrop',
    modal: '.modal',
    modalHeader: '.modal-header',
    modalClose: '.modal-close',
    modalActions: '.modal-actions',
    btnPrimary: '.btn-primary',
    btnSecondary: '.btn-secondary',
    btnDanger: '.btn-danger',
    btnDangerOutline: '.btn-danger-outline',
    formError: '.form-error',
    formHint: '.form-hint',

    // Automations Page
    automationsGallery: '.automations-gallery',
    automationsHeader: '.automations-header',
    automationsCount: '.automations-count',
    automationsCreateBtn: '.automations-create-btn',
    automationsReloadBtn: '.automations-reload-btn',
    automationsCards: '.automations-cards',
    automationsEmpty: '.automations-empty',
    automationsLoading: '.automations-loading',

    // Automation Card
    automationCard: '.automation-card',
    automationCardTitle: '.automation-card-title',
    automationCardDescription: '.automation-card-description',
    automationCardPrompt: '.automation-card-prompt',
    automationCardFooter: '.automation-card-footer',
    automationSchedule: '.automation-schedule',
    automationNextRun: '.automation-next-run',
    automationStatusBadge: '.automation-status-badge',
    automationAwaitingConfirmation: '.automation-card.awaiting-confirmation',

    // Automation Detail Modal
    automationDetailModal: '.automation-detail-modal',
    automationDetailSection: '.automation-detail-section',
    automationDetailSchedule: '.automation-detail-schedule',
    automationDetailNextRun: '.automation-detail-next-run',
    automationDetailInstructions: '.automation-detail-instructions',
    automationDetailMeta: '.automation-detail-meta',
    automationDetailActions: '.automation-detail-actions',
    instructionsTextarea: '.instructions-textarea',
    frequencySelect: '.frequency-select',
    frequencySelector: '.frequency-selector',

    // Automation Confirmation Section
    automationConfirmationSection: '.automation-confirmation-section',
    confirmationHeader: '.confirmation-header',
    confirmationContent: '.confirmation-content',
    confirmationActions: '.confirmation-actions',
    btnConfirmation: '.btn-confirmation',

    // Create Automation Modal
    createAutomationModal: '.create-automation-modal',

    // Toast Container (for automation confirmations)
    toastContainer: '.toast-container',
    toastAutomation: '.confirmation-toast--automation',
    automationSource: '.automation-source',
} as const;

export type SelectorKey = keyof typeof Selectors;
