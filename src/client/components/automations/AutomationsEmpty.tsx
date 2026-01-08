// Empty state when no automations are configured

import { Clock } from 'lucide-react';

export function AutomationsEmpty() {
    return (
        <div className="empty-state automations-empty">
            <Clock className="empty-icon" size={32} strokeWidth={1.5} />
            <h2>No Automations</h2>
            <p>Automations run tasks on a schedule without manual intervention.</p>
            <p className="empty-hint">
                Create an automation to have Pipali perform tasks automatically.
            </p>
        </div>
    );
}
