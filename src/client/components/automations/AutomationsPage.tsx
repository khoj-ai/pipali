// Main automations page component

import React, { useState, useEffect } from 'react';
import { RefreshCw, Plus } from 'lucide-react';
import type { AutomationInfo, AutomationPendingConfirmation } from '../../types/automations';
import { AutomationCard } from './AutomationCard';
import { AutomationsEmpty } from './AutomationsEmpty';
import { CreateAutomationModal } from './CreateAutomationModal';
import { AutomationDetailModal } from './AutomationDetailModal';

interface AutomationsPageProps {
    pendingConfirmations: AutomationPendingConfirmation[];
    onConfirmationRespond: (confirmationId: string, optionId: string, guidance?: string) => void;
    onConfirmationDismiss: (confirmationId: string) => void;
    onViewConversation: (conversationId: string) => void;
}

export function AutomationsPage({
    pendingConfirmations,
    onConfirmationRespond,
    onConfirmationDismiss,
    onViewConversation,
}: AutomationsPageProps) {
    const [automations, setAutomations] = useState<AutomationInfo[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [selectedAutomation, setSelectedAutomation] = useState<AutomationInfo | null>(null);

    useEffect(() => {
        fetchAutomations();
    }, []);

    const fetchAutomations = async () => {
        try {
            const res = await fetch('/api/automations');
            if (res.ok) {
                const data = await res.json();
                setAutomations(data.automations || []);
            }
        } catch (e) {
            console.error('Failed to fetch automations', e);
        } finally {
            setIsLoading(false);
        }
    };

    // Create a map of automationId -> pending confirmation for quick lookup
    const confirmationsByAutomation = new Map<string, AutomationPendingConfirmation>();
    for (const confirmation of pendingConfirmations) {
        confirmationsByAutomation.set(confirmation.automationId, confirmation);
    }

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            await fetchAutomations();
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleAutomationCreated = () => {
        setShowCreateModal(false);
        handleRefresh();
    };

    const handleAutomationUpdated = () => {
        setSelectedAutomation(null);
        handleRefresh();
    };

    const handleAutomationDeleted = () => {
        setSelectedAutomation(null);
        handleRefresh();
    };

    if (isLoading) {
        return (
            <main className="main-content">
                <div className="messages-container">
                    <div className="automations-gallery">
                        <div className="automations-loading">Loading automations...</div>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="main-content">
            <div className="messages-container">
                <div className="automations-gallery">
                    <div className="automations-header">
                        <div className="automations-header-left">
                            <h2>Automations</h2>
                            <span className="automations-count">{automations.length}</span>
                        </div>
                        <div className="automations-header-actions">
                            <button
                                onClick={() => setShowCreateModal(true)}
                                className="automations-create-btn"
                            >
                                <Plus size={16} />
                                <span>Create</span>
                            </button>
                            <button
                                onClick={handleRefresh}
                                disabled={isRefreshing}
                                className="automations-reload-btn"
                                title="Refresh automations"
                            >
                                <RefreshCw size={16} className={isRefreshing ? 'spinning' : ''} />
                            </button>
                        </div>
                    </div>

                    {automations.length === 0 ? (
                        <AutomationsEmpty />
                    ) : (
                        <div className="automations-cards">
                            {automations.map((automation) => (
                                <AutomationCard
                                    key={automation.id}
                                    automation={automation}
                                    pendingConfirmation={confirmationsByAutomation.get(automation.id)}
                                    onClick={() => setSelectedAutomation(automation)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {showCreateModal && (
                <CreateAutomationModal
                    onClose={() => setShowCreateModal(false)}
                    onCreated={handleAutomationCreated}
                />
            )}

            {selectedAutomation && (
                <AutomationDetailModal
                    automation={selectedAutomation}
                    pendingConfirmation={confirmationsByAutomation.get(selectedAutomation.id)}
                    onClose={() => setSelectedAutomation(null)}
                    onUpdated={handleAutomationUpdated}
                    onDeleted={handleAutomationDeleted}
                    onConfirmationRespond={onConfirmationRespond}
                    onViewConversation={(convId) => {
                        setSelectedAutomation(null);
                        onViewConversation(convId);
                    }}
                />
            )}
        </main>
    );
}
