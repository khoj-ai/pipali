/**
 * PathListEditor - A component for editing a list of file system paths.
 * Used in the sandbox settings UI to manage allowed/denied paths.
 */

import React, { useState } from 'react';
import { Plus, X, FolderOpen } from 'lucide-react';

interface PathListEditorProps {
    /** The list of paths */
    paths: string[];
    /** Callback when paths change */
    onChange: (paths: string[]) => void;
    /** Placeholder text for new path input */
    placeholder?: string;
    /** Whether the editor is disabled */
    disabled?: boolean;
}

export function PathListEditor({
    paths,
    onChange,
    placeholder = 'Enter a path (e.g., ~/Documents)',
    disabled = false,
}: PathListEditorProps) {
    const [newPath, setNewPath] = useState('');

    const handleAdd = () => {
        const trimmed = newPath.trim();
        if (trimmed && !paths.includes(trimmed)) {
            onChange([...paths, trimmed]);
            setNewPath('');
        }
    };

    const handleRemove = (index: number) => {
        const updated = paths.filter((_, i) => i !== index);
        onChange(updated);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAdd();
        }
    };

    return (
        <div className="path-list-editor">
            {/* Existing paths */}
            {paths.length > 0 && (
                <div className="path-list">
                    {paths.map((pathItem, index) => (
                        <div key={index} className="path-item">
                            <FolderOpen size={14} className="path-icon" />
                            <span className="path-text" title={pathItem}>
                                {pathItem}
                            </span>
                            <button
                                type="button"
                                className="path-remove-btn"
                                onClick={() => handleRemove(index)}
                                disabled={disabled}
                                title="Remove path"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {/* Add new path input */}
            <div className="path-add-row">
                <input
                    type="text"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    className="path-input"
                />
                <button
                    type="button"
                    onClick={handleAdd}
                    disabled={disabled || !newPath.trim()}
                    className="path-add-btn"
                    title="Add path"
                >
                    <Plus size={16} />
                </button>
            </div>
        </div>
    );
}
