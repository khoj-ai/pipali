// Question card for the ask_user tool: the prompt, its options, and what the user answered

import { Check, MessageSquareText } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';

interface AskUserViewProps {
    args: { title?: string; description?: string; options?: string[]; input_type?: string };
    result?: string;
}

export interface AskUserAnswer {
    kind: 'selected' | 'text' | 'acknowledged';
    text: string;
}

// Mirrors the `compiled` strings built by askUser() on the server
export function parseAskUserAnswer(result?: string): AskUserAnswer | null {
    if (!result) return null;
    const first = result.split('\n')[0] ?? '';
    if (first.startsWith('User selected: ')) return { kind: 'selected', text: first.slice('User selected: '.length) };
    if (first.startsWith('User acknowledged')) return { kind: 'acknowledged', text: '' };
    for (const prefix of ['User responded: ', 'User entered: ']) {
        if (result.startsWith(prefix)) {
            // A typed answer can span lines; attachments follow in their own block
            return { kind: 'text', text: result.slice(prefix.length).split('\n\n')[0] ?? '' };
        }
    }
    return null;
}

export function AskUserView({ args, result }: AskUserViewProps) {
    const options = Array.isArray(args.options) ? args.options : [];
    const answer = parseAskUserAnswer(result);

    return (
        <div className="thought-ask-user">
            {args.description && (
                <div className="ask-user-description">
                    <ChatMarkdown compact>{args.description}</ChatMarkdown>
                </div>
            )}
            {options.length > 0 && (
                <div className="ask-user-options">
                    {options.map((label, idx) => {
                        const chosen = answer?.kind === 'selected' && answer.text === label;
                        return (
                            <span key={idx} className={`ask-user-option${chosen ? ' chosen' : ''}${answer && !chosen ? ' dimmed' : ''}`}>
                                {chosen && <Check size={12} />}
                                {label}
                            </span>
                        );
                    })}
                </div>
            )}
            {answer?.kind === 'text' && (
                <div className="ask-user-reply">
                    <MessageSquareText size={12} />
                    <span>{answer.text}</span>
                </div>
            )}
            {answer?.kind === 'acknowledged' && (
                <div className="ask-user-reply">
                    <Check size={12} />
                    <span>Acknowledged</span>
                </div>
            )}
            {answer?.kind === 'selected' && !options.includes(answer.text) && (
                <div className="ask-user-reply">
                    <Check size={12} />
                    <span>{answer.text}</span>
                </div>
            )}
        </div>
    );
}
