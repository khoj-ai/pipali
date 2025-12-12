/**
 * ATIF Conversation Service
 * Manages conversation storage and retrieval in ATIF format
 */

import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../../db';
import { Conversation, User } from '../../../db/schema';
import { createEmptyATIFTrajectory } from './atif.types';
import type {
  ATIFTrajectory,
  ATIFStep,
  ATIFToolCall,
  ATIFObservation,
  ATIFMetrics,
  ATIFStepSource,
} from './atif.types';
import {
  addStepToTrajectory,
  validateATIFTrajectory,
  exportATIFTrajectory,
  importATIFTrajectory,
  calculateFinalMetrics,
} from './atif.utils';

export interface ConversationWithTrajectory {
  id: string;
  userId: number;
  trajectory: ATIFTrajectory;
  slug?: string | null;
  title?: string | null;
  agentId?: number | null;
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
    agentName: string = 'panini-agent',
    agentVersion: string = '1.0.0',
    modelName: string = 'unknown',
    title?: string,
    agentId?: number
  ): Promise<ConversationWithTrajectory> {
    const sessionId = uuidv4();

    const trajectory = createEmptyATIFTrajectory(
      sessionId,
      agentName,
      agentVersion,
      modelName
    );

    // Generate a unique slug
    const tempId = uuidv4();
    const slug = tempId.substring(0, 8);

    // Build insert data object with required fields
    const insertData: {
      userId: number;
      trajectory: ATIFTrajectory;
      slug: string;
      title?: string;
      agentId?: number;
    } = {
      userId: user.id,
      trajectory: trajectory,
      slug: slug,
    };

    // Add optional fields only if provided
    if (title) {
      insertData.title = title;
    }
    if (agentId) {
      insertData.agentId = agentId;
    }

    console.log('[ATIF Service] Creating conversation:', {
      userId: insertData.userId,
      slug: insertData.slug,
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
    reasoningContent?: string
  ): Promise<ATIFStep> {
    const conversation = await this.getConversation(conversationId);

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const trajectory = conversation.trajectory;

    // Add new step to trajectory
    const step = addStepToTrajectory(
      trajectory,
      source,
      message,
      toolCalls,
      observation,
      metrics
    );

    // Add reasoning content if provided
    if (reasoningContent) {
      step.reasoning_content = reasoningContent;
    }

    // Recalculate final metrics
    trajectory.final_metrics = calculateFinalMetrics(trajectory.steps);

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

    const conversationId = uuidv4();
    const [newConversation] = await db.insert(Conversation).values({
      id: conversationId,
      userId,
      trajectory,
      title: title || `Imported: ${trajectory.session_id}`,
      slug: conversationId.substring(0, 8),
    }).returning();

    if (!newConversation) {
      throw new Error('Failed to import conversation');
    }

    return newConversation as ConversationWithTrajectory;
  }

}

// Export singleton instance
export const atifConversationService = new ATIFConversationService();