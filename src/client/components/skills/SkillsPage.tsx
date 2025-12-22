// Main skills page component

import React, { useState, useEffect } from 'react';
import { RefreshCw, Plus, AlertCircle } from 'lucide-react';
import type { SkillInfo, SkillLoadError } from '../../types/skills';
import { SkillCard } from './SkillCard';
import { SkillsEmpty } from './SkillsEmpty';
import { CreateSkillModal } from './CreateSkillModal';
import { SkillDetailModal } from './SkillDetailModal';

export function SkillsPage() {
    const [skills, setSkills] = useState<SkillInfo[]>([]);
    const [errors, setErrors] = useState<SkillLoadError[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isReloading, setIsReloading] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);

    useEffect(() => {
        fetchSkills();
    }, []);

    const fetchSkills = async () => {
        try {
            const res = await fetch('/api/skills');
            if (res.ok) {
                const data = await res.json();
                setSkills(data.skills || []);
            }
        } catch (e) {
            console.error('Failed to fetch skills', e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleReload = async () => {
        setIsReloading(true);
        setErrors([]);
        try {
            const res = await fetch('/api/skills/reload', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                setSkills(data.skills || []);
                setErrors(data.errors || []);
            }
        } catch (e) {
            console.error('Failed to reload skills', e);
        } finally {
            setIsReloading(false);
        }
    };

    const handleSkillCreated = () => {
        setShowCreateModal(false);
        handleReload();
    };

    const handleSkillDeleted = () => {
        setSelectedSkill(null);
        handleReload();
    };

    if (isLoading) {
        return (
            <main className="main-content">
                <div className="messages-container">
                    <div className="skills-gallery">
                        <div className="skills-loading">Loading skills...</div>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="main-content">
            <div className="messages-container">
                <div className="skills-gallery">
                    <div className="skills-header">
                        <div className="skills-header-left">
                            <h2>Skills</h2>
                            <span className="skills-count">{skills.length}</span>
                        </div>
                        <div className="skills-header-actions">
                            <button
                                onClick={() => setShowCreateModal(true)}
                                className="skills-create-btn"
                            >
                                <Plus size={16} />
                                <span>Create</span>
                            </button>
                            <button
                                onClick={handleReload}
                                disabled={isReloading}
                                className="skills-reload-btn"
                                title="Reload skills from disk"
                            >
                                <RefreshCw size={16} className={isReloading ? 'spinning' : ''} />
                            </button>
                        </div>
                    </div>

                    {errors.length > 0 && (
                        <div className="skills-errors">
                            {errors.map((error, i) => (
                                <div key={i} className="skills-error">
                                    <AlertCircle size={14} />
                                    <span>{error.path}: {error.message}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {skills.length === 0 ? (
                        <SkillsEmpty />
                    ) : (
                        <div className="skills-cards">
                            {skills.map((skill) => (
                                <SkillCard
                                    key={`${skill.source}-${skill.name}`}
                                    skill={skill}
                                    onClick={() => setSelectedSkill(skill)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {showCreateModal && (
                <CreateSkillModal
                    onClose={() => setShowCreateModal(false)}
                    onCreated={handleSkillCreated}
                />
            )}

            {selectedSkill && (
                <SkillDetailModal
                    skill={selectedSkill}
                    onClose={() => setSelectedSkill(null)}
                    onDeleted={handleSkillDeleted}
                    onUpdated={handleReload}
                />
            )}
        </main>
    );
}
