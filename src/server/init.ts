import { db } from './db';
import { User, AiModelApi, ChatModel } from './db/schema';
import { eq } from 'drizzle-orm';
import { getDefaultUser } from './utils';

const defaultGeminiModels = ['gemini-3-pro-preview', 'gemini-2.5-flash'];
const defaultOpenAIModels = ['gpt-5.2', 'gpt-5.2-chat-latest'];
const defaultAnthropicModels = ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
const defaultGroqModels = ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905'];
const defaultCerebrasModels = ['zai-glm-4.6']

async function setupChatModelProvider(providerName: string, modelType: 'openai' | 'google' | 'anthropic', apiKey: string, defaultModels: string[], visionEnabled: boolean, apiBaseUrl?: string) {
    const [existingProvider] = await db.select().from(AiModelApi).where(eq(AiModelApi.name, providerName));
    if (existingProvider) {
        console.log(`${providerName} provider already exists.`);
        return;
    }

    const [apiProvider] = await db.insert(AiModelApi).values({
        name: providerName,
        apiKey: apiKey,
        apiBaseUrl: apiBaseUrl,
    }).returning();

    for (const model of defaultModels) {
        await db.insert(ChatModel).values({
            name: model,
            friendlyName: model,
            modelType: modelType,
            visionEnabled: visionEnabled,
            aiModelApiId: apiProvider?.id,
        });
    }
    console.log(`🤖 Added ${providerName} ai models.`);
}

export async function initializeDatabase() {
    // 1. Create Admin User
    const adminUserEmail = getDefaultUser().email;
    const adminUserPassword = getDefaultUser().password;

    const [existingAdmin] = await db.select().from(User).where(eq(User.email, adminUserEmail));

    if (!existingAdmin) {
        console.log(`👩‍✈️ Creating admin user: ${adminUserEmail}. These credentials will allow you to configure your server at /server/admin.`);
        await db.insert(User).values({
            email: adminUserEmail,
            username: adminUserEmail,
            password: adminUserPassword, // Note: Storing plaintext password. In production, this should be hashed.
        });
    }

    // 2. Create Chat Model Configurations - only if no chat models exist
    const existingChatModels = await db.select().from(ChatModel).limit(1);

    if (existingChatModels.length === 0) {
        if (process.env.CEREBRAS_API_KEY) {
            await setupChatModelProvider('Cerebras', 'openai', process.env.CEREBRAS_API_KEY, defaultCerebrasModels, true, "https://api.cerebras.ai/v1");
        }
        else if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL == 'https://api.cerebras.ai/v1') {
            await setupChatModelProvider('Cerebras', 'openai', process.env.OPENAI_API_KEY, defaultCerebrasModels, true, process.env.OPENAI_BASE_URL);
        }
        if (process.env.GROQ_API_KEY) {
            await setupChatModelProvider('Groq', 'openai', process.env.GROQ_API_KEY, defaultGroqModels, true, "https://api.groq.com/openai/v1");
        }
        else if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL == 'https://api.groq.com/openai/v1') {
            await setupChatModelProvider('Groq', 'openai', process.env.OPENAI_API_KEY, defaultGroqModels, true, process.env.OPENAI_BASE_URL);
        }
        if (process.env.OPENAI_API_KEY && (!process.env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL == 'https://api.openai.com/v1')) {
            await setupChatModelProvider('OpenAI', 'openai', process.env.OPENAI_API_KEY, defaultOpenAIModels, true, process.env.OPENAI_BASE_URL);
        }
        if (process.env.GEMINI_API_KEY) {
            await setupChatModelProvider('Google Gemini', 'google', process.env.GEMINI_API_KEY, defaultGeminiModels, true);
        }
        if (process.env.ANTHROPIC_API_KEY) {
            await setupChatModelProvider('Anthropic', 'anthropic', process.env.ANTHROPIC_API_KEY, defaultAnthropicModels, true);
        }
    }

    console.log('📀 Database initialization complete.');
}
