import { eq } from 'drizzle-orm';
import { db } from '../db';
import { MemorySettings } from '../db/schema';

export interface MemorySettingsConfig {
    memoriesEnabled: boolean;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettingsConfig = {
    memoriesEnabled: true,
};

export async function loadMemorySettings(userId: number): Promise<MemorySettingsConfig> {
    const [settings] = await db
        .select()
        .from(MemorySettings)
        .where(eq(MemorySettings.userId, userId));

    return settings
        ? { memoriesEnabled: settings.memoriesEnabled }
        : { ...DEFAULT_MEMORY_SETTINGS };
}

export async function saveMemorySettings(
    userId: number,
    updates: Partial<MemorySettingsConfig>,
): Promise<MemorySettingsConfig> {
    const [settings] = await db
        .insert(MemorySettings)
        .values({ userId, ...DEFAULT_MEMORY_SETTINGS, ...updates })
        .onConflictDoUpdate({
            target: MemorySettings.userId,
            set: { ...updates, updatedAt: new Date() },
        })
        .returning({ memoriesEnabled: MemorySettings.memoriesEnabled });

    return settings ?? { ...DEFAULT_MEMORY_SETTINGS, ...updates };
}
