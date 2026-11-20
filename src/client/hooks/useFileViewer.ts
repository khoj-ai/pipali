import { createContext, useContext } from 'react';
import type { FileLinkTarget } from '../utils/formatting';

/** A file to show in the viewer panel, and where in it to land */
export interface FileViewerRequest {
    path: string;
    target: FileLinkTarget | null;
}

export type OpenInViewer = (path: string, target?: FileLinkTarget | null) => void;

/**
 * Opens a local file in the viewer panel, for anything deep in the tree that links one.
 *
 * File links render in chat markdown and in tool-call headers, several layers below the
 * app that owns the panel. Threading a callback through those layers would touch components
 * with no other interest in it.
 */
export const FileViewerContext = createContext<OpenInViewer | null>(null);

export function useFileViewer(): OpenInViewer | null {
    return useContext(FileViewerContext);
}
