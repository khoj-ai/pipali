// App header with model selector and connection status

import React, { useRef, useEffect } from 'react';
import { PanelLeftClose, PanelLeft, ChevronDown, Circle, Check } from 'lucide-react';
import type { ChatModelInfo } from '../../types';

interface HeaderProps {
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    isConnected: boolean;
    models: ChatModelInfo[];
    selectedModel: ChatModelInfo | null;
    showModelDropdown: boolean;
    setShowModelDropdown: (show: boolean) => void;
    onSelectModel: (model: ChatModelInfo) => void;
    onGoHome: () => void;
}

export function Header({
    sidebarOpen,
    onToggleSidebar,
    isConnected,
    models,
    selectedModel,
    showModelDropdown,
    setShowModelDropdown,
    onSelectModel,
    onGoHome,
}: HeaderProps) {
    const modelDropdownRef = useRef<HTMLDivElement>(null);

    // Close model dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
                setShowModelDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [setShowModelDropdown]);

    return (
        <header className="header">
            <div className="header-content">
                <div className="header-left">
                    <button
                        className="sidebar-toggle"
                        onClick={onToggleSidebar}
                    >
                        {sidebarOpen ? <PanelLeftClose size={20} /> : <PanelLeft size={20} />}
                    </button>
                    <div
                        className="logo clickable"
                        onClick={onGoHome}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onGoHome();
                            }
                        }}
                    >
                        <img src="/icons/pipali_64.png" alt="Pipali" className="logo-icon" />
                        <span className="logo-text">Pipali</span>
                    </div>
                </div>

                <div className="header-right">
                    {/* Model Selector */}
                    <div className="model-selector" ref={modelDropdownRef}>
                        <button
                            className="model-selector-btn"
                            onClick={() => setShowModelDropdown(!showModelDropdown)}
                        >
                            <span className="model-name">
                                {selectedModel?.friendlyName || selectedModel?.name || 'Select model'}
                            </span>
                            <ChevronDown size={14} className={showModelDropdown ? 'rotated' : ''} />
                        </button>

                        {showModelDropdown && (
                            <div className="model-dropdown">
                                {models.map(model => (
                                    <button
                                        key={model.id}
                                        className={`model-option ${selectedModel?.id === model.id ? 'selected' : ''}`}
                                        onClick={() => onSelectModel(model)}
                                    >
                                        <div className="model-option-info">
                                            <span className="model-option-name">
                                                {model.friendlyName || model.name}
                                            </span>
                                            <span className="model-option-provider">
                                                {model.providerName}
                                            </span>
                                        </div>
                                        {selectedModel?.id === model.id && <Check size={16} />}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="status">
                        <Circle
                            className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}
                            size={8}
                            fill="currentColor"
                        />
                    </div>
                </div>
            </div>
        </header>
    );
}
