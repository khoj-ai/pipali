import { createContext, useContext } from 'react';

/**
 * Opens a local file in the viewer panel, for anything deep in the tree that links one.
 *
 * File links render in chat markdown and in tool-call headers, several layers below the
 * app that owns the panel. Threading a callback through those layers would touch components
 * with no other interest in it.
 */
export const FileViewerContext = createContext<((path: string) => void) | null>(null);

export function useFileViewer(): ((path: string) => void) | null {
    return useContext(FileViewerContext);
}
