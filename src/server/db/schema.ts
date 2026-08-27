import { serial, text, timestamp, pgTable, pgEnum, uuid, boolean, integer, jsonb, real, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { type ATIFAgent, type ATIFFinalMetrics, type ATIFStep, type ATIFStepSource, type ATIFTrajectory } from '../processor/conversation/atif/atif.types';
import { type TriggerConfig, type TriggerEventData } from '../automation/types';
import { type ConfirmationRequest } from '../processor/confirmation/confirmation.types';

export interface Context {
    compiled: string;
    file: string;
    uri?: string;
    query?: string;
}

export interface CodeContextFile {
    filename: string;
    b64_data: string;
}

export interface CodeContextResult {
    success: boolean;
    output_files: CodeContextFile[];
    std_out?: string;
    std_err: string;
    code_runtime?: number;
}

export interface CodeContextData {
    code: string;
    results?: CodeContextResult;
}

export interface WebPage {
    link: string;
    query?: string;
    snippet: string;
}

export interface AnswerBox {
    link?: string;
    snippet?: string;
    title: string;
    snippetHighlighted?: string[];
}

export interface PeopleAlsoAsk {
    link?: string;
    question?: string;
    snippet?: string;
    title?: string;
}

export interface KnowledgeGraph {
    attributes?: Record<string, string>;
    description?: string;
    descriptionLink?: string;
    descriptionSource?: string;
    imageUrl?: string;
    title: string;
    type?: string;
}

export interface OrganicContext {
    snippet?: string;
    title: string;
    link: string;
}

export interface OnlineContext {
    webpages?: WebPage | WebPage[];
    answerBox?: AnswerBox;
    peopleAlsoAsk?: PeopleAlsoAsk[];
    knowledgeGraph?: KnowledgeGraph;
    organic?: OrganicContext[];
}

export type ChatModelWithApi = {
    chatModel: typeof ChatModel.$inferSelect;
    aiModelApi: typeof AiModelApi.$inferSelect | null;
};

// Base model with timestamps
const dbBaseModel = {
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
};

// User Schemas
export const User = pgTable('user', {
  id: serial('id').primaryKey(),
  uuid: uuid('uuid').defaultRandom().notNull().unique(),
  password: text('password'),
  username: text('username').notNull().unique(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),
  phoneNumber: text('phone_number'),
  verifiedPhoneNumber: boolean('verified_phone_number').default(false).notNull(),
  verifiedEmail: boolean('verified_email').default(false).notNull(),
  accountVerificationCode: text('account_verification_code'),
  accountVerificationCodeExpiry: timestamp('account_verification_code_expiry'),
  lastLogin: timestamp('last_login'),
  ...dbBaseModel,
});

export const MemorySettings = pgTable('memory_settings', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }).unique(),
    memoriesEnabled: boolean('memories_enabled').default(true).notNull(),
    ...dbBaseModel,
});

export const GoogleUser = pgTable('google_user', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }),
    sub: text('sub').notNull(),
    azp: text('azp').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    givenName: text('given_name'),
    familyName: text('family_name'),
    picture: text('picture'),
    locale: text('locale'),
});

export const ApiKey = pgTable('api_key', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    name: text('name').notNull(),
    accessedAt: timestamp('accessed_at'),
});

export const SubscriptionTypeEnum = pgEnum('subscription_type', ['free', 'premium']);

export const Subscription = pgTable('subscription', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }),
    type: SubscriptionTypeEnum('type').default('free').notNull(),
    isRecurring: boolean('is_recurring').default(false).notNull(),
    renewalDate: timestamp('renewal_date'),
    enabledTrialAt: timestamp('enabled_trial_at'),
});

// AI Model Schemas
export const AiModelApi = pgTable('ai_model_api', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    apiKey: text('api_key').notNull(),
    apiBaseUrl: text('api_base_url'),
    ...dbBaseModel,
});

export const ChatModelTypeEnum = pgEnum('chat_model_type', ['openai', 'anthropic', 'google']);
export const ChatModelTierEnum = pgEnum('chat_model_tier', ['flagship', 'balanced', 'lite']);

export const ChatModel = pgTable('chat_model', {
    id: serial('id').primaryKey(),
    maxPromptSize: integer('max_prompt_size'),
    tokenizer: text('tokenizer'),
    name: text('name').default('gemini-2.5-flash').notNull(),
    friendlyName: text('friendly_name'),
    modelType: ChatModelTypeEnum('model_type').default('google').notNull(),
    visionEnabled: boolean('vision_enabled').default(false).notNull(),
    useResponsesApi: boolean('use_responses_api').default(false).notNull(),
    // Model supports native tool search with deferred tool loading
    supportsToolSearch: boolean('supports_tool_search').default(false).notNull(),
    aiModelApiId: integer('ai_model_api_id').references(() => AiModelApi.id, { onDelete: 'cascade' }),
    // Token Cost (USD) for Usage Tracking
    inputCostPerMillion: real('input_cost_per_million'),
    outputCostPerMillion: real('output_cost_per_million'),
    cacheReadCostPerMillion: real('cache_read_cost_per_million'),
    cacheWriteCostPerMillion: real('cache_write_cost_per_million'),
    // App-facing categorization shown in the chat model selector.
    tier: ChatModelTierEnum('tier'),
    tagline: text('tagline'),
    costTier: text('cost_tier'),
    recommended: boolean('recommended').default(false).notNull(),
    // Display order within the selector, synced from platform.
    sortOrder: integer('sort_order').default(0).notNull(),
    ...dbBaseModel,
});

export const UserChatModel = pgTable('user_chat_model', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }),
    modelId: integer('model_id').references(() => ChatModel.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

// Agent Schemas
export const styleColorEnum = pgEnum('style_color', ['blue', 'green', 'red', 'yellow', 'orange', 'purple', 'pink', 'teal', 'cyan', 'lime', 'indigo', 'fuchsia', 'rose', 'sky', 'amber', 'emerald']);
export const styleIconEnum = pgEnum('style_icon', ['Lightbulb', 'Health', 'Robot', 'Aperture', 'GraduationCap', 'Jeep', 'Island', 'MathOperations', 'Asclepius', 'Couch', 'Code', 'Atom', 'ClockCounterClockwise', 'PencilLine', 'Chalkboard', 'Cigarette', 'CraneTower', 'Heart', 'Leaf', 'NewspaperClipping', 'OrangeSlice', 'SmileyMelting', 'YinYang', 'SneakerMove', 'Student', 'Oven', 'Gavel', 'Broadcast']);
export const privacyLevelEnum = pgEnum('privacy_level', ['public', 'private', 'protected']);
export const inputToolEnum = pgEnum('input_tool', ['general', 'online', 'notes', 'webpage', 'code']);
export const outputModeEnum = pgEnum('output_mode', ['image', 'diagram']);

export const agents = pgTable('agents', {
    id: serial('id').primaryKey(),
    creatorId: integer('creator_id').references(() => User.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    personality: text('personality'),
    inputTools: inputToolEnum('input_tools').array(),
    outputModes: outputModeEnum('output_modes').array(),
    managedByAdmin: boolean('managed_by_admin').default(false).notNull(),
    chatModelId: integer('chat_model_id').notNull().references(() => ChatModel.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull().unique(),
    styleColor: styleColorEnum('style_color').default('orange').notNull(),
    styleIcon: styleIconEnum('style_icon').default('Lightbulb').notNull(),
    privacyLevel: privacyLevelEnum('privacy_level').default('private').notNull(),
    isHidden: boolean('is_hidden').default(false).notNull(),
    ...dbBaseModel,
});

// Conversation Schema
export const Conversation = pgTable('conversation', {
    id: uuid('id').defaultRandom().notNull().primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }),
    schemaVersion: text('schema_version').default('ATIF-v1.4').notNull(),
    sessionId: text('session_id').notNull(),
    agent: jsonb('agent').$type<ATIFAgent>().notNull(),
    finalMetrics: jsonb('final_metrics').$type<ATIFFinalMetrics>(),
    extra: jsonb('extra').$type<Record<string, unknown>>(),
    title: text('title'),
    // Optional link to automation - if set, this conversation belongs to an automation
    automationId: uuid('automation_id'),
    // Set when an agent delegated this conversation. Doubles as the delegated marker.
    parentConversationId: uuid('parent_conversation_id'),
    chatModelId: integer('chat_model_id').references(() => ChatModel.id),
    isPinned: boolean('is_pinned').default(false).notNull(),
    ...dbBaseModel,
}, (table) => [
    index('conversation_parent_conversation_id_idx').on(table.parentConversationId),
]);

export const ConversationStep = pgTable('conversation_step', {
    conversationId: uuid('conversation_id').notNull().references(() => Conversation.id, { onDelete: 'cascade' }),
    stepId: integer('step_id').notNull(),
    source: text('source').$type<ATIFStepSource>().notNull(),
    timestamp: timestamp('timestamp').notNull(),
    messagePreview: text('message_preview'),
    step: jsonb('step').$type<ATIFStep>().notNull(),
    ...dbBaseModel,
}, (table) => [
    primaryKey({ columns: [table.conversationId, table.stepId] }),
    index('conversation_step_conversation_id_idx').on(table.conversationId),
    index('conversation_step_source_idx').on(table.source),
]);

// Web Search Provider Configuration Schema
export const WebSearchProviderTypeEnum = pgEnum('web_search_provider_type', ['exa', 'serper', 'platform']);

export const WebSearchProvider = pgTable('web_search_provider', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    type: WebSearchProviderTypeEnum('type').notNull(),
    apiKey: text('api_key'),
    apiBaseUrl: text('api_base_url'),
    priority: integer('priority').default(0).notNull(),  // Higher priority = tried first
    enabled: boolean('enabled').default(true).notNull(),
    ...dbBaseModel,
});

// Web Scraper Configuration Schema
export const WebScraperTypeEnum = pgEnum('web_scraper_type', ['exa', 'direct', 'platform']);

export const WebScraper = pgTable('web_scraper', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    type: WebScraperTypeEnum('type').notNull(),
    apiKey: text('api_key'),
    apiBaseUrl: text('api_base_url'),
    priority: integer('priority').default(0).notNull(),  // Higher priority = tried first
    enabled: boolean('enabled').default(true).notNull(),
    ...dbBaseModel,
});

// Automation System Schemas
export const TriggerTypeEnum = pgEnum('trigger_type', ['cron', 'file_watch']);
export const AutomationStatusEnum = pgEnum('automation_status', ['active', 'paused', 'disabled']);
export const ExecutionStatusEnum = pgEnum('execution_status', ['pending', 'running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled']);
export const ConfirmationStatusEnum = pgEnum('confirmation_status', ['pending', 'approved', 'denied', 'expired']);

export const Automation = pgTable('automation', {
    id: uuid('id').defaultRandom().notNull().primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }),

    // Metadata
    name: text('name').notNull(),
    description: text('description'),
    prompt: text('prompt').notNull(),

    // Trigger configuration (optional)
    triggerType: TriggerTypeEnum('trigger_type'),
    triggerConfig: jsonb('trigger_config').$type<TriggerConfig>(),

    // Status
    status: AutomationStatusEnum('status').default('active').notNull(),

    // Linked conversation - all runs persist to this conversation
    // The conversation stores the ATIF trajectory, giving the agent context across runs
    conversationId: uuid('conversation_id').references(() => Conversation.id, { onDelete: 'set null' }),

    // Model this routine runs on. Null follows the user's default, so a routine only
    // pins a model when asked to. Cleared if that model goes away.
    chatModelId: integer('chat_model_id').references(() => ChatModel.id, { onDelete: 'set null' }),

    // Execution limits
    maxExecutionsPerDay: integer('max_executions_per_day'),
    maxExecutionsPerHour: integer('max_executions_per_hour'),

    // Timestamps
    lastExecutedAt: timestamp('last_executed_at'),
    nextScheduledAt: timestamp('next_scheduled_at'),
    ...dbBaseModel,
});

export const AutomationExecution = pgTable('automation_execution', {
    id: uuid('id').defaultRandom().notNull().primaryKey(),
    automationId: uuid('automation_id').notNull().references(() => Automation.id, { onDelete: 'cascade' }),

    // Execution details
    status: ExecutionStatusEnum('status').default('pending').notNull(),
    triggerData: jsonb('trigger_data').$type<TriggerEventData>(),

    // Results (uses ATIF format like Conversation)
    trajectory: jsonb('trajectory').$type<ATIFTrajectory>(),

    // Timing
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),

    // Error handling
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').default(0).notNull(),

    ...dbBaseModel,
});

export const PendingConfirmation = pgTable('pending_confirmation', {
    id: uuid('id').defaultRandom().notNull().primaryKey(),
    executionId: uuid('execution_id').notNull().references(() => AutomationExecution.id, { onDelete: 'cascade' }),

    // Confirmation request details
    request: jsonb('request').$type<ConfirmationRequest>().notNull(),

    // Status tracking
    status: ConfirmationStatusEnum('status').default('pending').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    respondedAt: timestamp('responded_at'),

    ...dbBaseModel,
});

// MCP Server Configuration Schema
export const McpTransportTypeEnum = pgEnum('mcp_transport_type', ['stdio', 'http']);
export const McpAuthTypeEnum = pgEnum('mcp_auth_type', ['none', 'bearer', 'oauth']);
export const McpOAuthStatusEnum = pgEnum('mcp_oauth_status', ['not_connected', 'auth_pending', 'connected', 'auth_required', 'error']);

/**
 * Confirmation mode for MCP server tool calls:
 * - 'always': Always require confirmation for all tool calls
 * - 'unsafe_only': Only require confirmation for unsafe operations (those with lasting side effects)
 * - 'never': Never require confirmation (trust all tool calls)
 */
export const McpConfirmationModeEnum = pgEnum('mcp_confirmation_mode', ['always', 'unsafe_only', 'never']);

export const McpServer = pgTable('mcp_server', {
    id: serial('id').primaryKey(),

    // Server identification
    name: text('name').notNull().unique(),  // For namespacing tools: "github" -> "github/create_issue"
    description: text('description'),

    // Connection configuration
    transportType: McpTransportTypeEnum('transport_type').notNull(),
    // For stdio: path to script (.py/.js) or npm package name (@scope/package)
    // For HTTP: HTTPS URL endpoint
    path: text('path').notNull(),

    // Optional API key for authenticated servers
    apiKey: text('api_key'),

    // Authentication mode for HTTP-based MCP servers
    authType: McpAuthTypeEnum('auth_type').default('none').notNull(),
    oauthStatus: McpOAuthStatusEnum('oauth_status').default('not_connected').notNull(),
    oauthClientId: text('oauth_client_id'),
    oauthClientSecret: text('oauth_client_secret'),
    oauthScopes: jsonb('oauth_scopes').$type<string[]>(),

    // Optional environment variables to pass to stdio servers (JSON object)
    env: jsonb('env').$type<Record<string, string>>(),

    // Confirmation mode for tool calls from this server
    // - 'always': Always require confirmation (most restrictive, default)
    // - 'unsafe_only': Only require confirmation for unsafe operations
    // - 'never': Never require confirmation (least restrictive)
    confirmationMode: McpConfirmationModeEnum('confirmation_mode').default('always').notNull(),

    // Status tracking
    enabled: boolean('enabled').default(true).notNull(),
    lastConnectedAt: timestamp('last_connected_at'),
    lastError: text('last_error'),

    // Tool filtering: when null/empty, all tools are enabled
    // When populated, only listed tools are available to the agent
    enabledTools: jsonb('enabled_tools').$type<string[]>(),

    ...dbBaseModel,
});

// OAuth session and dynamic client registration state for HTTP-based MCP servers.
export const McpOAuthState = pgTable('mcp_oauth_state', {
    id: serial('id').primaryKey(),
    serverId: integer('server_id').notNull().references(() => McpServer.id, { onDelete: 'cascade' }),
    authorizationServerUrl: text('authorization_server_url'),
    resourceMetadataUrl: text('resource_metadata_url'),
    resourceUrl: text('resource_url'),
    scope: text('scope'),
    state: text('state'),
    codeVerifier: text('code_verifier'),
    clientInformation: jsonb('client_information').$type<Record<string, unknown>>(),
    tokens: jsonb('tokens').$type<Record<string, unknown>>(),
    lastAuthorizationUrl: text('last_authorization_url'),
    ...dbBaseModel,
}, (table) => ({
    serverIdUnique: uniqueIndex('mcp_oauth_state_server_id_unique').on(table.serverId),
}));

// Platform Authentication Token Storage
// Stores tokens for authenticated sessions with the Pipali Platform
export const PlatformAuth = pgTable('platform_auth', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    expiresAt: timestamp('expires_at'),
    platformUserId: text('platform_user_id'),  // UUID from platform
    platformEmail: text('platform_email'),
    platformName: text('platform_name'),  // Last known display name from platform
    platformUrl: text('platform_url'),  // Which platform instance
    ...dbBaseModel,
});

// Sandbox Settings for Shell Command Execution
// Configures OS-enforced sandboxing (Seatbelt on macOS, bubblewrap on Linux)
export const SandboxSettings = pgTable('sandbox_settings', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => User.id, { onDelete: 'cascade' }).unique(),
    // Whether sandbox mode is enabled
    enabled: boolean('enabled').default(true).notNull(),
    // Paths where writes are allowed without confirmation
    allowedWritePaths: jsonb('allowed_write_paths').$type<string[]>().default([]).notNull(),
    // Paths that are always denied for writes (e.g., ~/.ssh)
    deniedWritePaths: jsonb('denied_write_paths').$type<string[]>().default([]).notNull(),
    // Paths that always require confirmation for reads (defaults from isSensitivePath)
    deniedReadPaths: jsonb('denied_read_paths').$type<string[]>().default([]).notNull(),
    // Network: domains allowed for sandboxed commands
    allowedDomains: jsonb('allowed_domains').$type<string[]>().default(['*']).notNull(),
    // Whether to allow local network binding in sandbox
    allowLocalBinding: boolean('allow_local_binding').default(true).notNull(),
    ...dbBaseModel,
});