/**
 * Skills loader - discovers and parses SKILL.md files from skill directories
 */

import path from 'path';
import { parseFrontmatter as parseYamlFrontmatter } from '../frontmatter';
import type { Skill, SkillLoadResult, SkillLoadError, SkillFrontmatter } from './types';

/**
 * Regex pattern for valid skill names:
 * - 1-64 characters
 * - Lowercase alphanumeric and hyphens only
 * - Cannot start/end with hyphens
 * - No consecutive hyphens
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$|^[a-z0-9]$/;

/**
 * Parse the skill fields out of SKILL.md frontmatter
 */
export function parseFrontmatter(content: string): SkillFrontmatter | null {
    const parsed = parseYamlFrontmatter(content);
    if (!parsed) {
        return null;
    }

    const result: SkillFrontmatter = {};

    if (parsed.fields.name) {
        result.name = parsed.fields.name;
    }
    if (parsed.fields.description) {
        result.description = parsed.fields.description;
    }
    // Visibility is only honored under metadata, never as a top-level field
    if (parsed.metadata.visible === 'true' || parsed.metadata.visible === 'false') {
        result.visible = parsed.metadata.visible === 'true';
    }

    return result;
}

/**
 * Validate a skill name according to the specification
 */
export function isValidSkillName(name: string): boolean {
    if (name.length < 1 || name.length > 64) {
        return false;
    }
    if (name.includes('--')) {
        return false;
    }
    return SKILL_NAME_PATTERN.test(name);
}

/**
 * Validate a skill description according to the specification
 */
export function isValidDescription(description: string): boolean {
    return description.length >= 1 && description.length <= 1024;
}

/**
 * Load a single skill from a directory
 */
async function loadSkill(skillDir: string): Promise<{ skill?: Skill; error?: SkillLoadError }> {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const dirName = path.basename(skillDir);

    // Check if SKILL.md exists
    const file = Bun.file(skillMdPath);
    const exists = await file.exists();
    if (!exists) {
        return {
            error: {
                path: skillDir,
                message: 'Missing SKILL.md file',
            },
        };
    }

    // Read and parse the file
    let content: string;
    try {
        content = await file.text();
    } catch (err) {
        return {
            error: {
                path: skillMdPath,
                message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
            },
        };
    }

    // Parse frontmatter
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
        return {
            error: {
                path: skillMdPath,
                message: 'Missing or invalid YAML frontmatter',
            },
        };
    }

    // Validate required fields
    if (!frontmatter.name) {
        return {
            error: {
                path: skillMdPath,
                message: 'Missing required field: name',
            },
        };
    }

    if (!frontmatter.description) {
        return {
            error: {
                path: skillMdPath,
                message: 'Missing required field: description',
            },
        };
    }

    // Validate name format
    if (!isValidSkillName(frontmatter.name)) {
        return {
            error: {
                path: skillMdPath,
                message: `Invalid skill name "${frontmatter.name}": must be 1-64 lowercase alphanumeric chars and hyphens, no consecutive hyphens, cannot start/end with hyphen`,
            },
        };
    }

    // Validate name matches directory
    if (frontmatter.name !== dirName) {
        return {
            error: {
                path: skillMdPath,
                message: `Skill name "${frontmatter.name}" does not match directory name "${dirName}"`,
            },
        };
    }

    // Validate description length
    if (!isValidDescription(frontmatter.description)) {
        return {
            error: {
                path: skillMdPath,
                message: `Description must be 1-1024 characters, got ${frontmatter.description.length}`,
            },
        };
    }

    return {
        skill: {
            name: frontmatter.name,
            description: frontmatter.description,
            location: skillMdPath,
            visible: frontmatter.visible !== false,
        },
    };
}

/**
 * Scan a skills directory and load all valid skills
 */
export async function scanSkillsDirectory(skillsDir: string): Promise<SkillLoadResult> {
    const skills: Skill[] = [];
    const errors: SkillLoadError[] = [];

    try {
        // Use readdir to list directories
        const { readdir } = await import('fs/promises');
        const entries = await readdir(skillsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            // Skip hidden directories
            if (entry.name.startsWith('.')) {
                continue;
            }

            const skillDir = path.join(skillsDir, entry.name);
            const result = await loadSkill(skillDir);

            if (result.skill) {
                skills.push(result.skill);
            } else if (result.error) {
                errors.push(result.error);
            }
        }
    } catch (err) {
        // Directory doesn't exist or isn't readable - this is fine, just skip
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            errors.push({
                path: skillsDir,
                message: `Failed to read directory: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }

    // Sort by name for consistent ordering
    skills.sort((a, b) => a.name.localeCompare(b.name));

    return { skills, errors };
}
