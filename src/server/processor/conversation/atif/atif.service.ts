/**
 * ATIF Conversation Service
 * Manages conversation storage and retrieval in ATIF format
 */

import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../../db';
import { Conversation, User } from '../../../db/schema';
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
  addStepToTrajectory,
  removeStepFromTrajectory,
  removeTurnFromTrajectory,
  removeAgentMessageFromTrajectory,
  validateATIFTrajectory,
  exportATIFTrajectory,
  importATIFTrajectory,
} from './atif.utils';
import { createChildLogger } from '../../../logger';

const log = createChildLogger({ component: 'atif' });

export interface ConversationWithTrajectory {
  id: string;
  userId: number;
  trajectory: ATIFTrajectory;
  title?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Service class for managing conversations with ATIF support
 */
export class ATIFConversationService {
  /**
   * Creates a new conversation with ATIF trajectory
   */
  async createConversation(
    user: typeof User.$inferSelect,
    agentName: string = 'pipali-agent',
    agentVersion: string = '1.0.0',
    modelName: string = 'unknown',
    title?: string,
  ): Promise<ConversationWithTrajectory> {
    const sessionId = uuidv4();

    const trajectory = createEmptyATIFTrajectory(
      sessionId,
      agentName,
      agentVersion,
      modelName
    );

    // Build insert data object with required fields
    const insertData: {
      userId: number;
      trajectory: ATIFTrajectory;
      title?: string;
    } = {
      userId: user.id,
      trajectory: trajectory,
    };

    // Add optional fields only if provided
    if (title) {
      insertData.title = title;
    }

    log.debug({
      userId: insertData.userId,
      hasTrajectory: !!insertData.trajectory,
      trajectoryValid: validateATIFTrajectory(insertData.trajectory).valid,
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
      return newConversation as ConversationWithTrajectory;
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

    return conversation as ConversationWithTrajectory;
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
  ): Promise<ATIFStep> {
    const conversation = await this.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const trajectory = conversation.trajectory;

    // Add step to trajectory
    const step = addStepToTrajectory(
      trajectory,
      source,
      message,
      toolCalls,
      observation,
      metrics,
    );

    // Add reasoning content if provided
    if (reasoningContent) {
      step.reasoning_content = reasoningContent;
    }

    // Store raw LLM response for multi-turn passthrough
    if (rawOutput && rawOutput.length > 0) {
      step.extra = { ...step.extra, raw_output: rawOutput };
    }

    // Update database
    await db
      .update(Conversation)
      .set({
        trajectory,
        updatedAt: new Date(),
      })
      .where(eq(Conversation.id, conversationId));

    return step;
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
    const removed = removeStepFromTrajectory(trajectory, stepId);

    if (!removed) {
      return false;
    }

    // Update database
    await db
      .update(Conversation)
      .set({
        trajectory,
        updatedAt: new Date(),
      })
      .where(eq(Conversation.id, conversationId));

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
    const removedCount = removeTurnFromTrajectory(trajectory, stepId);

    if (removedCount === 0) {
      return 0;
    }

    // Update database
    await db
      .update(Conversation)
      .set({
        trajectory,
        updatedAt: new Date(),
      })
      .where(eq(Conversation.id, conversationId));

    return removedCount;
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
    const removedCount = removeAgentMessageFromTrajectory(trajectory, stepId);

    if (removedCount === 0) {
      return 0;
    }

    // Update database
    await db
      .update(Conversation)
      .set({
        trajectory,
        updatedAt: new Date(),
      })
      .where(eq(Conversation.id, conversationId));

    return removedCount;
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
    const [newConversation] = await db.insert(Conversation).values({
      id: conversationId,
      userId,
      trajectory,
      title: title,
    }).returning();

    if (!newConversation) {
      throw new Error('Failed to import conversation');
    }

    return newConversation as ConversationWithTrajectory;
  }

  /**
   * Forks an existing conversation with its complete history.
   * Creates a new conversation with a copy of all steps from the source.
   */
  async forkConversation(
    sourceConversationId: string,
    user: typeof User.$inferSelect,
    title?: string,
  ): Promise<ConversationWithTrajectory> {
    const sourceConversation = await this.getConversation(sourceConversationId);

    if (!sourceConversation) {
      throw new Error(`Source conversation ${sourceConversationId} not found`);
    }

    // Create a deep copy of the trajectory
    const sourceTrajectory = sourceConversation.trajectory;
    const newSessionId = uuidv4();
    const newTrajectory: ATIFTrajectory = {
      ...sourceTrajectory,
      session_id: newSessionId,
      steps: [...sourceTrajectory.steps], // Copy all steps including history
      final_metrics: sourceTrajectory.final_metrics ? {
        total_prompt_tokens: sourceTrajectory.final_metrics.total_prompt_tokens || 0,
        total_completion_tokens: sourceTrajectory.final_metrics.total_completion_tokens || 0,
        total_cached_tokens: sourceTrajectory.final_metrics.total_cached_tokens || 0,
        total_cost_usd: sourceTrajectory.final_metrics.total_cost_usd,
        total_steps: sourceTrajectory.final_metrics.total_steps,
      } : undefined,
    };

    // Build insert data
    const insertData: {
      userId: number;
      trajectory: ATIFTrajectory;
      title?: string;
    } = {
      userId: user.id,
      trajectory: newTrajectory,
    };

    if (title) {
      insertData.title = title;
    }

    log.debug({
      sourceId: sourceConversationId,
      userId: insertData.userId,
      stepCount: newTrajectory.steps.length,
    }, 'Forking conversation');

    try {
      const [newConversation] = await db
        .insert(Conversation)
        .values(insertData)
        .returning();

      if (!newConversation) {
        throw new Error('Failed to fork conversation');
      }

      log.debug({ conversationId: newConversation.id }, 'Conversation forked');
      return newConversation as ConversationWithTrajectory;
    } catch (error) {
      log.error({ err: error }, 'Error forking conversation');
      throw error;
    }
  }

}

// Export singleton instance
export const atifConversationService = new ATIFConversationService();