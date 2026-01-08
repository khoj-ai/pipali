/**
 * Skills system type definitions
 * Following the Agent Skills Specification: https://agentskills.io/specification
 */

/**
 * Parsed skill metadata from SKILL.md frontmatter
 */
export interface Skill {
    /** Skill name (1-64 chars, lowercase alphanumeric and hyphens) */
    name: string;
    /** Description of what the skill does (1-1024 chars) */
    description: string;
    /** Absolute path to the SKILL.md file */
    location: string;
    /** Source path: 'global' (~/.pipali/skills) or 'local' (cwd/.pipali/skills) */
    source: 'global' | 'local';
}

/**
 * Result of loading skills
 */
export interface SkillLoadResult {
    /** Successfully loaded skills */
    skills: Skill[];
    /** Errors encountered during loading (logged but not fatal) */
    errors: SkillLoadError[];
}

/**
 * Error encountered while loading a skill
 */
export interface SkillLoadError {
    /** Path to the skill directory or SKILL.md file */
    path: string;
    /** Description of what went wrong */
    message: string;
}

/**
 * Raw frontmatter parsed from SKILL.md
 */
export interface SkillFrontmatter {
    name?: string;
    description?: string;
}
