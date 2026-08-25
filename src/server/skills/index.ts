/**
 * Skills module - main entry point
 * Provides skill loading, caching, and prompt formatting
 */

import path from 'path';
import type { Dirent } from 'fs';
import { mkdir, rm, readdir } from 'fs/promises';
import { scanSkillsDirectory, isValidSkillName, isValidDescription } from './loader';
import { formatSkillsForPrompt, escapeYamlValue } from './utils';
import type { Skill, SkillLoadResult } from './types';
import {
    SHIPPED_SKILL_HASHES,
    hashSkillFiles,
    isGeneratedSkillPath,
    isShippedSkillVersion,
    readSkillDirectory,
    type SkillFiles,
} from './builtin-versions';
import { parseFrontmatter } from '../frontmatter';
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

export interface ResetSkillResult {
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
 * The builtin skills as this build ships them, keyed by skill name.
 *
 * A compiled binary carries them as embedded strings and development reads the source
 * tree; both arrive as the same file map, so everything downstream is shared.
 */
async function readShippedSkills(): Promise<Map<string, SkillFiles>> {
    const skills = new Map<string, SkillFiles>();

    if (IS_COMPILED_BINARY) {
        for (const [filePath, { content, binary }] of Object.entries(EMBEDDED_BUILTIN_SKILLS)) {
            const [skillName, ...rest] = filePath.split(path.sep);
            const relPath = rest.join(path.sep);
            if (!skillName || !relPath || isGeneratedSkillPath(relPath)) continue;
            if (!skills.has(skillName)) skills.set(skillName, new Map());
            skills.get(skillName)!.set(relPath, new Uint8Array(Buffer.from(content, binary ? 'base64' : 'utf8')));
        }
        return skills;
    }

    let entries: Dirent[];
    try {
        entries = await readdir(BUILTIN_SKILLS_DIR, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return skills;
        }
        throw err;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        skills.set(entry.name, await readSkillDirectory(path.join(BUILTIN_SKILLS_DIR, entry.name)));
    }

    return skills;
}

/**
 * Make a skill directory hold exactly what we ship, removing shipped files this
 * version dropped.
 *
 * Called to refresh an untouched install, where the removed files are only ever ones
 * we put there, and to reset a customized one, where replacing the user's version is
 * the point. Leaving a dropped file behind would keep the directory hashing as
 * customized forever, so the removal pass is what makes a refresh repeatable.
 */
async function writeSkill(destDir: string, files: SkillFiles): Promise<void> {
    for (const [relPath, content] of files) {
        const destPath = path.join(destDir, relPath);
        await mkdir(path.dirname(destPath), { recursive: true });
        await Bun.write(destPath, content);
    }

    for (const relPath of (await readSkillDirectory(destDir)).keys()) {
        if (!files.has(relPath)) {
            await rm(path.join(destDir, relPath), { force: true });
        }
    }
}

/**
 * What an installed builtin skill should get on startup.
 *
 * `refresh` is the case the hash list exists for: the files differ from what ships
 * today but match a release of ours, so they are an old install rather than the user's
 * work. Anything else that differs is theirs and is kept.
 */
export function builtinSkillAction(skillName: string, onDiskHash: string, shippedHash: string): 'unchanged' | 'refresh' | 'keep' {
    if (onDiskHash === shippedHash) return 'unchanged';
    return isShippedSkillVersion(skillName, onDiskHash) ? 'refresh' : 'keep';
}

export interface BuiltinSkillInstallResult {
    /** Skills that were not on disk at all */
    installed: string[];
    /** Untouched installs of an older release, brought up to date */
    refreshed: string[];
    /** Installs the user has edited, left as they are */
    customized: string[];
    /** Installs already holding what this build ships */
    unchanged: string[];
}

/**
 * Install and update the builtin skills in ~/.pipali/skills, called on startup.
 *
 * These live in the user's directory and are theirs to edit, so an update lands only
 * where the files are still exactly as some release of ours left them. Anything else is
 * their own version and stays until they reset it.
 */
export async function installBuiltinSkills(): Promise<BuiltinSkillInstallResult> {
    const result: BuiltinSkillInstallResult = { installed: [], refreshed: [], customized: [], unchanged: [] };
    const skillsDir = getSkillsDir();

    await mkdir(skillsDir, { recursive: true });

    for (const [skillName, files] of await readShippedSkills()) {
        const destDir = path.join(skillsDir, skillName);
        try {
            if (!(await Bun.file(path.join(destDir, 'SKILL.md')).exists())) {
                await writeSkill(destDir, files);
                await installSkillDependencies(destDir, skillName);
                result.installed.push(skillName);
                continue;
            }

            const onDisk = hashSkillFiles(await readSkillDirectory(destDir));
            switch (builtinSkillAction(skillName, onDisk, hashSkillFiles(files))) {
                case 'unchanged':
                    result.unchanged.push(skillName);
                    break;
                case 'refresh':
                    await writeSkill(destDir, files);
                    await installSkillDependencies(destDir, skillName);
                    result.refreshed.push(skillName);
                    break;
                case 'keep':
                    result.customized.push(skillName);
                    break;
            }
        } catch (err) {
            log.error({ err, skillName }, `Failed to install builtin skill "${skillName}"`);
        }
    }

    return result;
}

/**
 * Restore a builtin skill to the version this build ships.
 *
 * The shipped copy travels with the app, so the user's edits are never a one-way door.
 */
export async function resetBuiltinSkill(name: string): Promise<ResetSkillResult> {
    const files = (await readShippedSkills()).get(name);
    if (!files) {
        return { success: false, error: `"${name}" is not a builtin skill` };
    }

    const destDir = path.join(getSkillsDir(), name);
    try {
        await writeSkill(destDir, files);
        await installSkillDependencies(destDir, name);
    } catch (err) {
        return {
            success: false,
            error: `Failed to reset skill: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    await loadSkills();
    return { success: true, skill: cachedSkills.find(s => s.name === name) };
}

/**
 * Load skills from the skills directory
 * Caches the result for later retrieval via getLoadedSkills()
 */
export async function loadSkills(): Promise<SkillLoadResult> {
    const result = await scanSkillsDirectory(getSkillsDir());
    cachedSkills = await Promise.all(result.skills.map(markBuiltinProvenance));
    return { ...result, skills: cachedSkills };
}

/**
 * Note whether a skill is one we ship and, if so, whether the user has edited it.
 *
 * Drives the modified badge and the reset action. A skill we never shipped is simply
 * the user's own and gets neither.
 */
async function markBuiltinProvenance(skill: Skill): Promise<Skill> {
    if (!(skill.name in SHIPPED_SKILL_HASHES)) {
        return skill;
    }
    try {
        const hash = hashSkillFiles(await readSkillDirectory(path.dirname(skill.location)));
        return { ...skill, builtin: true, modified: !isShippedSkillVersion(skill.name, hash) };
    } catch (err) {
        log.warn({ err, skillName: skill.name }, 'Could not determine whether builtin skill was edited');
        return { ...skill, builtin: true };
    }
}

/**
 * Get the currently loaded skills
 * Returns cached skills from the last loadSkills() call
 */
export function getLoadedSkills(): Skill[] {
    return cachedSkills;
}

/**
 * Generate SKILL.md file content with frontmatter for new skills
 */
function generateNewSkillMdContent(name: string, description: string, instructions: string = ''): string {
    return `---
name: ${name}
description: ${escapeYamlValue(description)}
---

${instructions}
`.trim() + '\n';
}

/**
 * Update the metadata.visible field in raw YAML frontmatter, preserving all other fields.
 * Only writes visible: false (omits when true, since true is the default).
 */
function updateYamlVisibility(yaml: string, visible: boolean): string {
    const metadataMatch = yaml.match(/^(metadata:\s*\r?\n)((?:[ \t]+[^\n]*(?:\r?\n|$))*)/m);

    if (metadataMatch) {
        const metadataPrefix = metadataMatch[1]!;
        const metadataBody = metadataMatch[2]!;
        // Remove existing visible line (including its trailing newline)
        const cleanedBody = metadataBody.replace(/^[ \t]+visible:\s*["']?(true|false)["']?\s*\r?\n?/m, '');
        const hasOtherFields = cleanedBody.trim() !== '';

        if (visible) {
            if (!hasOtherFields) {
                // Remove entire metadata block and any preceding newline
                return yaml.replace('\n' + metadataMatch[0], '').replace(metadataMatch[0], '');
            }
            return yaml.replace(metadataMatch[0], metadataPrefix + cleanedBody);
        } else {
            const newBody = '  visible: false\n' + cleanedBody;
            return yaml.replace(metadataMatch[0], metadataPrefix + newBody);
        }
    }

    // No existing metadata block
    if (visible) {
        return yaml;
    }
    return yaml + '\nmetadata:\n  visible: false';
}

/**
 * Reassemble a SKILL.md file from YAML frontmatter and body content
 */
function assembleSkillMd(yaml: string, body: string): string {
    return body
        ? `---\n${yaml}\n---\n\n${body}\n`
        : `---\n${yaml}\n---\n`;
}

/**
 * Update the description field in raw YAML frontmatter
 */
function updateYamlDescription(yaml: string, description: string): string {
    // Match description in any format (quoted, unquoted, multiline)
    // Try double-quoted
    let updated = yaml.replace(/^description:\s*"(?:[^"\\]|\\.)*"\s*$/m, `description: ${escapeYamlValue(description)}`);
    if (updated !== yaml) return updated;
    // Try single-quoted
    updated = yaml.replace(/^description:\s*'(?:[^'\\]|\\.)*'\s*$/m, `description: ${escapeYamlValue(description)}`);
    if (updated !== yaml) return updated;
    // Try multiline (> or |)
    updated = yaml.replace(/^description:\s*[>|]\s*\r?\n(?:[ \t]+[^\n]*\r?\n?)+/m, `description: ${escapeYamlValue(description)}`);
    if (updated !== yaml) return updated;
    // Try unquoted
    updated = yaml.replace(/^description:\s*[^\n]+$/m, `description: ${escapeYamlValue(description)}`);
    return updated;
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
    const content = generateNewSkillMdContent(name, description, instructions);

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
        visible: true,
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

    // Read existing file to preserve metadata fields
    let existingContent: string;
    try {
        existingContent = await Bun.file(skill.location).text();
    } catch (err) {
        return {
            success: false,
            error: `Failed to read skill: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const parts = parseFrontmatter(existingContent);
    if (!parts) {
        return { success: false, error: 'Failed to parse existing SKILL.md frontmatter' };
    }

    // Update description in YAML, preserving other fields (including metadata)
    const updatedYaml = updateYamlDescription(parts.yaml, description);
    const content = assembleSkillMd(updatedYaml, instructions);

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

export interface ToggleVisibilityResult {
    success: boolean;
    skill?: Skill;
    error?: string;
}

/**
 * Toggle a skill's visibility (visible field in frontmatter)
 */
export async function toggleSkillVisibility(name: string, visible: boolean): Promise<ToggleVisibilityResult> {
    const skill = cachedSkills.find(s => s.name === name);
    if (!skill) {
        return { success: false, error: `Skill "${name}" not found` };
    }

    // Read existing file to preserve all content
    let existingContent: string;
    try {
        existingContent = await Bun.file(skill.location).text();
    } catch (err) {
        return {
            success: false,
            error: `Failed to read skill: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const parts = parseFrontmatter(existingContent);
    if (!parts) {
        return { success: false, error: 'Failed to parse existing SKILL.md frontmatter' };
    }

    // Update only the visible field in metadata, preserving everything else
    const updatedYaml = updateYamlVisibility(parts.yaml, visible);
    const content = assembleSkillMd(updatedYaml, parts.body);
    try {
        await Bun.write(skill.location, content);
    } catch (err) {
        return {
            success: false,
            error: `Failed to write SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // Update cache
    const updatedSkill: Skill = { ...skill, visible };
    cachedSkills = cachedSkills.map(s => s.name === name ? updatedSkill : s);

    return { success: true, skill: updatedSkill };
}

// Re-export types and utilities
export { formatSkillsForPrompt, isValidSkillName, isValidDescription };
export type { Skill, SkillLoadResult, SkillLoadError } from './types';
