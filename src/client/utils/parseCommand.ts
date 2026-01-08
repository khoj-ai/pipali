// Utility functions for confirmation dialogs

/**
 * Shorten home directory path for display
 */
export function shortenHomePath(path: string | undefined): string {
    return path?.replace(/^\/Users\/[^/]+/, '~') || '~';
}
