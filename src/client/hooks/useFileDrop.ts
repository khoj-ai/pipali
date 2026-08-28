// Hook for managing file attachment state (drag-drop, paste, and file picker).
// Tauri mode: listens for native drag-drop events, reads file metadata via Rust command.
// Web mode: uses HTML5 drag-and-drop with POST /api/upload.
// File picker: Tauri uses native dialog (no copy), web uses /api/upload.
// Paste: uploads pasted files via /api/upload (both modes).

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    isTauri,
    onFileDragEnter,
    onFileDragLeave,
    onFileDropped,
    getDroppedFileMetadata,
    pickFiles,
} from '../utils/tauri';
import { getApiBaseUrl } from '../utils/api';
import { generateUUID } from '../utils/formatting';

export interface StagedFile {
    id: string;
    fileName: string;
    filePath: string;
    sizeBytes: number;
    isImage: boolean;
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function isImageFile(fileName: string): boolean {
    const dot = fileName.lastIndexOf('.');
    if (dot === -1) return false;
    return IMAGE_EXTENSIONS.includes(fileName.slice(dot).toLowerCase());
}

export function useFileDrop() {
    const [isDragging, setIsDragging] = useState(false);
    const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const dragLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Tauri native drag-drop listeners
    useEffect(() => {
        if (!isTauri()) return;

        const unlisteners: Array<() => void> = [];

        onFileDragEnter(() => {
            if (dragLeaveTimerRef.current) {
                clearTimeout(dragLeaveTimerRef.current);
                dragLeaveTimerRef.current = null;
            }
            setIsDragging(true);
        }).then(u => unlisteners.push(u));

        onFileDragLeave(() => {
            dragLeaveTimerRef.current = setTimeout(() => setIsDragging(false), 100);
        }).then(u => unlisteners.push(u));

        onFileDropped(async ({ paths }) => {
            setIsDragging(false);
            setIsProcessing(true);
            try {
                const results = await getDroppedFileMetadata(paths);
                const newFiles: StagedFile[] = results.map(r => ({
                    id: generateUUID(),
                    fileName: r.fileName,
                    filePath: r.filePath,
                    sizeBytes: r.sizeBytes,
                    isImage: isImageFile(r.fileName),
                }));
                setStagedFiles(prev => [...prev, ...newFiles]);
            } finally {
                setIsProcessing(false);
            }
        }).then(u => unlisteners.push(u));

        return () => { unlisteners.forEach(u => u()); };
    }, []);

    // HTML5 drag-drop for web mode
    useEffect(() => {
        if (isTauri()) return;

        const handleDragOver = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer?.types.includes('Files')) {
                setIsDragging(true);
            }
        };

        const handleDragLeave = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.relatedTarget) {
                setIsDragging(false);
            }
        };

        const handleDrop = async (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);

            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) return;
            uploadFiles([...files]);
        };

        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('dragleave', handleDragLeave);
        document.addEventListener('drop', handleDrop);

        return () => {
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('dragleave', handleDragLeave);
            document.removeEventListener('drop', handleDrop);
        };
    }, []);

    /** Upload browser File objects (used by paste and web drag-drop). */
    const uploadFiles = useCallback(async (files: File[]) => {
        if (files.length === 0) return;
        setIsProcessing(true);
        try {
            const formData = new FormData();
            for (const file of files) {
                formData.append('files', file);
            }
            const baseUrl = getApiBaseUrl();
            const res = await fetch(`${baseUrl}/api/upload`, {
                method: 'POST',
                body: formData,
            });
            if (res.ok) {
                const data = await res.json();
                const newFiles: StagedFile[] = data.files.map((f: any) => ({
                    id: generateUUID(),
                    fileName: f.fileName,
                    filePath: f.filePath,
                    sizeBytes: f.sizeBytes,
                    isImage: isImageFile(f.fileName),
                }));
                setStagedFiles(prev => [...prev, ...newFiles]);
            }
        } finally {
            setIsProcessing(false);
        }
    }, []);

    /** Open native file picker on desktop app and uploader on web app. */
    const pickAndStageFiles = useCallback(async (browserFiles?: File[]) => {
        if (isTauri()) {
            const paths = await pickFiles();
            if (paths.length === 0) return;
            setIsProcessing(true);
            try {
                const results = await getDroppedFileMetadata(paths);
                const newFiles: StagedFile[] = results.map(r => ({
                    id: generateUUID(),
                    fileName: r.fileName,
                    filePath: r.filePath,
                    sizeBytes: r.sizeBytes,
                    isImage: isImageFile(r.fileName),
                }));
                setStagedFiles(prev => [...prev, ...newFiles]);
            } finally {
                setIsProcessing(false);
            }
        } else if (browserFiles && browserFiles.length > 0) {
            await uploadFiles(browserFiles);
        }
    }, [uploadFiles]);

    const removeFile = useCallback((id: string) => {
        setStagedFiles(prev => prev.filter(f => f.id !== id));
    }, []);

    const clearFiles = useCallback(() => {
        setStagedFiles([]);
    }, []);

    return {
        isDragging,
        stagedFiles,
        isProcessing,
        uploadFiles,
        pickAndStageFiles,
        removeFile,
        clearFiles,
    };
}
