// Individual skill card for skills page gallery

import React from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SkillInfo } from '../../types/skills';

interface SkillCardProps {
    skill: SkillInfo;
    onClick?: () => void;
    onToggleVisibility?: (skill: SkillInfo, visible: boolean) => void;
}

export function SkillCard({ skill, onClick, onToggleVisibility }: SkillCardProps) {
    const { t } = useTranslation();

    const handleToggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        onToggleVisibility?.(skill, !skill.visible);
    };

    return (
        <div
            className={`skill-card${!skill.visible ? ' skill-card-hidden' : ''}`}
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick?.();
                }
            }}
        >
            <div className="skill-card-title-row">
                <h3 className="skill-card-title">{skill.name}</h3>
                {skill.modified && <span className="skill-card-badge">{t('skills.modified')}</span>}
                <button
                    className={`skill-toggle-btn${skill.visible ? ' skill-toggle-on' : ''}`}
                    onClick={handleToggle}
                    title={skill.visible ? 'Disable skill' : 'Enable skill'}
                    aria-label={skill.visible ? 'Disable skill' : 'Enable skill'}
                >
                    <span className="skill-toggle-track">
                        <span className="skill-toggle-thumb" />
                    </span>
                </button>
            </div>

            <p className="skill-card-description">{skill.description}</p>

            <div className="skill-card-footer">
                <span className="skill-location" title={skill.location}>
                    {skill.location.split('/').slice(-2).join('/')}
                </span>
                <ChevronRight size={14} />
            </div>
        </div>
    );
}
