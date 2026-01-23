// Message input area with send/stop controls

import React, { useEffect } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { ConfirmationRequest } from '../../types';
import { ConfirmationDialog } from '../confirmation/ConfirmationDialog';

interface InputAreaProps {
    input: string;
    onInputChange: (value: string) => void;
    onSubmit: (e?: React.FormEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    isConnected: boolean;
    isProcessing: boolean;
    isStopped: boolean;
    conversationId?: string;
    onStop: () => void;
    pendingConfirmation?: ConfirmationRequest;
    onConfirmationRespond: (optionId: string, guidance?: string) => void;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    onBackgroundSend?: () => void;
}

export function InputArea({
    input,
    onInputChange,
    onSubmit,
    onKeyDown,
    isConnected,
    isProcessing,
    isStopped,
    conversationId,
    onStop,
    pendingConfirmation,
    onConfirmationRespond,
    textareaRef,
    onBackgroundSend,
}: InputAreaProps) {
    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
        }
    }, [input, textareaRef]);

    return (
        <footer className="input-area">
            {/* Confirmation Dialog - positioned above chat input for current conversation */}
            {pendingConfirmation && (
                <ConfirmationDialog
                    request={pendingConfirmation}
                    onRespond={onConfirmationRespond}
                />
            )}

            <div className="input-container">
                <form onSubmit={onSubmit} className="input-form">
                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => onInputChange(e.target.value)}
                        onKeyDown={(e) => {
                            // Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux): background task
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
                                e.preventDefault();
                                onBackgroundSend?.();
                                return;
                            }
                            // Pass through to parent handler for other cases
                            onKeyDown(e);
                        }}
                        placeholder={
                            isStopped
                                ? "Stopped. Type a new message..."
                                : isProcessing
                                    ? "Type to interrupt with a message..."
                                    : "Ask anything..."
                        }
                        rows={1}
                        disabled={!isConnected}
                        autoFocus
                    />
                    <div className="input-buttons">
                        {/* Single action button: Send / Stop */}
                        {isProcessing ? (
                            input.trim() ? (
                                <button
                                    type="submit"
                                    disabled={!isConnected}
                                    className="action-button send"
                                    title="Send message (soft interrupt)"
                                >
                                    <ArrowUp size={18} />
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={onStop}
                                    className="action-button stop"
                                    title="Stop (Esc)"
                                >
                                    <Square size={18} />
                                </button>
                            )
                        ) : (
                            <button
                                type="submit"
                                disabled={!input.trim() || !isConnected}
                                className="action-button send"
                            >
                                <ArrowUp size={18} />
                            </button>
                        )}
                    </div>
                </form>
                <p className="input-hint">
                    {isStopped
                        ? "Stopped. Send a new message to start a new run."
                        : isProcessing
                            ? "Type to interrupt, or press Esc to stop"
                            : `Enter to send, ${navigator.platform.indexOf('Mac') !== -1 ? 'Cmd' : 'Ctrl'}+Enter to ${conversationId ? 'fork conversation' : 'run for background task'}`
                    }
                </p>
            </div>
        </footer>
    );
}
