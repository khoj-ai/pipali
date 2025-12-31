/**
 * Automation API Routes
 *
 * Endpoints for managing event-triggered tasks (automations).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db';
import { Automation, AutomationExecution, User } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { getDefaultUser } from '../utils';
import {
    queueExecution,
    respondToConfirmation,
    getPendingConfirmations,
    activateAutomation,
    deactivateAutomation,
    reloadAutomation,
    type TriggerConfig,
    type TriggerEventData,
} from '../automation';

const automations = new Hono();

// ============== VALIDATION SCHEMAS ==============

const cronTriggerSchema = z.object({
    type: z.literal('cron'),
    schedule: z.string().min(1),
    timezone: z.string().optional(),
});

const fileWatchTriggerSchema = z.object({
    type: z.literal('file_watch'),
    paths: z.array(z.string()).min(1),
    events: z.array(z.enum(['create', 'modify', 'delete'])).min(1),
    pattern: z.string().optional(),
    debounceMs: z.number().min(0).optional(),
});

const triggerConfigSchema = z.discriminatedUnion('type', [
    cronTriggerSchema,
    fileWatchTriggerSchema,
]);

const createAutomationSchema = z.object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    prompt: z.string().min(1),
    triggerType: z.enum(['cron', 'file_watch']).optional(),
    triggerConfig: triggerConfigSchema.optional(),
    maxIterations: z.number().min(1).max(50).optional(),
    maxExecutionsPerDay: z.number().min(1).optional(),
    maxExecutionsPerHour: z.number().min(1).optional(),
});

const confirmationResponseSchema = z.object({
    selectedOptionId: z.string(),
    persistPreference: z.boolean().optional(),
    guidance: z.string().optional(),
});

// ============== STATIC ROUTES (must come before /:id routes) ==============

// Get single execution details
automations.get('/executions/:id', async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid execution ID' }, 400);
    }

    const [execution] = await db.select()
        .from(AutomationExecution)
        .where(eq(AutomationExecution.id, id));

    if (!execution) return c.json({ error: 'Not found' }, 404);

    return c.json({ execution });
});

// ============== CONFIRMATIONS ==============
// Get pending confirmations for user
automations.get('/confirmations/pending', async (c) => {
    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!user) return c.json({ error: 'User not found' }, 404);

    const pending = await getPendingConfirmations(user.id);
    // Serialize dates for JSON response
    const serialized = pending.map(p => ({
        ...p,
        expiresAt: p.expiresAt.toISOString(),
    }));
    return c.json({ confirmations: serialized });
});

// Respond to a pending confirmation
automations.post('/confirmations/:id/respond', zValidator('json', confirmationResponseSchema), async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid confirmation ID' }, 400);
    }

    const data = c.req.valid('json');

    const success = await respondToConfirmation(id, {
        requestId: id,
        selectedOptionId: data.selectedOptionId,
        guidance: data.guidance,
        persistPreference: data.persistPreference,
        timestamp: new Date().toISOString(),
    });

    if (!success) {
        return c.json({ error: 'Confirmation not found or already processed' }, 404);
    }

    console.log(`[API] Confirmation ${id} responded: ${data.selectedOptionId}${data.guidance ? ' with guidance' : ''}`);
    return c.json({ success: true });
});

// ============== AUTOMATION CRUD ==============

// List all automations for user
automations.get('/', async (c) => {
    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!user) return c.json({ error: 'User not found' }, 404);

    const allAutomations = await db.select()
        .from(Automation)
        .where(eq(Automation.userId, user.id))
        .orderBy(desc(Automation.createdAt));

    const result = allAutomations.map((automation) => ({
        id: automation.id,
        name: automation.name,
        description: automation.description,
        prompt: automation.prompt,
        triggerType: automation.triggerType,
        triggerConfig: automation.triggerConfig,
        status: automation.status,
        conversationId: automation.conversationId,
        maxIterations: automation.maxIterations,
        maxExecutionsPerDay: automation.maxExecutionsPerDay,
        maxExecutionsPerHour: automation.maxExecutionsPerHour,
        lastExecutedAt: automation.lastExecutedAt?.toISOString(),
        nextScheduledAt: automation.nextScheduledAt?.toISOString(),
        createdAt: automation.createdAt.toISOString(),
        updatedAt: automation.updatedAt.toISOString(),
    }));

    return c.json({ automations: result });
});

// Get single automation
automations.get('/:id', async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid automation ID' }, 400);
    }

    const [automation] = await db.select()
        .from(Automation)
        .where(eq(Automation.id, id));

    if (!automation) return c.json({ error: 'Not found' }, 404);

    return c.json({ automation });
});

// Create automation
automations.post('/', zValidator('json', createAutomationSchema), async (c) => {
    const data = c.req.valid('json');

    const [user] = await db.select().from(User).where(eq(User.email, getDefaultUser().email));
    if (!user) return c.json({ error: 'User not found' }, 404);

    const insertResult = await db.insert(Automation)
        .values({
            userId: user.id,
            name: data.name,
            description: data.description,
            prompt: data.prompt,
            triggerType: data.triggerType || null,
            triggerConfig: (data.triggerConfig as TriggerConfig) || null,
            maxIterations: data.maxIterations || 15,
            maxExecutionsPerDay: data.maxExecutionsPerDay,
            maxExecutionsPerHour: data.maxExecutionsPerHour,
            status: 'active',
        })
        .returning();

    const automation = insertResult[0];
    if (!automation) {
        return c.json({ error: 'Failed to create automation' }, 500);
    }

    // Start the scheduler/watcher for this automation (only if it has a trigger)
    if (automation.triggerType && automation.triggerConfig) {
        await activateAutomation(automation);
    }

    console.log(`[API] Created automation: ${automation.name} (${automation.id})`);
    return c.json({ automation }, 201);
});

// Update automation
automations.put('/:id', zValidator('json', createAutomationSchema.partial()), async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid automation ID' }, 400);
    }

    const data = c.req.valid('json');

    const [automation] = await db.update(Automation)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(Automation.id, id))
        .returning();

    if (!automation) return c.json({ error: 'Not found' }, 404);

    // Reload scheduler/watcher if trigger changed
    await reloadAutomation(automation.id);

    console.log(`[API] Updated automation: ${automation.name} (${automation.id})`);
    return c.json({ automation });
});

// Delete automation
automations.delete('/:id', async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid automation ID' }, 400);
    }

    // Stop any running schedulers/watchers
    await deactivateAutomation(id);

    await db.delete(Automation).where(eq(Automation.id, id));

    console.log(`[API] Deleted automation: ${id}`);
    return c.json({ success: true });
});

// ============== AUTOMATION CONTROL ==============

// Pause automation
automations.post('/:id/pause', async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid automation ID' }, 400);
    }

    await db.update(Automation)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(eq(Automation.id, id));

    await deactivateAutomation(id);

    console.log(`[API] Paused automation: ${id}`);
    return c.json({ success: true });
});

// Resume automation
automations.post('/:id/resume', async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid automation ID' }, 400);
    }

    const [automation] = await db.update(Automation)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(Automation.id, id))
        .returning();

    if (automation) {
        await activateAutomation(automation);
    }

    console.log(`[API] Resumed automation: ${id}`);
    return c.json({ success: true });
});

// Manually trigger automation
automations.post('/:id/trigger', async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid automation ID' }, 400);
    }

    const [automation] = await db.select()
        .from(Automation)
        .where(eq(Automation.id, id));

    if (!automation) return c.json({ error: 'Not found' }, 404);

    const triggerData: TriggerEventData = {
        type: 'external',
        timestamp: new Date().toISOString(),
        external: { source: 'api', metadata: {} },
    };

    const executionId = await queueExecution(id, triggerData);

    if (!executionId) {
        return c.json({ error: 'Failed to queue execution (rate limit or inactive)' }, 429);
    }

    console.log(`[API] Manually triggered automation: ${id}, execution: ${executionId}`);
    return c.json({ success: true, executionId });
});

// ============== EXECUTIONS ==============

// Get execution history for an automation
automations.get('/:id/executions', async (c) => {
    const id = c.req.param('id');
    try {
        z.uuid().parse(id);
    } catch {
        return c.json({ error: 'Invalid automation ID' }, 400);
    }

    const limit = parseInt(c.req.query('limit') || '20');

    const executions = await db.select()
        .from(AutomationExecution)
        .where(eq(AutomationExecution.automationId, id))
        .orderBy(desc(AutomationExecution.createdAt))
        .limit(limit);

    return c.json({
        executions: executions.map(e => ({
            id: e.id,
            status: e.status,
            triggerData: e.triggerData,
            startedAt: e.startedAt?.toISOString(),
            completedAt: e.completedAt?.toISOString(),
            errorMessage: e.errorMessage,
            retryCount: e.retryCount,
            createdAt: e.createdAt.toISOString(),
        })),
    });
});

export default automations;
