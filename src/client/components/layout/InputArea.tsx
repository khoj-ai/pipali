// Message input area with model selector, file attachment, connection status, and send/stop controls

import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Upload, X, FileText, FileSpreadsheet, File, Paperclip, ChevronDown, Circle, Headphones, Mic, MicOff, Volume2, Bell, Check, Loader2 } from 'lucide-react';
import type { ConfirmationRequest, ChatModelInfo } from '../../types';
import type { VoiceMode, VoiceStatus } from '../../utils/voice/voice-config';
import { voiceCoachKey } from '../../utils/voice/voice-coach';
import type { StagedFile } from '../../hooks/useFileDrop';
import { ConfirmationDialog } from '../confirmation/ConfirmationDialog';
import { formatFileSize } from '../../utils/formatting';
import { localImageSrc } from '../../utils/markdown';
import { getApiBaseUrl } from '../../utils/api';
import { isTauri } from '../../utils/tauri';
import { useTranslation } from 'react-i18next';

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
    stagedFiles?: StagedFile[];
    isDragging?: boolean;
    onRemoveFile?: (id: string) => void;
    onPasteFiles?: (files: File[]) => void;
    onPickFiles?: (browserFiles?: File[]) => void;
    voiceSupported?: boolean;
    voiceMode?: VoiceMode;
    voiceStatus?: VoiceStatus;
    voiceTranscript?: string;
    onVoiceEnable?: () => void;
    onVoiceModeChange?: (mode: VoiceMode) => void;
    onVoiceTap?: () => void;
    models: ChatModelInfo[];
    selectedModel: ChatModelInfo | null;
    showModelDropdown: boolean;
    setShowModelDropdown: (show: boolean) => void;
    onSelectModel: (model: ChatModelInfo) => void;
}

import { MOD_KEY, ALT_KEY } from '../../utils/platform';

const SPREADSHEET_EXTS = ['.xlsx', '.xls', '.csv'];
const TEXT_EXTS = ['.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.toml', '.log'];

function getFileIcon(fileName: string) {
    const dot = fileName.lastIndexOf('.');
    if (dot === -1) return <File size={20} />;
    const ext = fileName.slice(dot).toLowerCase();
    if (SPREADSHEET_EXTS.includes(ext)) return <FileSpreadsheet size={20} />;
    if (TEXT_EXTS.includes(ext)) return <FileText size={20} />;
    return <File size={20} />;
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
    stagedFiles = [],
    isDragging = false,
    onRemoveFile,
    onPasteFiles,
    onPickFiles,
    voiceSupported = false,
    voiceMode = 'off',
    voiceStatus = 'idle',
    voiceTranscript = '',
    onVoiceEnable,
    onVoiceModeChange,
    onVoiceTap,
    models,
    selectedModel,
    showModelDropdown,
    setShowModelDropdown,
    onSelectModel,
}: InputAreaProps) {
    const { t } = useTranslation();
    const hasFiles = stagedFiles.length > 0;
    const canSend = input.trim() || hasFiles;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const modelDropdownRef = useRef<HTMLDivElement>(null);
    const voiceMenuRef = useRef<HTMLDivElement>(null);
    const [showVoiceMenu, setShowVoiceMenu] = useState(false);
    const voiceEnabled = voiceMode !== 'off';
    const voiceTitle = voiceEnabled ? t(`voice.status.${voiceStatus}`) : t('voice.enable');
    const showHint = useRef(Math.random() < 0.05).current;
    const placeholder = !showHint
        ? t('inputArea.askAnything')
        : conversationId
            ? t('inputArea.tipForkConversation', { modKey: MOD_KEY })
            : t('inputArea.tipBackgroundTask', { modKey: MOD_KEY });

    // With voice on, the placeholder coaches the spoken command for the next
    // step; it outranks the typed-input placeholders below, which advise on the
    // wrong modality. The mic tooltip stays on tap affordances.
    const coachKey = voiceCoachKey({
        mode: voiceMode,
        status: voiceStatus,
        pending: pendingConfirmation
            ? (pendingConfirmation.operation === 'ask_user' ? 'question' : 'confirmation')
            : null,
        isProcessing,
    });
    const shownPlaceholder = coachKey
        ? t(coachKey)
        : pendingConfirmation
            ? (showHint && pendingConfirmation.options[0]
                ? t('inputArea.tipConfirmation', { altKey: ALT_KEY, label: pendingConfirmation.options[0].label })
                : pendingConfirmation.operation === 'ask_user'
                    ? t('inputArea.customResponse')
                    : t('inputArea.alternativeInstructions'))
            : isStopped
                ? t('inputArea.stopped')
                : isProcessing
                    ? t('inputArea.processing')
                    : placeholder;

    // Close dropdowns when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
                setShowModelDropdown(false);
            }
            if (voiceMenuRef.current && !voiceMenuRef.current.contains(e.target as Node)) {
                setShowVoiceMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [setShowModelDropdown]);

    // Auto-resize textarea. An empty one sizes to its placeholder, and voice
    // hints change with no input and wrap on a phone.
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
        }
    }, [input, shownPlaceholder, textareaRef]);

    return (
        <footer className="input-area">
            {/* Drop zone overlay */}
            {isDragging && (
                <div className="drop-zone-overlay">
                    <div className="drop-zone-inner">
                        <Upload size={32} />
                        <p>{t('inputArea.dropFiles')}</p>
                    </div>
                </div>
            )}

            {/* Confirmation Dialog - positioned above chat input for current conversation */}
            {pendingConfirmation && (
                <ConfirmationDialog
                    request={pendingConfirmation}
                    onRespond={onConfirmationRespond}
                />
            )}

            <div className="input-container">
                <form onSubmit={(e) => {
                    // When confirmation is pending, send as guidance instead of new message
                    // This handles mobile where users tap the send button instead of pressing Enter
                    if (pendingConfirmation && (input.trim() || hasFiles)) {
                        e.preventDefault();
                        onConfirmationRespond('guidance', input.trim() || undefined);
                        onInputChange('');
                        return;
                    }
                    onSubmit(e);
                }} className="input-form">
                    {/* Staged file chips */}
                    {hasFiles && (
                        <div className="staged-files">
                            {stagedFiles.map(file => (
                                <div key={file.id} className="staged-file-chip">
                                    {file.isImage ? (
                                        <img
                                            src={localImageSrc(file.filePath, getApiBaseUrl()) || ''}
                                            alt={file.fileName}
                                            className="file-thumbnail"
                                        />
                                    ) : (
                                        <span className="file-icon">{getFileIcon(file.fileName)}</span>
                                    )}
                                    <span className="file-info">
                                        <span className="file-name" title={file.fileName}>{file.fileName}</span>
                                        <span className="file-size">{formatFileSize(file.sizeBytes)}</span>
                                    </span>
                                    <button
                                        type="button"
                                        className="remove-file"
                                        onClick={() => onRemoveFile?.(file.id)}
                                        title={t('inputArea.removeFile')}
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Live voice transcript while a hands-free turn is open */}
                    {(voiceStatus === 'listening' || voiceStatus === 'transcribing' || !!voiceTranscript) && voiceEnabled && (
                        <div className="voice-live-transcript" aria-live="polite">
                            <span className="voice-live-text">{voiceTranscript || '…'}</span>
                        </div>
                    )}

                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={(e) => onInputChange(e.target.value)}
                        onPaste={(e) => {
                            const files = e.clipboardData?.files;
                            if (files && files.length > 0) {
                                e.preventDefault();
                                onPasteFiles?.([...files]);
                            }
                        }}
                        onKeyDown={(e) => {
                            // When confirmation is pending, Enter sends guidance
                            if (pendingConfirmation && e.key === 'Enter' && !e.shiftKey && (input.trim() || hasFiles)) {
                                e.preventDefault();
                                onConfirmationRespond('guidance', input.trim() || undefined);
                                onInputChange('');
                                return;
                            }
                            // Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux): background task
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
                                e.preventDefault();
                                onBackgroundSend?.();
                                return;
                            }
                            // Pass through to parent handler for other cases
                            onKeyDown(e);
                        }}
                        className={coachKey ? 'voice-coached' : undefined}
                        placeholder={shownPlaceholder}
                        rows={1}
                        disabled={!isConnected}
                        autoFocus
                    />

                    {/* Divider between textarea and toolbar */}
                    <div className="input-divider" />

                    {/* Toolbar row: status + model selector (left), attach + send/stop (right) */}
                    <div className="input-toolbar">
                        <div className="input-toolbar-left">
                            <Circle
                                className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}
                                size={8}
                                fill="currentColor"
                            />

                            {/* Model selector */}
                            <div className="model-selector" ref={modelDropdownRef}>
                                <button
                                    type="button"
                                    className="model-selector-btn"
                                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                                >
                                    <span className="model-name">
                                        {selectedModel?.friendlyName || selectedModel?.name || t('inputArea.selectModel')}
                                    </span>
                                    <ChevronDown size={12} className={showModelDropdown ? 'rotated' : ''} />
                                </button>

                                {showModelDropdown && (
                                    <div className="model-dropdown">
                                        {models.length === 0 ? (
                                            <div className="model-dropdown-empty">
                                                {t('inputArea.noModelsAvailable')}
                                            </div>
                                        ) : (
                                            ([
                                                ['flagship', t('inputArea.tierFlagship')],
                                                ['balanced', t('inputArea.tierBalanced')],
                                                ['lite', t('inputArea.tierLite')],
                                                ['other', t('inputArea.tierOther')],
                                            ] as const).map(([tierKey, tierLabel]) => {
                                                const tierModels = models.filter(m =>
                                                    tierKey === 'other'
                                                        ? m.tier !== 'flagship' && m.tier !== 'balanced' && m.tier !== 'lite'
                                                        : m.tier === tierKey
                                                );
                                                if (tierModels.length === 0) return null;
                                                return (
                                                    <div key={tierKey} className="model-tier-group">
                                                        <div className="model-tier-header">{tierLabel}</div>
                                                        {tierModels.map(model => {
                                                            const isSelected = selectedModel?.id === model.id;
                                                            return (
                                                                <button
                                                                    key={model.id}
                                                                    type="button"
                                                                    className={`model-option ${isSelected ? 'selected' : ''}`}
                                                                    onClick={() => onSelectModel(model)}
                                                                >
                                                                    <div className="model-option-row">
                                                                        <span className="model-option-name">
                                                                            {model.friendlyName || model.name}
                                                                        </span>
                                                                        {model.recommended && (
                                                                            <span className="model-recommended-pill">
                                                                                {t('inputArea.recommended')}
                                                                            </span>
                                                                        )}
                                                                        {model.costTier && <span className="model-cost-tier">{model.costTier}</span>}
                                                                    </div>
                                                                    {model.tagline && (
                                                                        <div className="model-option-row model-option-row-secondary">
                                                                            <span className="model-tagline" title={model.tagline}>
                                                                                {model.tagline}
                                                                            </span>
                                                                        </div>
                                                                    )}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="input-toolbar-right">
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                className="hidden-file-input"
                                onChange={(e) => {
                                    const files = e.target.files;
                                    if (files && files.length > 0) {
                                        onPickFiles?.([...files]);
                                    }
                                    e.target.value = '';
                                }}
                            />
                            <button
                                type="button"
                                className="toolbar-button"
                                onClick={() => isTauri() ? onPickFiles?.() : fileInputRef.current?.click()}
                                title={t('inputArea.attachFiles')}
                            >
                                <Paperclip size={16} />
                            </button>
                            {voiceSupported && (
                                <div className="voice-control" ref={voiceMenuRef}>
                                    <button
                                        type="button"
                                        className={`toolbar-button voice-button ${voiceEnabled ? `voice-${voiceStatus}` : 'voice-disabled'}`}
                                        onClick={() => (voiceEnabled ? onVoiceTap?.() : onVoiceEnable?.())}
                                        title={voiceTitle}
                                        aria-label={voiceTitle}
                                        aria-pressed={voiceEnabled}
                                    >
                                        {!voiceEnabled ? <Headphones size={16} />
                                            : voiceStatus === 'transcribing' ? <Loader2 size={16} className="spin" />
                                            : voiceStatus === 'dormant' ? <MicOff size={16} />
                                            : voiceStatus === 'speaking' || voiceStatus === 'announced' ? <Volume2 size={16} />
                                            : <Mic size={16} />}
                                    </button>
                                    <button
                                        type="button"
                                        className="toolbar-button voice-mode-trigger"
                                        onClick={() => setShowVoiceMenu((v) => !v)}
                                        title={t('voice.modeMenu.title')}
                                        aria-label={t('voice.modeMenu.title')}
                                        aria-haspopup="menu"
                                        aria-expanded={showVoiceMenu}
                                    >
                                        <ChevronDown size={12} />
                                    </button>
                                    {showVoiceMenu && (
                                        <div className="voice-mode-menu" role="menu" aria-label={t('voice.modeMenu.title')}>
                                            {(['speak_freely', 'ask_first', 'off'] as const).map((m) => (
                                                <button
                                                    key={m}
                                                    type="button"
                                                    role="menuitemradio"
                                                    aria-checked={voiceMode === m}
                                                    className={`voice-mode-option ${voiceMode === m ? 'selected' : ''}`}
                                                    onClick={() => { setShowVoiceMenu(false); onVoiceModeChange?.(m); }}
                                                >
                                                    {m === 'speak_freely' ? <Volume2 size={14} /> : m === 'ask_first' ? <Bell size={14} /> : <Headphones size={14} />}
                                                    <span className="voice-mode-option-text">
                                                        <span className="voice-mode-option-label">{t(`voice.mode.${m}`)}</span>
                                                        <span className="voice-mode-option-hint">{t(`voice.modeHint.${m}`)}</span>
                                                    </span>
                                                    {voiceMode === m && <Check size={14} className="voice-mode-option-check" />}
                                                </button>
                                            ))}
                                            <div className="voice-mode-menu-footer">{t('voice.modeMenu.spokenHint')}</div>
                                        </div>
                                    )}
                                </div>
                            )}
                            {isProcessing ? (
                                canSend ? (
                                    <button
                                        type="submit"
                                        disabled={!isConnected}
                                        className="action-button send"
                                        title={t('inputArea.sendMessage')}
                                    >
                                        <ArrowUp size={16} />
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        // Send turns into stop under the pointer, so the second
                                        // click of a double click on send would stop its own run
                                        onClick={(e) => { if (e.detail < 2) onStop(); }}
                                        className="action-button stop"
                                        title={t('inputArea.stop')}
                                    >
                                        <Square size={16} />
                                    </button>
                                )
                            ) : (
                                <button
                                    type="submit"
                                    disabled={!canSend || !isConnected}
                                    className="action-button send"
                                >
                                    <ArrowUp size={16} />
                                </button>
                            )}
                        </div>
                    </div>
                </form>
            </div>
        </footer>
    );
}
