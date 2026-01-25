/**
 * Skills module - main entry point
 * Provides skill loading, caching, and prompt formatting
 */

import path from 'path';
import type { Dirent } from 'fs';
import { mkdir, rm, readdir, cp } from 'fs/promises';
import { scanSkillsDirectory, isValidSkillName, isValidDescription } from './loader';
import { formatSkillsForPrompt, escapeYamlValue } from './utils';
import type { Skill, SkillLoadResult } from './types';
import { IS_COMPILED_BINARY, EMBEDDED_BUILTIN_SKILLS } from '../embedded-assets';
import { getSkillsDir as getSkillsDirFromPaths } from '../paths';
import { createChildLogger } from '../logger';
import { getBundledRuntimes } from '../bundled-runtimes';

const log = createChildLogger({ component: 'skills' });

// Path to builtin skills shipped with the app (used in development mode)
const BUILTIN_SKILLS_DIR = process.env.PIPALI_SERVER_RESOURCE_DIR
    ? path.join(process.env.PIPALI_SERVER_RESOURCE_DIR, 'skills', 'builtin')
    : path.join(import.meta.dir, 'builtin');

export interface DeleteSkillResult {
    success: boolean;
    error?: string;
}

export interface GetSkillResult {
    success: boolean;
    skill?: Skill;
    instructions?: string;
    error?: string;
}

export interface CreateSkillInput {
    name: string;
    description: string;
    instructions?: string;
}

export interface CreateSkillResult {
    success: boolean;
    skill?: Skill;
    error?: string;
}

export interface UpdateSkillInput {
    description: string;
    instructions?: string;
}

export interface UpdateSkillResult {
    success: boolean;
    skill?: Skill;
    error?: string;
}

// Cached skills after loading
let cachedSkills: Skill[] = [];

/**
 * Install npm dependencies for a skill if it has a package.json in scripts/
 * Uses bundled Bun runtime when available (desktop app)
 */
async function installSkillDependencies(skillDir: string, skillName: string): Promise<void> {
    const scriptsDir = path.join(skillDir, 'scripts');
    const packageJsonPath = path.join(scriptsDir, 'package.json');

    // Check if scripts/package.json exists
    const packageJson = Bun.file(packageJsonPath);
    if (!(await packageJson.exists())) {
        return;
    }

    log.info({ skillName }, `Installing npm dependencies for skill "${skillName}"`);

    try {
        const runtimes = await getBundledRuntimes();

        const proc = Bun.spawn([runtimes.bun, 'install'], {
            cwd: scriptsDir,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });

        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            log.warn({ skillName, exitCode, stderr }, `Failed to install dependencies for skill "${skillName}"`);
        } else {
            log.info({ skillName }, `Dependencies installed for skill "${skillName}"`);
        }
    } catch (err) {
        log.warn({ err, skillName }, `Failed to install dependencies for skill "${skillName}"`);
    }
}

/**
 * Get the skills directory path (~/.pipali/skills)
 */
export function getSkillsDir(): string {
    return getSkillsDirFromPaths();
}

/**
 * Install builtin skills to the skills directory.
 * Only copies skills that don't already exist (won't overwrite user modifications).
 * Called on app startup/first run.
 *
 * In compiled binary mode, uses embedded skills from EMBEDDED_BUILTIN_SKILLS.
 * In development mode, copies from the builtin/ directory.
 */
export async function installBuiltinSkills(): Promise<{ installed: string[]; skipped: string[] }> {
    const installed: string[] = [];
    const skipped: string[] = [];
    const skillsDir = getSkillsDir();

    // Ensure skills directory exists
    await mkdir(skillsDir, { recursive: true });

    if (IS_COMPILED_BINARY) {
        // Use embedded skills in compiled binary
        return installEmbeddedSkills(skillsDir, installed, skipped);
    } else {
        // Use filesystem skills in development
        return installFilesystemSkills(skillsDir, installed, skipped);
    }
}

/**
 * Install skills from embedded assets (compiled binary mode)
 */
async function installEmbeddedSkills(
    skillsDir: string,
    installed: string[],
    skipped: string[]
): Promise<{ installed: string[]; skipped: string[] }> {
    // Group files by skill name (first path segment)
    const skillFiles = new Map<string, Array<{ relativePath: string; content: string; binary: boolean }>>();

    for (const [filePath, { content, binary }] of Object.entries(EMBEDDED_BUILTIN_SKILLS)) {
        const parts = filePath.split(path.sep);
        const skillName = parts[0];
        if (!skillName) continue;
        const relativePath = parts.slice(1).join(path.sep);

        if (!skillFiles.has(skillName)) {
            skillFiles.set(skillName, []);
        }
        skillFiles.get(skillName)!.push({ relativePath, content, binary });
    }

    // Install each skill
    for (const [skillName, files] of skillFiles) {
        const destDir = path.join(skillsDir, skillName);

        // Check if skill already exists
        const destSkillMd = Bun.file(path.join(destDir, 'SKILL.md'));
        if (await destSkillMd.exists()) {
            skipped.push(skillName);
            continue;
        }

        // Write all files for this skill
        try {
            for (const { relativePath, content, binary } of files) {
                const destPath = path.join(destDir, relativePath);
                await mkdir(path.dirname(destPath), { recursive: true });

                if (binary) {
                    // Decode base64 for binary files
                    await Bun.write(destPath, Buffer.from(content, 'base64'));
                } else {
                    await Bun.write(destPath, content);
                }
            }

            // Install npm dependencies if the skill has a scripts/package.json
            await installSkillDependencies(destDir, skillName);

            installed.push(skillName);
        } catch (err) {
            log.error({ err, skillName }, `Failed to install builtin skill "${skillName}"`);
        }
    }

    return { installed, skipped };
}

/**
 * Install skills from filesystem (development mode)
 */
async function installFilesystemSkills(
    skillsDir: string,
    installed: string[],
    skipped: string[]
): Promise<{ installed: string[]; skipped: string[] }> {
    // Read builtin skills directory
    let builtinEntries: Dirent[];
    try {
        builtinEntries = await readdir(BUILTIN_SKILLS_DIR, { withFileTypes: true });
    } catch (err) {
        // No builtin skills directory or can't read it
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { installed, skipped };
        }
        throw err;
    }

    for (const entry of builtinEntries) {
        // Skip non-directories and hidden files
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }

        const skillName = entry.name;
        const srcDir = path.join(BUILTIN_SKILLS_DIR, skillName);
        const destDir = path.join(skillsDir, skillName);

        // Check if skill already exists
        const destSkillMd = Bun.file(path.join(destDir, 'SKILL.md'));
        if (await destSkillMd.exists()) {
            skipped.push(skillName);
            continue;
        }

        // Copy the skill directory
        try {
            await cp(srcDir, destDir, { recursive: true });

            // Install npm dependencies if the skill has a scripts/package.json
            await installSkillDependencies(destDir, skillName);

            installed.push(skillName);
        } catch (err) {
            log.error({ err, skillName }, `Failed to install builtin skill "${skillName}"`);
        }
    }

    return { installed, skipped };
}

/**
 * Load skills from the skills directory
 * Caches the result for later retrieval via getLoadedSkills()
 */
export async function loadSkills(): Promise<SkillLoadResult> {
    const result = await scanSkillsDirectory(getSkillsDir());
    cachedSkills = result.skills;
    return result;
}

/**
 * Get the currently loaded skills
 * Returns cached skills from the last loadSkills() call
 */
export function getLoadedSkills(): Skill[] {
    return cachedSkills;
}

/**
 * Create a new skill by writing a SKILL.md file
 */
export async function createSkill(input: CreateSkillInput): Promise<CreateSkillResult> {
    const { name, description, instructions = '' } = input;

    // Validate name
    if (!isValidSkillName(name)) {
        return {
            success: false,
            error: 'Invalid skill name: must be 1-64 lowercase alphanumeric chars and hyphens, no consecutive hyphens, cannot start/end with hyphen',
        };
    }

    // Validate description
    if (!isValidDescription(description)) {
        return {
            success: false,
            error: 'Description must be 1-1024 characters',
        };
    }

    const skillDir = path.join(getSkillsDir(), name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    // Check if skill already exists
    const existingFile = Bun.file(skillMdPath);
    if (await existingFile.exists()) {
        return {
            success: false,
            error: `Skill "${name}" already exists at ${skillMdPath}`,
        };
    }

    // Create directory structure
    try {
        await mkdir(skillDir, { recursive: true });
    } catch (err) {
        return {
            success: false,
            error: `Failed to create skill directory: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // Generate SKILL.md content
    const content = `---
name: ${name}
description: ${escapeYamlValue(description)}
---

${instructions}
`.trim() + '\n';

    // Write the file
    try {
        await Bun.write(skillMdPath, content);
    } catch (err) {
        return {
            success: false,
            error: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const skill: Skill = {
        name,
        description,
        location: skillMdPath,
    };

    return {
        success: true,
        skill,
    };
}

/**
 * Get a skill by name with its full instructions
 */
export async function getSkill(name: string): Promise<GetSkillResult> {
    // Find the skill in cache
    const skill = cachedSkills.find(s => s.name === name);
    if (!skill) {
        return {
            success: false,
            error: `Skill "${name}" not found`,
        };
    }

    // Read the SKILL.md file to get instructions
    try {
        const file = Bun.file(skill.location);
        const content = await file.text();

        // Extract instructions (everything after the frontmatter)
        const frontmatterEnd = content.indexOf('---', 3);
        const instructions = frontmatterEnd !== -1
            ? content.slice(frontmatterEnd + 3).trim()
            : '';

        return {
            success: true,
            skill,
            instructions,
        };
    } catch (err) {
        return {
            success: false,
            error: `Failed to read skill: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * Delete a skill by removing its directory
 */
export async function deleteSkill(name: string): Promise<DeleteSkillResult> {
    // Find the skill in cache
    const skill = cachedSkills.find(s => s.name === name);
    if (!skill) {
        return {
            success: false,
            error: `Skill "${name}" not found`,
        };
    }

    // Get the skill directory (parent of SKILL.md)
    const skillDir = path.dirname(skill.location);

    // Delete the directory and its contents
    try {
        await rm(skillDir, { recursive: true });
    } catch (err) {
        return {
            success: false,
            error: `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // Remove from cache
    cachedSkills = cachedSkills.filter(s => s.name !== name);

    return {
        success: true,
    };
}

/**
 * Update an existing skill's description and instructions
 */
export async function updateSkill(name: string, input: UpdateSkillInput): Promise<UpdateSkillResult> {
    const { description, instructions = '' } = input;

    // Find the skill in cache
    const skill = cachedSkills.find(s => s.name === name);
    if (!skill) {
        return {
            success: false,
            error: `Skill "${name}" not found`,
        };
    }

    // Validate description
    if (!isValidDescription(description)) {
        return {
            success: false,
            error: 'Description must be 1-1024 characters',
        };
    }

    // Generate updated SKILL.md content
    const content = `---
name: ${name}
description: ${escapeYamlValue(description)}
---

${instructions}
`.trim() + '\n';

    // Write the updated file
    try {
        await Bun.write(skill.location, content);
    } catch (err) {
        return {
            success: false,
            error: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // Update cache
    const updatedSkill: Skill = {
        ...skill,
        description,
    };
    cachedSkills = cachedSkills.map(s => s.name === name ? updatedSkill : s);

    return {
        success: true,
        skill: updatedSkill,
    };
}

// Re-export types and utilities
export { formatSkillsForPrompt, isValidSkillName, isValidDescription };
export type { Skill, SkillLoadResult, SkillLoadError } from './types';
