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
  removeAgentMessageFromTrajectory,
  validateATIFTrajectory,
  exportATIFTrajectory,
  importATIFTrajectory,
} from './atif.utils';

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

    console.log('[ATIF Service] Creating conversation:', {
      userId: insertData.userId,
      hasTrajectory: !!insertData.trajectory,
      trajectoryValid: validateATIFTrajectory(insertData.trajectory).valid,
    });

    try {
      const [newConversation] = await db
        .insert(Conversation)
        .values(insertData)
        .returning();

      if (!newConversation) {
        throw new Error('Failed to create conversation');
      }

      console.log('[ATIF Service] ✅ Conversation created:', newConversation.id);
      return newConversation as ConversationWithTrajectory;
    } catch (error) {
      console.error('[ATIF Service] ❌ Error creating conversation:', error);
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

}

// Export singleton instance
export const atifConversationService = new ATIFConversationService();