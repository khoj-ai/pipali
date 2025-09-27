import { serial, text, timestamp, pgTable, pgEnum, uuid, boolean, integer, jsonb, real, date, primaryKey } from 'drizzle-orm/pg-core';

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

export interface Intent {
    type: string;
    query?: string;
    'memory-type'?: string;
    'inferred-queries'?: string[];
}

export interface TrainOfThought {
    type: string;
    data: string;
}

export interface ChatMessage {
    by: 'user' | 'khoj';
    message: string | Record<string, any>[];
    trainOfThought?: TrainOfThought[];
    context?: Context[];
    onlineContext?: Record<string, OnlineContext>;
    codeContext?: Record<string, CodeContextData>;
    researchContext?: any[];
    operatorContext?: any[];
    created?: string;
    images?: string[];
    queryFiles?: Record<string, any>[];
    excalidrawDiagram?: Record<string, any>[];
    mermaidjsDiagram?: string;
    turnId?: string;
    intent?: Intent;
    automationId?: string;
}

// Base model with timestamps
const dbBaseModel = {
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
};

export const clientApplications = pgTable('client_applications', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  clientId: text('client_id').notNull(),
  clientSecret: text('client_secret').notNull(),
  ...dbBaseModel,
});

export const khojUsers = pgTable('khoj_users', {
  id: serial('id').primaryKey(),
  uuid: uuid('uuid').defaultRandom().notNull().unique(),
  password: text('password'),
  lastLogin: timestamp('last_login'),
  isSuperuser: boolean('is_superuser').default(false).notNull(),
  username: text('username').notNull().unique(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email'),
  isStaff: boolean('is_staff').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  dateJoined: timestamp('date_joined').defaultNow().notNull(),
  phoneNumber: text('phone_number'),
  verifiedPhoneNumber: boolean('verified_phone_number').default(false).notNull(),
  verifiedEmail: boolean('verified_email').default(false).notNull(),
  emailVerificationCode: text('email_verification_code'),
  emailVerificationCodeExpiry: timestamp('email_verification_code_expiry'),
});

export const googleUsers = pgTable('google_users', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    sub: text('sub').notNull(),
    azp: text('azp').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    givenName: text('given_name'),
    familyName: text('family_name'),
    picture: text('picture'),
    locale: text('locale'),
});

export const subscriptionTypeEnum = pgEnum('subscription_type', ['trial', 'standard']);

export const khojApiUsers = pgTable('khoj_api_users', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    name: text('name').notNull(),
    accessedAt: timestamp('accessed_at'),
});

export const subscriptions = pgTable('subscriptions', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    type: subscriptionTypeEnum('type').default('standard').notNull(),
    isRecurring: boolean('is_recurring').default(false).notNull(),
    renewalDate: timestamp('renewal_date'),
    enabledTrialAt: timestamp('enabled_trial_at'),
    ...dbBaseModel,
});

export const aiModelApis = pgTable('ai_model_apis', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    apiKey: text('api_key').notNull(),
    apiBaseUrl: text('api_base_url'),
    ...dbBaseModel,
});

export const priceTierEnum = pgEnum('price_tier', ['free', 'standard']);
export const chatModelTypeEnum = pgEnum('chat_model_type', ['openai', 'anthropic', 'google']);

export const chatModels = pgTable('chat_models', {
    id: serial('id').primaryKey(),
    maxPromptSize: integer('max_prompt_size'),
    subscribedMaxPromptSize: integer('subscribed_max_prompt_size'),
    tokenizer: text('tokenizer'),
    name: text('name').default('gemini-2.5-flash').notNull(),
    friendlyName: text('friendly_name'),
    modelType: chatModelTypeEnum('model_type').default('google').notNull(),
    priceTier: priceTierEnum('price_tier').default('free').notNull(),
    visionEnabled: boolean('vision_enabled').default(false).notNull(),
    aiModelApiId: integer('ai_model_api_id').references(() => aiModelApis.id, { onDelete: 'cascade' }),
    description: text('description'),
    strengths: text('strengths'),
    ...dbBaseModel,
});

export const voiceModelOptions = pgTable('voice_model_options', {
    id: serial('id').primaryKey(),
    modelId: text('model_id').notNull(),
    name: text('name').notNull(),
    priceTier: priceTierEnum('price_tier').default('standard').notNull(),
    ...dbBaseModel,
});

export const styleColorEnum = pgEnum('style_color', ['blue', 'green', 'red', 'yellow', 'orange', 'purple', 'pink', 'teal', 'cyan', 'lime', 'indigo', 'fuchsia', 'rose', 'sky', 'amber', 'emerald']);
export const styleIconEnum = pgEnum('style_icon', ['Lightbulb', 'Health', 'Robot', 'Aperture', 'GraduationCap', 'Jeep', 'Island', 'MathOperations', 'Asclepius', 'Couch', 'Code', 'Atom', 'ClockCounterClockwise', 'PencilLine', 'Chalkboard', 'Cigarette', 'CraneTower', 'Heart', 'Leaf', 'NewspaperClipping', 'OrangeSlice', 'SmileyMelting', 'YinYang', 'SneakerMove', 'Student', 'Oven', 'Gavel', 'Broadcast']);
export const privacyLevelEnum = pgEnum('privacy_level', ['public', 'private', 'protected']);
export const inputToolEnum = pgEnum('input_tool', ['general', 'online', 'notes', 'webpage', 'code']);
export const outputModeEnum = pgEnum('output_mode', ['image', 'diagram']);

export const agents = pgTable('agents', {
    id: serial('id').primaryKey(),
    creatorId: integer('creator_id').references(() => khojUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    personality: text('personality'),
    inputTools: inputToolEnum('input_tools').array(),
    outputModes: outputModeEnum('output_modes').array(),
    managedByAdmin: boolean('managed_by_admin').default(false).notNull(),
    chatModelId: integer('chat_model_id').notNull().references(() => chatModels.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull().unique(),
    styleColor: styleColorEnum('style_color').default('orange').notNull(),
    styleIcon: styleIconEnum('style_icon').default('Lightbulb').notNull(),
    privacyLevel: privacyLevelEnum('privacy_level').default('private').notNull(),
    isHidden: boolean('is_hidden').default(false).notNull(),
    ...dbBaseModel,
});

export const processLockOperationEnum = pgEnum('process_lock_operation', ['index_content', 'scheduled_job', 'schedule_leader', 'apply_migrations']);

export const processLocks = pgTable('process_locks', {
    id: serial('id').primaryKey(),
    name: processLockOperationEnum('name').notNull().unique(),
    startedAt: timestamp('started_at').defaultNow().notNull(),
    maxDurationInSeconds: integer('max_duration_in_seconds').default(43200).notNull(),
    ...dbBaseModel,
});

export const notionConfigs = pgTable('notion_configs', {
    id: serial('id').primaryKey(),
    token: text('token').notNull(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const githubConfigs = pgTable('github_configs', {
    id: serial('id').primaryKey(),
    patToken: text('pat_token').notNull(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const githubRepoConfigs = pgTable('github_repo_configs', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    owner: text('owner').notNull(),
    branch: text('branch').notNull(),
    githubConfigId: integer('github_config_id').notNull().references(() => githubConfigs.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const webScraperTypeEnum = pgEnum('web_scraper_type', ['Firecrawl', 'Olostep', 'Jina', 'Direct']);

export const webScrapers = pgTable('web_scrapers', {
    id: serial('id').primaryKey(),
    name: text('name').unique(),
    type: webScraperTypeEnum('type').default('Jina').notNull(),
    apiKey: text('api_key'),
    apiUrl: text('api_url'),
    priority: integer('priority').unique(),
    ...dbBaseModel,
});

export const serverChatSettings = pgTable('server_chat_settings', {
    id: serial('id').primaryKey(),
    chatDefaultId: integer('chat_default_id').references(() => chatModels.id, { onDelete: 'cascade' }),
    chatAdvancedId: integer('chat_advanced_id').references(() => chatModels.id, { onDelete: 'cascade' }),
    webScraperId: integer('web_scraper_id').references(() => webScrapers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const localOrgConfigs = pgTable('local_org_configs', {
    id: serial('id').primaryKey(),
    inputFiles: jsonb('input_files').default([]),
    inputFilter: jsonb('input_filter').default([]),
    indexHeadingEntries: boolean('index_heading_entries').default(false).notNull(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const localMarkdownConfigs = pgTable('local_markdown_configs', {
    id: serial('id').primaryKey(),
    inputFiles: jsonb('input_files').default([]),
    inputFilter: jsonb('input_filter').default([]),
    indexHeadingEntries: boolean('index_heading_entries').default(false).notNull(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const localPdfConfigs = pgTable('local_pdf_configs', {
    id: serial('id').primaryKey(),
    inputFiles: jsonb('input_files').default([]),
    inputFilter: jsonb('input_filter').default([]),
    indexHeadingEntries: boolean('index_heading_entries').default(false).notNull(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const localPlaintextConfigs = pgTable('local_plaintext_configs', {
    id: serial('id').primaryKey(),
    inputFiles: jsonb('input_files').default([]),
    inputFilter: jsonb('input_filter').default([]),
    indexHeadingEntries: boolean('index_heading_entries').default(false).notNull(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const searchModelTypeEnum = pgEnum('search_model_type', ['text']);
export const searchModelApiTypeEnum = pgEnum('search_model_api_type', ['huggingface', 'openai', 'local']);

export const searchModelConfigs = pgTable('search_model_configs', {
    id: serial('id').primaryKey(),
    name: text('name').default('default').notNull(),
    modelType: searchModelTypeEnum('model_type').default('text').notNull(),
    biEncoder: text('bi_encoder').default('thenlper/gte-small').notNull(),
    biEncoderModelConfig: jsonb('bi_encoder_model_config').default({}),
    biEncoderQueryEncodeConfig: jsonb('bi_encoder_query_encode_config').default({}),
    biEncoderDocsEncodeConfig: jsonb('bi_encoder_docs_encode_config').default({}),
    crossEncoder: text('cross_encoder').default('mixedbread-ai/mxbai-rerank-xsmall-v1').notNull(),
    crossEncoderModelConfig: jsonb('cross_encoder_model_config').default({}),
    embeddingsInferenceEndpoint: text('embeddings_inference_endpoint'),
    embeddingsInferenceEndpointApiKey: text('embeddings_inference_endpoint_api_key'),
    embeddingsInferenceEndpointType: searchModelApiTypeEnum('embeddings_inference_endpoint_type').default('local').notNull(),
    crossEncoderInferenceEndpoint: text('cross_encoder_inference_endpoint'),
    crossEncoderInferenceEndpointApiKey: text('cross_encoder_inference_endpoint_api_key'),
    biEncoderConfidenceThreshold: real('bi_encoder_confidence_threshold').default(0.18).notNull(),
    ...dbBaseModel,
});

export const textToImageModelTypeEnum = pgEnum('text_to_image_model_type', ['openai', 'stability-ai', 'replicate', 'google']);

export const textToImageModelConfigs = pgTable('text_to_image_model_configs', {
    id: serial('id').primaryKey(),
    modelName: text('model_name').default('dall-e-3').notNull(),
    friendlyName: text('friendly_name'),
    modelType: textToImageModelTypeEnum('model_type').default('openai').notNull(),
    priceTier: priceTierEnum('price_tier').default('free').notNull(),
    apiKey: text('api_key'),
    aiModelApiId: integer('ai_model_api_id').references(() => aiModelApis.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const speechToTextModelTypeEnum = pgEnum('speech_to_text_model_type', ['openai']);

export const speechToTextModelOptions = pgTable('speech_to_text_model_options', {
    id: serial('id').primaryKey(),
    modelName: text('model_name').default('whisper-1').notNull(),
    friendlyName: text('friendly_name'),
    modelType: speechToTextModelTypeEnum('model_type').default('openai').notNull(),
    priceTier: priceTierEnum('price_tier').default('free').notNull(),
    aiModelApiId: integer('ai_model_api_id').references(() => aiModelApis.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const userConversationConfigs = pgTable('user_conversation_configs', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    settingId: integer('setting_id').references(() => chatModels.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const userVoiceModelConfigs = pgTable('user_voice_model_configs', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    settingId: integer('setting_id').references(() => voiceModelOptions.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const userTextToImageModelConfigs = pgTable('user_text_to_image_model_configs', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    settingId: integer('setting_id').notNull().references(() => textToImageModelConfigs.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const conversations = pgTable('conversations', {
    id: uuid('id').defaultRandom().notNull().primaryKey(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    conversationLog: jsonb('conversation_log').$type<{ chat: ChatMessage[] }>().default({ chat: [] }),
    clientId: integer('client_id').references(() => clientApplications.id, { onDelete: 'cascade' }),
    slug: text('slug'),
    title: text('title'),
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    fileFilters: jsonb('file_filters').default([]),
    ...dbBaseModel,
});

export const publicConversations = pgTable('public_conversations', {
    id: serial('id').primaryKey(),
    sourceOwnerId: integer('source_owner_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    conversationLog: jsonb('conversation_log').$type<{ chat: ChatMessage[] }>().default({ chat: [] }),
    slug: text('slug'),
    title: text('title'),
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    ...dbBaseModel,
});

export const reflectiveQuestions = pgTable('reflective_questions', {
    id: serial('id').primaryKey(),
    question: text('question').notNull(),
    userId: integer('user_id').references(() => khojUsers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const fileObjects = pgTable('file_objects', {
    id: serial('id').primaryKey(),
    fileName: text('file_name'),
    rawText: text('raw_text').notNull(),
    userId: integer('user_id').references(() => khojUsers.id, { onDelete: 'cascade' }),
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const entryTypeEnum = pgEnum('entry_type', ['image', 'pdf', 'plaintext', 'markdown', 'org', 'notion', 'github', 'conversation', 'docx']);
export const entrySourceEnum = pgEnum('entry_source', ['computer', 'notion', 'github']);

export const entries = pgTable('entries', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => khojUsers.id, { onDelete: 'cascade' }),
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    embeddings: jsonb('embeddings'),
    raw: text('raw').notNull(),
    compiled: text('compiled').notNull(),
    heading: text('heading'),
    fileSource: entrySourceEnum('file_source').default('computer').notNull(),
    fileType: entryTypeEnum('file_type').default('plaintext').notNull(),
    filePath: text('file_path'),
    fileName: text('file_name'),
    url: text('url'),
    hashedValue: text('hashed_value').notNull(),
    corpusId: uuid('corpus_id').defaultRandom().notNull(),
    searchModelId: integer('search_model_id').references(() => searchModelConfigs.id, { onDelete: 'set null' }),
    fileObjectId: integer('file_object_id').references(() => fileObjects.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const entryDates = pgTable('entry_dates', {
    id: serial('id').primaryKey(),
    date: date('date').notNull(),
    entryId: integer('entry_id').notNull().references(() => entries.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const userRequests = pgTable('user_requests', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => khojUsers.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    ...dbBaseModel,
});

export const rateLimitRecords = pgTable('rate_limit_records', {
    id: serial('id').primaryKey(),
    identifier: text('identifier').notNull(),
    slug: text('slug').notNull(),
    ...dbBaseModel,
});

export const dataStores = pgTable('data_stores', {
    id: serial('id').primaryKey(),
    key: text('key').notNull().unique(),
    value: jsonb('value').default({}),
    private: boolean('private').default(false).notNull(),
    ownerId: integer('owner_id').references(() => khojUsers.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});
