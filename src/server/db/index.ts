import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { getDbName, getPGliteConfig } from './utils';
import { AiModelApi, ChatModel, User, UserChatModel, type ChatModelWithApi } from './schema';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'db' });

const dbName = getDbName();
const config = await getPGliteConfig();
export const client = await PGlite.create(dbName, config);
export const db = drizzle(client);

/** Gracefully close the database connection */
export async function closeDatabase(): Promise<void> {
    log.info('Closing database connection...');
    await client.close();
    log.info('Database connection closed.');
}

export async function getDefaultChatModel(user?: typeof User.$inferSelect, fallbackChatModel?: typeof ChatModel.$inferSelect): Promise<ChatModelWithApi | undefined> {
    // Use default chat model if set
    if (fallbackChatModel) {
        log.info(`Using fallback/agent chat model: ${fallbackChatModel.name}`);
        const [aiModelApi] = fallbackChatModel.aiModelApiId ? await db.select().from(AiModelApi).where(eq(AiModelApi.id, fallbackChatModel.aiModelApiId)) : [];
        return { chatModel: fallbackChatModel, aiModelApi: aiModelApi ?? null };
    }
    // Else Use user's default chat model if set
    if (user) {
        const [userChatModel] = await db.select().from(UserChatModel).where(eq(UserChatModel.userId, user.id)).limit(1);
        if (userChatModel?.modelId) {
            log.info(`Found user model selection: modelId=${userChatModel.modelId}`);
            const [result] = await db.select({ chatModel: ChatModel, aiModelApi: AiModelApi }).from(ChatModel).leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id)).where(eq(ChatModel.id, userChatModel.modelId));
            if (result) {
                log.info(`Using user's selected model: ${result.chatModel.name}`);
                return { chatModel: result.chatModel, aiModelApi: result.aiModelApi };
            }
        } else {
            log.info(`No user model selection found for user ${user.id}`);
        }
    }
    // Else fallback to first chat model defined in the database
    log.info(`Falling back to first available model`);
    const [result] = await db.select({ chatModel: ChatModel, aiModelApi: AiModelApi }).from(ChatModel).leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id)).limit(1);
    if (result) {
        log.info(`Using fallback model: ${result.chatModel.name}`);
    }
    return result ? { chatModel: result.chatModel, aiModelApi: result.aiModelApi } : undefined;
}
