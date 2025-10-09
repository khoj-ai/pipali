import { db } from './db';
import { User, AiModelApi, ChatModel } from './db/schema';
import { eq } from 'drizzle-orm';
import { getDefaultUser } from './utils';

const defaultGeminiModels = ['gemini-2.5-flash', 'gemini-2.5-pro'];
const defaultOpenAIModels = ['gpt-5-2025-08-07', 'gpt-5-mini-2025-08-07'];
const defaultAnthropicModels = ['claude-sonnet-4-5-20250929', 'claude-3-5-haiku-latest'];
const defaultGroqModels = ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905'];

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
        if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL == 'https://api.groq.com/openai/v1') {
            await setupChatModelProvider('Groq', 'openai', process.env.OPENAI_API_KEY, defaultGroqModels, true, process.env.OPENAI_BASE_URL);
        }
        else if (process.env.OPENAI_API_KEY) {
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
