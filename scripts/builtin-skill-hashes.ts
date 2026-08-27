#!/usr/bin/env bun
/**
 * Regenerate the shipped-version hashes in src/server/skills/builtin-versions.ts
 *
 * Walks every commit that touched src/server/skills/builtin/, hashes each skill as it
 * stood there, and adds the working tree on top. The result is the set of fingerprints
 * an installed builtin skill can carry while still being ours rather than the user's.
 *
 * Run after editing a builtin skill; skills.test.ts fails until you do.
 */

import path from 'path';
import { $ } from 'bun';
import { hashSkillFiles, isGeneratedSkillPath, readSkillDirectory, type SkillFiles } from '../src/server/skills/builtin-versions';

const BUILTIN_DIR = 'src/server/skills/builtin';
const VERSIONS_FILE = path.join(import.meta.dir, '..', 'src', 'server', 'skills', 'builtin-versions.ts');

/** Every skill as it stood in one commit, keyed by skill name */
async function skillsAtCommit(commit: string): Promise<Map<string, SkillFiles>> {
    const listing = await $`git ls-tree -r ${commit} -- ${BUILTIN_DIR}`.text();
    const skills = new Map<string, SkillFiles>();

    for (const line of listing.split('\n').filter(Boolean)) {
        const [meta, filePath] = line.split('\t');
        const [, type, blob] = meta!.split(/\s+/);
        if (type !== 'blob' || !filePath) continue;

        const [skillName, ...rest] = filePath.slice(BUILTIN_DIR.length + 1).split('/');
        const relPath = rest.join('/');
        if (!skillName || !relPath || isGeneratedSkillPath(relPath)) continue;

        const content = new Uint8Array(await $`git cat-file blob ${blob}`.arrayBuffer());
        if (!skills.has(skillName)) skills.set(skillName, new Map());
        skills.get(skillName)!.set(relPath, content);
    }

    return skills;
}

/** The working tree's skills, which may be ahead of any commit */
async function skillsInWorkingTree(): Promise<Map<string, SkillFiles>> {
    const skills = new Map<string, SkillFiles>();
    const entries = await Array.fromAsync(new Bun.Glob('*/SKILL.md').scan({ cwd: BUILTIN_DIR }));
    for (const entry of entries) {
        const skillName = path.dirname(entry);
        skills.set(skillName, await readSkillDirectory(path.join(BUILTIN_DIR, skillName)));
    }
    return skills;
}

const commits = (await $`git log --reverse --format=%H -- ${BUILTIN_DIR}`.text()).split('\n').filter(Boolean);
console.log(`Hashing ${commits.length} commit(s) that touched ${BUILTIN_DIR}`);

/** Insertion order is chronological, so each skill's hashes come out oldest first */
const hashes = new Map<string, string[]>();
const record = (skills: Map<string, SkillFiles>) => {
    for (const [skillName, files] of skills) {
        if (files.size === 0) continue;
        const hash = hashSkillFiles(files);
        const known = hashes.get(skillName) ?? [];
        if (!known.includes(hash)) known.push(hash);
        hashes.set(skillName, known);
    }
};

for (const commit of commits) record(await skillsAtCommit(commit));
record(await skillsInWorkingTree());

const literal = [...hashes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([skillName, list]) => `    '${skillName}': [\n${list.map(h => `        '${h}',`).join('\n')}\n    ],`)
    .join('\n');

const source = await Bun.file(VERSIONS_FILE).text();
const updated = source.replace(
    /export const SHIPPED_SKILL_HASHES: Record<string, string\[\]> = \{[\s\S]*?^\};/m,
    `export const SHIPPED_SKILL_HASHES: Record<string, string[]> = {\n${literal}\n};`,
);
if (updated === source) throw new Error('Could not find SHIPPED_SKILL_HASHES to replace in builtin-versions.ts');
await Bun.write(VERSIONS_FILE, updated);

for (const [skillName, list] of hashes) console.log(`  ${skillName}: ${list.length} version(s)`);
