import { serial, text, timestamp, pgTable, pgEnum, uuid, boolean, integer, jsonb } from 'drizzle-orm/pg-core';
import { type ATIFTrajectory } from '../processor/conversation/atif/atif.types';

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
    aiModelApiId: integer('ai_model_api_id').references(() => AiModelApi.id, { onDelete: 'cascade' }),
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
    ...dbBaseModel,
});