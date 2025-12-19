// Command message parsing for confirmation dialogs

export type ParsedCommand = {
    reason?: string;
    command?: string;
    workdir?: string;
};

/**
 * Parse command execution message into structured sections
 * Used by both ConfirmationDialog and ConfirmationToast
 */
export function parseCommandMessage(message: string): ParsedCommand | null {
    if (!message.includes('**Why:**') && !message.includes('**Command:**')) {
        return null;
    }
    const result: ParsedCommand = {};

    // Extract reason (after **Why:** until **Command:**)
    const whyMatch = message.match(/\*\*Why:\*\*\s*([\s\S]*?)(?=\*\*Command:\*\*|$)/);
    if (whyMatch && whyMatch[1]) {
        result.reason = whyMatch[1].trim();
    }

    // Extract command (after **Command:** until **Working directory:**)
    const cmdMatch = message.match(/\*\*Command:\*\*\s*([\s\S]*?)(?=\*\*Working directory:\*\*|$)/);
    if (cmdMatch && cmdMatch[1]) {
        result.command = cmdMatch[1].trim();
    }

    // Extract working directory
    const wdMatch = message.match(/\*\*Working directory:\*\*\s*([\s\S]*?)$/);
    if (wdMatch && wdMatch[1]) {
        result.workdir = wdMatch[1].trim();
    }

    return result;
}

/**
 * Shorten home directory path for display
 */
export function shortenHomePath(path: string | undefined): string {
    return path?.replace(/^\/Users\/[^/]+/, '~') || '~';
}
