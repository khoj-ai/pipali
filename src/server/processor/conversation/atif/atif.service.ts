/**
 * ATIF Conversation Service
 * Manages conversation storage and retrieval in ATIF format
 */

import { asc, eq, and, inArray, isNull, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, getDefaultChatModel } from '../../../db';
import { Conversation, ConversationStep, User } from '../../../db/schema';
import { createEmptyATIFTrajectory } from './atif.types';
import {
  type ATIFTrajectory,
  type ATIFStep,
  type ATIFToolCall,
  type ATIFObservation,
  type ATIFMetrics,
  type ATIFStepSource,
} from './atif.types';
import {
  removeStepFromTrajectory,
  removeTurnFromTrajectory,
  removeAgentMessageFromTrajectory,
  validateATIFTrajectory,
  exportATIFTrajectory,
  importATIFTrajectory,
  calculateFinalMetrics,
  accumulateFinalMetrics,
  sanitizeForJsonb,
} from './atif.utils';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'atif' });

export type ConversationRole = 'manual' | 'delegated';

export interface ConversationWithTrajectory {
  id: string;
  userId: number;
  trajectory: ATIFTrajectory;
  title?: string | null;
  chatModelId?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

type ConversationRow = typeof Conversation.$inferSelect;

function buildTrajectory(conversation: ConversationRow, steps: ATIFStep[]): ATIFTrajectory {
  const trajectory: ATIFTrajectory = {
    schema_version: conversation.schemaVersion,
    session_id: conversation.sessionId,
    agent: conversation.agent,
    steps,
  };

  if (conversation.finalMetrics) {
    trajectory.final_metrics = conversation.finalMetrics;
  }
  if (conversation.extra) {
    trajectory.extra = conversation.extra;
  }

  return trajectory;
}

function withTrajectory(conversation: ConversationRow, steps: ATIFStep[]): ConversationWithTrajectory {
  return {
    id: conversation.id,
    userId: conversation.userId,
    trajectory: buildTrajectory(conversation, steps),
    title: conversation.title,
    chatModelId: conversation.chatModelId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function getStepTimestamp(step: ATIFStep): Date {
  const date = new Date(step.timestamp);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function getMessagePreview(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  return message.slice(0, 240);
}

/**
 * Service class for managing conversations with ATIF support
 */
export class ATIFConversationService {
  private async getSteps(conversationId: string): Promise<ATIFStep[]> {
    const rows = await db
      .select({ step: ConversationStep.step })
      .from(ConversationStep)
      .where(eq(ConversationStep.conversationId, conversationId))
      .orderBy(asc(ConversationStep.stepId));

    return rows.map(row => row.step);
  }

  /**
   * Creates a new conversation with ATIF trajectory
   */
  async createConversation(
    user: typeof User.$inferSelect,
    agentName: string = 'pipali-agent',
    agentVersion: string = '1.0.0',
    modelName: string = 'unknown',
    title?: string,
    chatModelId?: number,
  ): Promise<ConversationWithTrajectory> {
    const sessionId = uuidv4();

    const trajectory = createEmptyATIFTrajectory(
      sessionId,
      agentName,
      agentVersion,
      modelName
    );

    const insertData: {
      userId: number;
      schemaVersion: string;
      sessionId: string;
      agent: ATIFTrajectory['agent'];
      finalMetrics?: ATIFTrajectory['final_metrics'];
      extra?: Record<string, unknown>;
      title?: string;
      chatModelId?: number;
    } = {
      userId: user.id,
      schemaVersion: trajectory.schema_version,
      sessionId: trajectory.session_id,
      agent: trajectory.agent,
    };

    if (trajectory.final_metrics) {
      insertData.finalMetrics = trajectory.final_metrics;
    }
    if (trajectory.extra) {
      insertData.extra = trajectory.extra;
    }
    if (title) {
      insertData.title = title;
    }
    if (chatModelId) {
      insertData.chatModelId = chatModelId;
    }

    log.debug({
      userId: insertData.userId,
      sessionId: insertData.sessionId,
      trajectoryValid: validateATIFTrajectory(trajectory).valid,
    }, 'Creating conversation');

    try {
      const [newConversation] = await db
        .insert(Conversation)
        .values(insertData)
        .returning();

      if (!newConversation) {
        throw new Error('Failed to create conversation');
      }

      log.debug({ conversationId: newConversation.id }, 'Conversation created');
      return withTrajectory(newConversation, []);
    } catch (error) {
      log.error({ err: error }, 'Error creating conversation');
      throw error;
    }
  }

  /**
   * Gets a conversation by ID
   */
  async getConversation(conversationId: string): Promise<ConversationWithTrajectory | null> {
    const [conversation] = await db
      .select()
      .from(Conversation)
      .where(eq(Conversation.id, conversationId));

    if (!conversation) {
      return null;
    }

    const steps = await this.getSteps(conversationId);
    return withTrajectory(conversation, steps);
  }

  /**
   * Whether a conversation was delegated by an agent. Derived from the parent link
   * rather than stored, so it can never disagree with its source.
   */
  async getConversationRole(
    conversationId: string,
    _user: typeof User.$inferSelect,
  ): Promise<ConversationRole> {
    const [conversation] = await db
      .select({ parentConversationId: Conversation.parentConversationId })
      .from(Conversation)
      .where(eq(Conversation.id, conversationId));

    return conversation?.parentConversationId ? 'delegated' : 'manual';
  }

  /**
   * Adds a step to a conversation
   */
  async addStep(
    conversationId: string,
    source: ATIFStepSource,
    message: string,
    metrics?: ATIFMetrics,
    toolCalls?: ATIFToolCall[],
    observation?: ATIFObservation,
    reasoningContent?: string,
    rawOutput?: unknown[],
    extra?: Record<string, unknown>,
  ): Promise<ATIFStep> {
    return await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT
          id,
          final_metrics
        FROM conversation
        WHERE id = ${conversationId}
        FOR UPDATE
      `);
      const conversation = locked.rows[0] as { final_metrics: ConversationRow['finalMetrics'] } | undefined;

      if (!conversation) {
        throw new Error(`Conversation ${conversationId} not found`);
      }

      const [stats] = await tx
        .select({
          maxStepId: sql<number>`coalesce(max(${ConversationStep.stepId}), 0)::int`,
          stepCount: sql<number>`count(*)::int`,
        })
        .from(ConversationStep)
        .where(eq(ConversationStep.conversationId, conversationId));

      const step: ATIFStep = {
        step_id: Number(stats?.maxStepId ?? 0) + 1,
        timestamp: new Date().toISOString(),
        source,
        message,
        tool_calls: toolCalls,
        observation,
        metrics,
      };

      if (reasoningContent) {
        step.reasoning_content = reasoningContent;
      }
      if (rawOutput && rawOutput.length > 0) {
        step.extra = { ...step.extra, raw_output: rawOutput };
      }
      if (extra) {
        step.extra = { ...step.extra, ...extra };
      }

      const finalMetrics = accumulateFinalMetrics(
        conversation.final_metrics,
        metrics,
        Number(stats?.stepCount ?? 0) + 1,
      );
      const now = new Date();
      const sanitizedStep = sanitizeForJsonb(step);

      await tx.insert(ConversationStep).values({
        conversationId,
        stepId: step.step_id,
        source,
        timestamp: getStepTimestamp(step),
        messagePreview: getMessagePreview(message),
        step: sanitizedStep,
        createdAt: now,
        updatedAt: now,
      });

      await tx
        .update(Conversation)
        .set({
          finalMetrics: sanitizeForJsonb(finalMetrics),
          updatedAt: now,
        })
        .where(eq(Conversation.id, conversationId));

      return sanitizedStep;
    });
  }

  private async persistStepDeletions(
    conversationId: string,
    beforeSteps: ATIFStep[],
    afterSteps: ATIFStep[],
  ): Promise<number> {
    const afterIds = new Set(afterSteps.map(step => step.step_id));
    const removedIds = beforeSteps
      .map(step => step.step_id)
      .filter(stepId => !afterIds.has(stepId));

    if (removedIds.length === 0) {
      return 0;
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(ConversationStep)
        .where(and(
          eq(ConversationStep.conversationId, conversationId),
          inArray(ConversationStep.stepId, removedIds),
        ));

      await tx
        .update(Conversation)
        .set({
          finalMetrics: sanitizeForJsonb(calculateFinalMetrics(afterSteps)),
          updatedAt: new Date(),
        })
        .where(eq(Conversation.id, conversationId));
    });

    return removedIds.length;
  }

  /**
   * Deletes a step from a conversation by step_id
   * Returns true if the step was found and deleted, false otherwise
   */
  async deleteStep(conversationId: string, stepId: number): Promise<boolean> {
    const conversation = await this.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const trajectory = conversation.trajectory;
    const beforeSteps = [...trajectory.steps];
    const removed = removeStepFromTrajectory(trajectory, stepId);

    if (!removed) {
      return false;
    }

    await this.persistStepDeletions(conversationId, beforeSteps, trajectory.steps);

    return true;
  }

  /**
   * Deletes a user message and the following assistant message (all agent steps until
   * the next user message) from a conversation. Also removes any intermediate user
   * messages between the deleted user message and the following assistant message's end.
   * Returns the number of steps deleted.
   */
  async deleteTurn(conversationId: string, stepId: number): Promise<number> {
    const conversation = await this.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const trajectory = conversation.trajectory;
    const beforeSteps = [...trajectory.steps];
    const removedCount = removeTurnFromTrajectory(trajectory, stepId);

    if (removedCount === 0) {
      return 0;
    }

    return await this.persistStepDeletions(conversationId, beforeSteps, trajectory.steps);
  }

  /**
   * Deletes an agent message and all associated steps (reasoning, tool calls, etc.)
   * from a conversation. Removes all consecutive agent steps from the given step_id
   * until the next user message or end of conversation.
   * Returns the number of steps deleted.
   */
  async deleteAgentMessage(conversationId: string, stepId: number): Promise<number> {
    const conversation = await this.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const trajectory = conversation.trajectory;
    const beforeSteps = [...trajectory.steps];
    const removedCount = removeAgentMessageFromTrajectory(trajectory, stepId);

    if (removedCount === 0) {
      return 0;
    }

    return await this.persistStepDeletions(conversationId, beforeSteps, trajectory.steps);
  }

  /**
   * Exports a conversation in ATIF format
   */
  async exportConversationAsATIF(conversationId: string): Promise<string> {
    const conversation = await this.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    return exportATIFTrajectory(conversation.trajectory);
  }

  /**
   * Imports a conversation from ATIF format
   */
  async importConversationFromATIF(
    userId: number,
    atifJson: string,
    title?: string
  ): Promise<ConversationWithTrajectory> {
    const trajectory = importATIFTrajectory(atifJson);
    const validation = validateATIFTrajectory(trajectory);

    if (!validation.valid) {
      throw new Error(`Invalid ATIF trajectory: ${validation.errors.join(', ')}`);
    }

    title = title || `Imported: ${trajectory.session_id}`;
    const conversationId = uuidv4();
    const sanitizedTrajectory = sanitizeForJsonb(trajectory);

    const newConversation = await db.transaction(async (tx) => {
      const [created] = await tx.insert(Conversation).values({
        id: conversationId,
        userId,
        schemaVersion: sanitizedTrajectory.schema_version,
        sessionId: sanitizedTrajectory.session_id,
        agent: sanitizedTrajectory.agent,
        finalMetrics: sanitizedTrajectory.final_metrics ?? calculateFinalMetrics(sanitizedTrajectory.steps),
        extra: sanitizedTrajectory.extra,
        title,
      }).returning();

      if (!created) {
        throw new Error('Failed to import conversation');
      }

      if (sanitizedTrajectory.steps.length > 0) {
        await tx.insert(ConversationStep).values(sanitizedTrajectory.steps.map(step => ({
          conversationId,
          stepId: step.step_id,
          source: step.source,
          timestamp: getStepTimestamp(step),
          messagePreview: getMessagePreview(step.message),
          step,
        })));
      }

      return created;
    });

    return withTrajectory(newConversation, sanitizedTrajectory.steps);
  }

  /**
   * Forks an existing conversation with its complete history.
   * Creates a new conversation with a copy of all steps from the source.
   */
  async forkConversation(
    sourceConversationId: string,
    user: typeof User.$inferSelect,
    title?: string,
    chatModelId?: number,
  ): Promise<ConversationWithTrajectory> {
    const sourceConversation = await this.getConversation(sourceConversationId);

    if (!sourceConversation) {
      throw new Error(`Source conversation ${sourceConversationId} not found`);
    }

    // Create a deep copy of the trajectory
    const sourceTrajectory = sourceConversation.trajectory;
    const newSessionId = uuidv4();
    const newTrajectory: ATIFTrajectory = sanitizeForJsonb({
      ...sourceTrajectory,
      session_id: newSessionId,
      steps: [...sourceTrajectory.steps], // Copy all steps including history
      final_metrics: sourceTrajectory.final_metrics ? {
        total_prompt_tokens: sourceTrajectory.final_metrics.total_prompt_tokens || 0,
        total_completion_tokens: sourceTrajectory.final_metrics.total_completion_tokens || 0,
        total_cached_tokens: sourceTrajectory.final_metrics.total_cached_tokens || 0,
        total_cache_write_tokens: sourceTrajectory.final_metrics.total_cache_write_tokens || 0,
        total_cost_usd: sourceTrajectory.final_metrics.total_cost_usd,
        total_steps: sourceTrajectory.final_metrics.total_steps,
      } : undefined,
    });

    // Build insert data
    const insertData: {
      userId: number;
      schemaVersion: string;
      sessionId: string;
      agent: ATIFTrajectory['agent'];
      finalMetrics?: ATIFTrajectory['final_metrics'];
      extra?: Record<string, unknown>;
      title?: string;
      chatModelId?: number;
    } = {
      userId: user.id,
      schemaVersion: newTrajectory.schema_version,
      sessionId: newTrajectory.session_id,
      agent: newTrajectory.agent,
      finalMetrics: newTrajectory.final_metrics,
      extra: newTrajectory.extra,
    };

    if (title) {
      insertData.title = title;
    }
    const forkChatModelId = chatModelId ?? sourceConversation.chatModelId ?? undefined;
    if (forkChatModelId) {
      insertData.chatModelId = forkChatModelId;
    }

    log.debug({
      sourceId: sourceConversationId,
      userId: insertData.userId,
      stepCount: newTrajectory.steps.length,
    }, 'Forking conversation');

    try {
      const newConversation = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(Conversation)
          .values(insertData)
          .returning();

        if (!created) {
          throw new Error('Failed to fork conversation');
        }

        if (newTrajectory.steps.length > 0) {
          await tx.insert(ConversationStep).values(newTrajectory.steps.map(step => ({
            conversationId: created.id,
            stepId: step.step_id,
            source: step.source,
            timestamp: getStepTimestamp(step),
            messagePreview: getMessagePreview(step.message),
            step,
          })));
        }

        return created;
      });

      log.debug({ conversationId: newConversation.id }, 'Conversation forked');
      return withTrajectory(newConversation, newTrajectory.steps);
    } catch (error) {
      log.error({ err: error }, 'Error forking conversation');
      throw error;
    }
  }

  /**
   * Counts non-automation conversations for a user
   */
  async countUserConversations(userId: number): Promise<number> {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(Conversation)
      .where(and(eq(Conversation.userId, userId), isNull(Conversation.automationId)));
    return result?.count ?? 0;
  }
}

// Export singleton instance
export const atifConversationService = new ATIFConversationService();
