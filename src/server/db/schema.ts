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
    inferredQueries?: string[];
}

export interface TrainOfThought {
    type: string;
    data: string;
}

export interface ChatMessage {
    by: 'user' | 'assistant';
    message: string;
    trainOfThought?: TrainOfThought[];
    context?: Context[];
    onlineContext?: Record<string, OnlineContext>;
    codeContext?: Record<string, CodeContextData>;
    researchContext?: any[];
    operatorContext?: any[];
    created?: string;
    queryImages?: string[];
    queryFiles?: Record<string, any>[];
    turnId?: string;
    intent?: Intent;
}

// Base model with timestamps
const dbBaseModel = {
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
};

// User Schemas
export const users = pgTable('users', {
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

export const googleUsers = pgTable('google_users', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sub: text('sub').notNull(),
    azp: text('azp').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    givenName: text('given_name'),
    familyName: text('family_name'),
    picture: text('picture'),
    locale: text('locale'),
});

export const apiKeys = pgTable('api_keys', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    name: text('name').notNull(),
    accessedAt: timestamp('accessed_at'),
});

export const subscriptionTypeEnum = pgEnum('subscription_type', ['free', 'premium']);

export const subscriptions = pgTable('subscriptions', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: subscriptionTypeEnum('type').default('free').notNull(),
    isRecurring: boolean('is_recurring').default(false).notNull(),
    renewalDate: timestamp('renewal_date'),
    enabledTrialAt: timestamp('enabled_trial_at'),
});

// AI Model Schemas
export const aiModelApis = pgTable('ai_model_apis', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    apiKey: text('api_key').notNull(),
    apiBaseUrl: text('api_base_url'),
    ...dbBaseModel,
});

export const priceTierEnum = pgEnum('price_tier', ['free', 'premium']);
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

export const textToSpeechModels = pgTable('text_to_speech_models', {
    id: serial('id').primaryKey(),
    modelId: text('model_id').notNull(),
    name: text('name').notNull(),
    priceTier: priceTierEnum('price_tier').default('free').notNull(),
    ...dbBaseModel,
});

export const textToImageModelTypeEnum = pgEnum('text_to_image_model_type', ['openai', 'replicate', 'google']);

export const textToImageModels = pgTable('text_to_image_models', {
    id: serial('id').primaryKey(),
    modelName: text('model_name').default('imagen-4.0-generate-001').notNull(),
    friendlyName: text('friendly_name'),
    modelType: textToImageModelTypeEnum('model_type').default('openai').notNull(),
    priceTier: priceTierEnum('price_tier').default('free').notNull(),
    apiKey: text('api_key'),
    aiModelApiId: integer('ai_model_api_id').references(() => aiModelApis.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const speechToTextModelTypeEnum = pgEnum('speech_to_text_model_type', ['openai', 'google']);

export const speechToTextModels = pgTable('speech_to_text_models', {
    id: serial('id').primaryKey(),
    modelName: text('model_name').default('whisper-1').notNull(),
    friendlyName: text('friendly_name'),
    modelType: speechToTextModelTypeEnum('model_type').default('openai').notNull(),
    priceTier: priceTierEnum('price_tier').default('free').notNull(),
    aiModelApiId: integer('ai_model_api_id').references(() => aiModelApis.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const userChatModel = pgTable('user_chat_model', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    modelId: integer('model_id').references(() => chatModels.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const userTextToSpeechModel = pgTable('user_text_to_speech_model', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    modelId: integer('model_id').references(() => textToSpeechModels.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const userSpeechToTextModel = pgTable('user_speech_to_text_model', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    modelId: integer('model_id').notNull().references(() => speechToTextModels.id, { onDelete: 'cascade' }),
    ...dbBaseModel,
});

export const userTextToImageModel = pgTable('user_text_to_image_model', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    modelId: integer('model_id').notNull().references(() => textToImageModels.id, { onDelete: 'cascade' }),
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
    creatorId: integer('creator_id').references(() => users.id, { onDelete: 'cascade' }),
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

// Conversation Schema
export const conversations = pgTable('conversations', {
    id: uuid('id').defaultRandom().notNull().primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    conversationLog: jsonb('conversation_log').$type<{ chat: ChatMessage[] }>().default({ chat: [] }),
    slug: text('slug'),
    title: text('title'),
    agentId: integer('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    fileFilters: jsonb('file_filters').default([]),
    ...dbBaseModel,
});

// Other Schemas
export const userRequests = pgTable('user_requests', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    ...dbBaseModel,
});

export const rateLimitRecords = pgTable('rate_limit_records', {
    id: serial('id').primaryKey(),
    identifier: text('identifier').notNull(),
    slug: text('slug').notNull(),
    ...dbBaseModel,
});
