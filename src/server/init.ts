import { db } from './db';
import { User, AiModelApi, ChatModel, McpServer } from './db/schema';
import { eq } from 'drizzle-orm';
import { getDefaultUser } from './utils';
import { createChildLogger } from './logger';

const log = createChildLogger({ component: 'init' });

const defaultGeminiModels = ['gemini-3-pro-preview', 'gemini-2.5-flash'];
const defaultOpenAIModels = ['gpt-5.2'];
const defaultAnthropicModels = ['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];

async function setupChatModelProvider(providerName: string, modelType: 'openai' | 'google' | 'anthropic', apiKey: string, defaultModels: string[], visionEnabled: boolean, apiBaseUrl?: string) {
    const [existingProvider] = await db.select().from(AiModelApi).where(eq(AiModelApi.name, providerName));
    if (existingProvider) {
        log.info(`${providerName} provider already exists.`);
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
    log.info(`🤖 Added ${providerName} ai models.`);
}

export async function initializeDatabase() {
    // 1. Create Admin User
    const adminUserEmail = getDefaultUser().email;
    const adminUserPassword = getDefaultUser().password;

    const [existingAdmin] = await db.select().from(User).where(eq(User.email, adminUserEmail));

    if (!existingAdmin) {
        log.info(`👩‍✈️ Creating admin user: ${adminUserEmail}. These credentials will allow you to configure your server at /server/admin.`);
        await db.insert(User).values({
            email: adminUserEmail,
            username: adminUserEmail,
            password: adminUserPassword, // Note: Storing plaintext password. In production, this should be hashed.
        });
    }

    // 2. Create Chat Model Configurations - only if no chat models exist
    const existingChatModels = await db.select().from(ChatModel).limit(1);

    if (existingChatModels.length === 0) {
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

    // 3. Setup default MCP servers
    await setupDefaultMcpServers();

    log.info('📀 Database initialization complete.');
}

/**
 * Setup default MCP servers that come pre-installed.
 */
async function setupDefaultMcpServers(): Promise<void> {
    // Chrome Browser MCP - enables browser automation capabilities
    const chromeBrowserName = 'chrome-browser';
    const [existingChromeBrowser] = await db
        .select()
        .from(McpServer)
        .where(eq(McpServer.name, chromeBrowserName));

    if (!existingChromeBrowser) {
        await db.insert(McpServer).values({
            name: chromeBrowserName,
            description: 'Use to interact with pages that require login and/or UX interactions. Useful when normal webpage read, web search tools do not suffice.',
            transportType: 'stdio',
            path: 'chrome-devtools-mcp@latest --autoConnect',
            requiresConfirmation: true,
            enabled: true,
            enabledTools: [
                'click',
                'close_page',
                'drag',
                'evaluate_script',
                'fill',
                'fill_form',
                'handle_dialog',
                'hover',
                'list_pages',
                'navigate_page',
                'new_page',
                'press_key',
                'select_page',
                'take_screenshot',
                'take_snapshot',
                'upload_file',
                'wait_for',
            ],
        });
        log.info('🌐 Added Chrome Browser MCP server.');
    }
}
