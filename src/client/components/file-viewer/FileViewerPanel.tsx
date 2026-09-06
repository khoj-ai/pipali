// Panel beside the chat showing a file Pipali wrote or linked, rendered without running it

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink as ExternalLinkIcon, FileText, Loader2, RotateCw, X } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { HtmlFileView } from './HtmlFileView';
import { TextFileView } from './TextFileView';
import { useFileViewer } from '../../hooks/useFileViewer';
import { fetchFileContent, fileViewKind, resolveDocumentLink, RICH_RENDER_MAX_CHARS } from '../../utils/file-viewer';
import { getFileName, shortenHomePath } from '../../utils/formatting';
import { localImageSrc } from '../../utils/markdown';
import { getApiBaseUrl } from '../../utils/api';
import { isTauri, openFile, openInBrowser } from '../../utils/tauri';

interface FileViewerPanelProps {
    path: string;
    /** Changes when Pipali writes or edits this file, so the panel refetches */
    revision: number;
    onClose: () => void;
}

type LoadState =
    | { status: 'loading' }
    | { status: 'ready'; text: string; path: string }
    | { status: 'error'; httpStatus: number };

function errorKey(httpStatus: number) {
    switch (httpStatus) {
        case 403: return 'fileViewer.notAllowed';
        case 404: return 'fileViewer.notFound';
        case 413: return 'fileViewer.tooLarge';
        case 415: return 'fileViewer.binary';
        default: return 'fileViewer.failed';
    }
}

export function FileViewerPanel({ path, revision, onClose }: FileViewerPanelProps) {
    const { t } = useTranslation();
    const openInViewer = useFileViewer();
    const kind = fileViewKind(path);
    const [reloads, setReloads] = useState(0);
    const [state, setState] = useState<LoadState>({ status: 'loading' });
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        if (kind === 'image') return; // the <img> below loads on its own
        let cancelled = false;
        setState({ status: 'loading' });
        fetchFileContent(path).then(async result => {
            if (cancelled) return;
            // A folder, or a path the server cannot read as a file, is the desktop's to open,
            // as every file link was before the viewer. It stays a link to Finder.
            if (!result.ok && result.status === 404 && isTauri() && await openFile(path)) {
                if (!cancelled) onCloseRef.current();
                return;
            }
            setState(result.ok
                ? { status: 'ready', text: result.text, path: result.path }
                : { status: 'error', httpStatus: result.status });
        });
        return () => { cancelled = true; };
    }, [path, kind, revision, reloads]);

    // A link may name the file as ~/notes.md; once read, the server says where that really is
    const shownPath = state.status === 'ready' ? state.path : path;

    const openLink = (href: string) => {
        const link = resolveDocumentLink(href, shownPath);
        if (link.kind === 'web') {
            void openInBrowser(link.url);
        } else if (link.kind === 'file') {
            if (fileViewKind(link.path) && openInViewer) openInViewer(link.path);
            else void openFile(link.path);
        }
    };

    const filename = getFileName(shownPath);
    const folder = shortenHomePath(shownPath.slice(0, shownPath.length - filename.length)).replace(/[\\/]+$/, '');

    const renderBody = () => {
        if (kind === 'image') {
            return (
                <img
                    key={`${revision}-${reloads}`}
                    className="file-viewer-image"
                    src={localImageSrc(path, getApiBaseUrl())}
                    alt={filename}
                />
            );
        }
        if (state.status === 'loading') {
            return (
                <div className="file-viewer-status">
                    <Loader2 size={16} className="spin" /> {t('fileViewer.loading')}
                </div>
            );
        }
        if (state.status === 'error') {
            return (
                <div className="file-viewer-status">
                    {t(errorKey(state.httpStatus))}
                </div>
            );
        }
        switch (kind) {
            case 'html':
                return <HtmlFileView html={state.text} title={filename} onOpenLink={openLink} />;
            case 'markdown':
                return state.text.length > RICH_RENDER_MAX_CHARS
                    ? <TextFileView text={state.text} path={path} />
                    : (
                        <div className="file-viewer-markdown message-content">
                            <ChatMarkdown>{state.text}</ChatMarkdown>
                        </div>
                    );
            default:
                return <TextFileView text={state.text} path={path} />;
        }
    };

    return (
        <aside className="file-viewer" aria-label={filename}>
            <div className="file-viewer-header">
                <FileText size={14} className="file-viewer-icon" />
                <div className="file-viewer-title" title={shownPath}>
                    <span className="file-viewer-name">{filename}</span>
                    {folder && <span className="file-viewer-folder">{folder}</span>}
                </div>
                <button
                    type="button"
                    className="file-viewer-action"
                    onClick={() => setReloads(n => n + 1)}
                    aria-label={t('fileViewer.reload')}
                    title={t('fileViewer.reload')}
                >
                    <RotateCw size={14} />
                </button>
                {isTauri() && (
                    <button
                        type="button"
                        className="file-viewer-action"
                        onClick={() => void openFile(shownPath)}
                        aria-label={t('fileViewer.openExternally')}
                        title={t('fileViewer.openExternally')}
                    >
                        <ExternalLinkIcon size={14} />
                    </button>
                )}
                <button
                    type="button"
                    className="file-viewer-action file-viewer-close"
                    onClick={onClose}
                    aria-label={t('fileViewer.close')}
                    title={t('fileViewer.close')}
                >
                    <X size={14} />
                </button>
            </div>
            <div className="file-viewer-body">{renderBody()}</div>
        </aside>
    );
}
