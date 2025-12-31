// Model fetching and selection hook

import { useState, useEffect, useCallback } from 'react';
import type { ChatModelInfo } from '../types';
import { apiFetch } from '../utils/api';

export function useModels() {
    const [models, setModels] = useState<ChatModelInfo[]>([]);
    const [selectedModel, setSelectedModel] = useState<ChatModelInfo | null>(null);
    const [showModelDropdown, setShowModelDropdown] = useState(false);

    const fetchModels = useCallback(async () => {
        try {
            const res = await apiFetch('/api/models');
            if (res.ok) {
                const data = await res.json();
                setModels(data.models);
            }
        } catch (e) {
            console.error("Failed to fetch models", e);
        }
    }, []);

    const fetchUserModel = useCallback(async () => {
        try {
            const res = await apiFetch('/api/user/model');
            if (res.ok) {
                const data = await res.json();
                if (data.model) {
                    setSelectedModel(data.model);
                }
            }
        } catch (e) {
            console.error("Failed to fetch user model", e);
        }
    }, []);

    const selectModel = useCallback(async (model: ChatModelInfo) => {
        try {
            const res = await apiFetch('/api/user/model', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: model.id }),
            });
            if (res.ok) {
                setSelectedModel(model);
                setShowModelDropdown(false);
            }
        } catch (e) {
            console.error("Failed to select model", e);
        }
    }, []);

    // Fetch models and user's selected model on mount
    useEffect(() => {
        fetchModels();
        fetchUserModel();
    }, [fetchModels, fetchUserModel]);

    return {
        models,
        selectedModel,
        selectModel,
        showModelDropdown,
        setShowModelDropdown,
    };
}
