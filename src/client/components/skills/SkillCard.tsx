// Individual skill card for skills page gallery

import React from 'react';
import { ChevronRight, Globe, FolderOpen } from 'lucide-react';
import type { SkillInfo } from '../../types/skills';

interface SkillCardProps {
    skill: SkillInfo;
    onClick?: () => void;
}

export function SkillCard({ skill, onClick }: SkillCardProps) {
    const SourceIcon = skill.source === 'global' ? Globe : FolderOpen;

    return (
        <div
            className="skill-card"
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
            <div className="skill-card-header">
                <SourceIcon size={14} className="skill-source-icon" />
                <span className="skill-source-badge">{skill.source}</span>
            </div>

            <h3 className="skill-card-title">{skill.name}</h3>

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
