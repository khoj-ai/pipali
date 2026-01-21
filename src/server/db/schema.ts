import { serial, text, timestamp, pgTable, pgEnum, uuid, boolean, integer, jsonb, real } from 'drizzle-orm/pg-core';
import { type ATIFTrajectory } from '../processor/conversation/atif/atif.types';
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

export const ChatModel = pgTable('chat_model', {
    id: serial('id').primaryKey(),
    maxPromptSize: integer('max_prompt_size'),
    tokenizer: text('tokenizer'),
    name: text('name').default('gemini-2.5-flash').notNull(),
    friendlyName: text('friendly_name'),
    modelType: ChatModelTypeEnum('model_type').default('google').notNull(),
    visionEnabled: boolean('vision_enabled').default(false).notNull(),
    useResponsesApi: boolean('use_responses_api').default(false).notNull(),
    aiModelApiId: integer('ai_model_api_id').references(() => AiModelApi.id, { onDelete: 'cascade' }),
    // Token Cost (USD) for Usage Tracking
    inputCostPerMillion: real('input_cost_per_million'),
    outputCostPerMillion: real('output_cost_per_million'),
    cacheReadCostPerMillion: real('cache_read_cost_per_million'),
    cacheWriteCostPerMillion: real('cache_write_cost_per_million'),
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
    trajectory: jsonb('trajectory').$type<ATIFTrajectory>().notNull(),
    title: text('title'),
    // Optional link to automation - if set, this conversation belongs to an automation
    automationId: uuid('automation_id'),
    ...dbBaseModel,
});

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
export const McpTransportTypeEnum = pgEnum('mcp_transport_type', ['stdio', 'sse']);

export const McpServer = pgTable('mcp_server', {
    id: serial('id').primaryKey(),

    // Server identification
    name: text('name').notNull().unique(),  // For namespacing tools: "github" -> "github/create_issue"
    description: text('description'),

    // Connection configuration
    transportType: McpTransportTypeEnum('transport_type').notNull(),
    // For stdio: path to script (.py/.js) or npm package name (@scope/package)
    // For SSE: HTTP/HTTPS URL endpoint
    path: text('path').notNull(),

    // Optional API key for authenticated servers
    apiKey: text('api_key'),

    // Optional environment variables to pass to stdio servers (JSON object)
    env: jsonb('env').$type<Record<string, string>>(),

    // Whether tool calls from this server require user confirmation
    requiresConfirmation: boolean('requires_confirmation').default(true).notNull(),

    // Status tracking
    enabled: boolean('enabled').default(true).notNull(),
    lastConnectedAt: timestamp('last_connected_at'),
    lastError: text('last_error'),

    // Tool filtering: when null/empty, all tools are enabled
    // When populated, only listed tools are available to the agent
    enabledTools: jsonb('enabled_tools').$type<string[]>(),

    ...dbBaseModel,
});

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