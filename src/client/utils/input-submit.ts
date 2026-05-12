/**
 * Pure helper that decides what the chat input area should do on submit.
 *
 * Both the form's onSubmit and the textarea's Enter handler need to agree on
 * the same three outcomes, so this lives in one place:
 *
 *  - `guidance` — there's a pending confirmation and the user has something to
 *    send. The InputArea calls onConfirmationRespond('guidance', text).
 *  - `consume`  — there's a pending confirmation but nothing to send.
 *    The InputArea must preventDefault and stop, never falling through to the
 *    parent's "send a new message" handler.
 *  - `default`  — no confirmation pending, or empty submit while idle.
 *    The InputArea defers to the parent (which has its own canSend guards).
 */

export type InputSubmitAction =
    | { kind: 'guidance'; text?: string }
    | { kind: 'consume' }
    | { kind: 'default' };

export interface InputSubmitParams {
    pendingConfirmation: boolean;
    inputTrimmed: string;
    hasFiles: boolean;
}

export function resolveInputSubmitAction(params: InputSubmitParams): InputSubmitAction {
    const canSend = params.inputTrimmed.length > 0 || params.hasFiles;
    if (params.pendingConfirmation) {
        if (canSend) {
            return { kind: 'guidance', text: params.inputTrimmed || undefined };
        }
        return { kind: 'consume' };
    }
    return { kind: 'default' };
}
