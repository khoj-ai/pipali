import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { getDbName, getPGliteConfig } from './utils';
import { AiModelApi, ChatModel, User, UserChatModel, type ChatModelWithApi } from './schema';

const dbName = getDbName();
const config = await getPGliteConfig();
const client = await PGlite.create(dbName, config);
export const db = drizzle(client);

export async function getDefaultChatModel(user?: typeof User.$inferSelect, fallbackChatModel?: typeof ChatModel.$inferSelect): Promise<ChatModelWithApi | undefined> {
    // Use default chat model if set
    if (fallbackChatModel) {
        const [aiModelApi] = fallbackChatModel.aiModelApiId ? await db.select().from(AiModelApi).where(eq(AiModelApi.id, fallbackChatModel.aiModelApiId)) : [];
        return { chatModel: fallbackChatModel, aiModelApi: aiModelApi ?? null };
    }
    // Else Use user's default chat model if set
    if (user) {
        const [userChatModel] = await db.select().from(UserChatModel).where(eq(UserChatModel.userId, user.id)).limit(1);
        if (userChatModel?.modelId) {
            const [result] = await db.select({ chatModel: ChatModel, aiModelApi: AiModelApi }).from(ChatModel).leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id)).where(eq(ChatModel.id, userChatModel.modelId));
            return result ? { chatModel: result.chatModel, aiModelApi: result.aiModelApi } : undefined;
        }
    }
    // Else fallback to first chat model defined in the database
    const [result] = await db.select({ chatModel: ChatModel, aiModelApi: AiModelApi }).from(ChatModel).leftJoin(AiModelApi, eq(ChatModel.aiModelApiId, AiModelApi.id)).limit(1);
    return result ? { chatModel: result.chatModel, aiModelApi: result.aiModelApi } : undefined;
}
