/**
 * Ask User Actor
 *
 * Allows the agent to ask users structured questions or send notifications.
 * Reuses the existing confirmation infrastructure for UI display.
 */

import type { ConfirmationContext } from '../confirmation';
import type {
    ConfirmationOption,
    ConfirmationInputType,
    ConfirmationRequest,
} from '../confirmation/confirmation.types';

/**
 * Arguments for the ask_user tool
 */
export interface AskUserArgs {
    /** Short heading for the question or notification (required) */
    title: string;
    /** Longer explanation or question text (optional) */
    description?: string;
    /** Multiple choice option labels. If empty, functions as notification. */
    options?: string[];
    /** Type of input: 'choice' (default) or 'text_input' */
    input_type?: 'choice' | 'text_input';
}

/**
 * Result from the ask_user tool
 */
export interface AskUserResult {
    /** The original question/notification */
    query: string;
    /** Formatted result string for the agent */
    compiled: string;
    /** The selected option label (for choice type) */
    selectedLabel?: string;
    /** User's text input (for text_input type) */
    textInput?: string;
    /** User's free-form response (when they type instead of clicking an option) */
    freeformResponse?: string;
    /** True if the user acknowledged a notification */
    acknowledged?: boolean;
}

/**
 * Create an acknowledge option for notifications
 */
function createAcknowledgeOption(): ConfirmationOption[] {
    return [
        {
            id: 'acknowledge',
            label: 'Acknowledge',
            description: 'Acknowledge this notification',
            style: 'primary',
        },
    ];
}

/**
 * Convert string labels to ConfirmationOption[] with auto-generated IDs
 */
function convertToConfirmationOptions(labels: string[]): ConfirmationOption[] {
    return labels.map((label, index) => ({
        id: `option_${index}`,
        label,
        style: index === 0 ? 'primary' as const : 'secondary' as const,
    }));
}

/**
 * Create a ConfirmationRequest for asking the user
 */
function createAskUserConfirmation(
    title: string,
    message: string,
    options: ConfirmationOption[],
    inputType: ConfirmationInputType
): ConfirmationRequest {
    return {
        requestId: crypto.randomUUID(),
        inputType,
        title,
        message,
        operation: 'ask_user',
        context: {
            toolName: 'ask_user',
            toolArgs: {},
            riskLevel: 'low',
        },
        options,
        timeoutMs: 0, // No timeout - wait for user
    };
}

/**
 * Ask the user a structured question or send a notification.
 *
 * Features:
 * - Multiple choice questions with custom options
 * - Free-form text input
 * - Notifications that require acknowledgment
 * - Users can always respond with free-form text instead of selecting an option
 */
export async function askUser(
    args: AskUserArgs,
    confirmationContext?: ConfirmationContext
): Promise<AskUserResult> {
    const { title, description, options, input_type = 'choice' } = args;
    const query = `Ask user: ${title}`;

    // Validate inputs
    if (!title) {
        return {
            query,
            compiled: 'Error: title is required',
        };
    }

    // Must have confirmation context to ask user
    if (!confirmationContext) {
        return {
            query,
            compiled: 'Error: Cannot ask user - no confirmation context available',
        };
    }

    try {
        // Determine if this is a notification (no options) or a question
        const isNotification = !options || options.length === 0;
        const isTextInput = input_type === 'text_input';

        // Convert options to ConfirmationOption format
        let confirmationOptions: ConfirmationOption[];
        if (isTextInput) {
            // For text input, provide a simple submit option
            confirmationOptions = [
                {
                    id: 'submit',
                    label: 'Submit',
                    style: 'primary',
                },
            ];
        } else if (isNotification) {
            // Auto-add acknowledge button for notifications
            confirmationOptions = createAcknowledgeOption();
        } else {
            // Convert string labels to ConfirmationOptions with auto-generated IDs
            confirmationOptions = convertToConfirmationOptions(options);
        }

        // Determine input type for the confirmation
        const effectiveInputType: ConfirmationInputType = isTextInput
            ? 'text_input'
            : 'choice';

        // Create the confirmation request
        const request = createAskUserConfirmation(
            title,
            description || '',
            confirmationOptions,
            effectiveInputType
        );

        // Request response from user
        const response = await confirmationContext.requestConfirmation(request);

        // Handle free-form response via guidance field
        if (response.guidance && response.guidance.trim()) {
            return {
                query,
                compiled: `User responded: ${response.guidance}`,
                freeformResponse: response.guidance,
            };
        }

        // Handle text input type
        if (isTextInput && response.inputData?.textValue) {
            return {
                query,
                compiled: `User entered: ${response.inputData.textValue}`,
                textInput: response.inputData.textValue,
            };
        }

        // Handle notification acknowledgment
        if (isNotification && response.selectedOptionId === 'acknowledge') {
            return {
                query,
                compiled: `User acknowledged: "${title}"`,
                acknowledged: true,
            };
        }

        // Handle choice selection - find the label from the original options
        if (options && options.length > 0) {
            // Extract the index from the option ID (e.g., 'option_0' -> 0)
            const match = response.selectedOptionId.match(/^option_(\d+)$/);
            if (match && match[1]) {
                const index = parseInt(match[1], 10);
                const selectedLabel = options[index];
                if (selectedLabel) {
                    return {
                        query,
                        compiled: `User selected: ${selectedLabel}`,
                        selectedLabel,
                    };
                }
            }
        }

        // Fallback: return the raw selected option ID
        return {
            query,
            compiled: `User selected: ${response.selectedOptionId}`,
            selectedLabel: response.selectedOptionId,
        };

    } catch (error) {
        // Handle pause/abort - re-throw so research loop can exit cleanly
        if (error instanceof Error && error.message === 'Research paused') {
            throw error;
        }

        return {
            query,
            compiled: `Error asking user: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
