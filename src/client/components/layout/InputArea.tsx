// Message input area with send/pause/play controls

import React, { useEffect } from 'react';
import { ArrowUp, Pause, Play } from 'lucide-react';
import type { ConfirmationRequest } from '../../types';
import { ConfirmationDialog } from '../confirmation/ConfirmationDialog';

interface InputAreaProps {
    input: string;
    onInputChange: (value: string) => void;
    onSubmit: (e?: React.FormEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    isConnected: boolean;
    isProcessing: boolean;
    isPaused: boolean;
    conversationId?: string;
    onPause: () => void;
    onResume: () => void;
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
    isPaused,
    onPause,
    onResume,
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
                        placeholder={isPaused ? "Type to resume with a message, or click play..." : isProcessing ? "Type to interrupt with a message..." : "Ask anything..."}
                        rows={1}
                        disabled={!isConnected}
                    />
                    <div className="input-buttons">
                        {/* Single action button: Send / Pause / Play */}
                        {isProcessing && !isPaused ? (
                            // When processing: show send if there's input, otherwise pause
                            input.trim() ? (
                                <button
                                    type="submit"
                                    disabled={!isConnected}
                                    className="action-button send"
                                    title="Send message (interrupts current task)"
                                >
                                    <ArrowUp size={18} />
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={onPause}
                                    className="action-button pause"
                                    title="Pause research (Esc)"
                                >
                                    <Pause size={18} />
                                </button>
                            )
                        ) : isPaused ? (
                            // When paused: show send if there's input, otherwise play
                            input.trim() ? (
                                <button
                                    type="submit"
                                    disabled={!isConnected}
                                    className="action-button send"
                                    title="Resume with message"
                                >
                                    <ArrowUp size={18} />
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={onResume}
                                    className="action-button play"
                                    title="Resume research"
                                >
                                    <Play size={18} />
                                </button>
                            )
                        ) : (
                            // Send button when idle
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
                    {isPaused
                        ? "Research paused. Send a message or click play to resume."
                        : isProcessing
                            ? "Type to interrupt, or press Esc to pause"
                            : "Enter to send, Cmd+Enter for background task"
                    }
                </p>
            </div>
        </footer>
    );
}
