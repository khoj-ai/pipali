// Empty state when no skills are available

import React from 'react';
import { Zap } from 'lucide-react';

export function SkillsEmpty() {
    return (
        <div className="empty-state skills-empty">
            <Zap className="empty-icon" size={32} strokeWidth={1.5} />
            <h2>No Skills Found</h2>
            <p>Skills extend Pipali's capabilities with custom instructions.</p>
            <p className="empty-hint">
                Create a skill by adding a <code>SKILL.md</code> file in:
            </p>
            <ul className="skills-paths">
                <li><code>~/.pipali/skills/your-skill/SKILL.md</code> (global)</li>
                <li><code>./.pipali/skills/your-skill/SKILL.md</code> (local)</li>
            </ul>
        </div>
    );
}
