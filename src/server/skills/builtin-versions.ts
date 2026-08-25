/**
 * Provenance of the builtin skills installed under ~/.pipali/skills
 *
 * A builtin skill lives in the user's directory, where they are free to edit it, so a
 * new release cannot simply overwrite it. Comparing against the version shipping today
 * only tells us the files differ - it cannot separate a user's edit from an older
 * release of our own.
 *
 * So every version we have shipped is recorded here. A skill hashing to one of them is
 * untouched, whichever release it came from, and can be refreshed. Anything else is the
 * user's own work and is left alone until they ask for it back.
 *
 * Editing a builtin skill means appending its new hash below. `skills.test.ts` fails
 * until you do, because a missing hash silently freezes every existing install.
 */

import path from 'path';
import { readdir } from 'fs/promises';

/** A skill's files, keyed by path relative to the skill directory */
export type SkillFiles = Map<string, Uint8Array>;

/**
 * Written into an installed skill by running it, never shipped by us.
 *
 * A skill whose scripts have been run must still hash as the version we shipped, or
 * using a skill would be enough to stop it ever being updated again.
 */
const GENERATED_NAMES = new Set([
    'node_modules',
    'bun.lock',
    'bun.lockb',
    'package-lock.json',
    '__pycache__',
    '.venv',
    '.DS_Store',
]);

export function isGeneratedSkillPath(relPath: string): boolean {
    return relPath.split(/[\\/]/).some(segment => GENERATED_NAMES.has(segment));
}

/**
 * Fingerprint of a skill: every path it holds and what each one contains.
 *
 * Paths and contents are folded in through separate digests, so no file's bytes can be
 * read as the next file's path.
 */
export function hashSkillFiles(files: SkillFiles): string {
    const hasher = new Bun.CryptoHasher('sha256');
    for (const relPath of [...files.keys()].sort()) {
        const content = new Bun.CryptoHasher('sha256').update(files.get(relPath)!).digest('hex');
        hasher.update(`${relPath.split(/[\\/]/).join('/')} ${content}\n`);
    }
    return hasher.digest('hex');
}

/**
 * Read a skill directory, skipping what the app generated inside it.
 *
 * Ignoring the generated paths is what lets an installed skill hash to the same value
 * as the one we shipped, after `bun install` has run in it.
 */
export async function readSkillDirectory(skillDir: string): Promise<SkillFiles> {
    const files: SkillFiles = new Map();

    const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const relPath = prefix ? path.join(prefix, entry.name) : entry.name;
            if (isGeneratedSkillPath(relPath)) continue;
            if (entry.isDirectory()) {
                await walk(path.join(dir, entry.name), relPath);
            } else if (entry.isFile()) {
                files.set(relPath, new Uint8Array(await Bun.file(path.join(dir, entry.name)).arrayBuffer()));
            }
        }
    };

    await walk(skillDir, '');
    return files;
}

/**
 * Hashes of every version of each builtin skill we have shipped, oldest first.
 *
 * Seeded from the history of `src/server/skills/builtin/`, so installs made from any
 * past release are recognized as ours. Regenerate or extend with
 * `bun scripts/builtin-skill-hashes.ts`.
 */
export const SHIPPED_SKILL_HASHES: Record<string, string[]> = {
    'document-creator': [
        'b2dcf13d02f0cad7250b5e59c784c37d23e27d83d77e77f1e4be5f4e12744d82',
        '812c931d368a669d28a861f6bb77870c845d0bfe5c9bfd681a88526c7c0b8daf',
        '46df65862f9a3eeea34f34e1c44def8a8dd0b503e052a6856d45371086311d9b',
        '9c138279bb01b818d1a5adcca31873483effcdf229b6ca3fcc34ac528954d5c5',
        '7d29babb2781fcb9aead0c204cae156eb4e35d1a45cd57d8902c819214ec1e32',
    ],
    'introspect': [
        'd3e02831e09870c54897f8050824cd36943cd1494f203646f2673ba4103855a6',
        'f1e92ab6d69d84ab960cd3a717d6d895a2e7f4e97bd320d057565dacbee121ea',
        'dabefc077f315dfa9e52ea7e0b1e73532d42d7b34d924ec43a5e7b239268b479',
        'beb1f7292f7b834d609eabe874fcdffbeac59d2e37f66c2d60ffa961cb1a69e1',
        '07b2c518115477f95c52c35eb0c06be334116a7aafde798aa6f37845ec15ecd9',
        '82432b42114f10e6ed3fb227354ac7683d3e8eb2945c75387dd63dca91c97b94',
        '0e7af19ce036edc4b29a5da4797c721dec3c0b40d772798b584cdc581b5af37c',
        'd847288488093259b7761cb7085f27cf22b0439f343dcbe627bacf379b730cee',
    ],
    'memory-dream': [
        '6061e40c02580e0197c555203e27eef31dbeb26b9cdaacb897d3d2d479281bdc',
    ],
    'skill-creator': [
        '924a30cddd6cae87a84552fb53c6b79efc5fff885ff5ed4c784ed971a748db45',
        '8a686a33aca303b12aaa887980f77f80e67a16dd7b1ebbc77bf692e758ceb717',
    ],
};

/** Whether a hash is one of ours, meaning the install is untouched and safe to refresh */
export function isShippedSkillVersion(skillName: string, hash: string): boolean {
    return SHIPPED_SKILL_HASHES[skillName]?.includes(hash) ?? false;
}
