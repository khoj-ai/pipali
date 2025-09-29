import { db } from './db';
import { users, aiModelApis, chatModels } from './db/schema';
import { eq } from 'drizzle-orm';
import { getDefaultUser } from './utils';

const defaultOpenAIModels = ['gpt-4.1-mini', 'gpt-4.1', 'o3', 'o4-mini'];
const defaultGeminiModels = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
const defaultAnthropicModels = ['claude-sonnet-4-0', 'claude-3-5-haiku-latest'];

async function setupChatModelProvider(providerName: string, modelType: 'openai' | 'google' | 'anthropic', apiKey: string, defaultModels: string[], visionEnabled: boolean, apiBaseUrl?: string) {
    const [existingProvider] = await db.select().from(aiModelApis).where(eq(aiModelApis.name, providerName));
    if (existingProvider) {
        console.log(`${providerName} provider already exists.`);
        return;
    }

    const [apiProvider] = await db.insert(aiModelApis).values({
        name: providerName,
        apiKey: apiKey,
        apiBaseUrl: apiBaseUrl,
    }).returning();

    for (const model of defaultModels) {
        await db.insert(chatModels).values({
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

    const [existingAdmin] = await db.select().from(users).where(eq(users.email, adminUserEmail));

    if (!existingAdmin) {
        console.log(`👩‍✈️ Creating admin user: ${adminUserEmail}. These credentials will allow you to configure your server at /server/admin.`);
        await db.insert(users).values({
            email: adminUserEmail,
            username: adminUserEmail,
            password: adminUserPassword, // Note: Storing plaintext password. In production, this should be hashed.
        });
    }

    // 2. Create Chat Model Configurations - only if no chat models exist
    const existingChatModels = await db.select().from(chatModels).limit(1);

    if (existingChatModels.length === 0) {
        if (process.env.OPENAI_API_KEY) {
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
