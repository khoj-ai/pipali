import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { parseFrontmatter, isValidSkillName, scanSkillsDirectory } from '../../src/server/skills/loader';
import { formatSkillsForPrompt, escapeYamlValue } from '../../src/server/skills/utils';
import type { Skill } from '../../src/server/skills/types';
import { loadSkills, builtinSkillAction, resetBuiltinSkill } from '../../src/server/skills';
import { SHIPPED_SKILL_HASHES, hashSkillFiles, readSkillDirectory } from '../../src/server/skills/builtin-versions';

describe('skills', () => {
    const testDir = path.join(os.tmpdir(), 'skills-tests');

    beforeAll(async () => {
        await fs.mkdir(testDir, { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
    });

    describe('parseFrontmatter', () => {
        test('should parse valid frontmatter with unquoted values', () => {
            const content = `---
name: my-skill
description: A test skill for testing
---
# My Skill
This is the skill content.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.name).toBe('my-skill');
            expect(result?.description).toBe('A test skill for testing');
        });

        test('should parse frontmatter with quoted values', () => {
            const content = `---
name: "quoted-skill"
description: 'A quoted description'
---
Content here.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.name).toBe('quoted-skill');
            expect(result?.description).toBe('A quoted description');
        });

        test('should parse description with inner apostrophe in double quotes', () => {
            const content = `---
name: accounts-skill
description: "The user's accounts manager"
---
Content here.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.name).toBe('accounts-skill');
            expect(result?.description).toBe("The user's accounts manager");
        });

        test('should parse description with inner double quote in single quotes', () => {
            const content = `---
name: quote-skill
description: 'A "quoted" word inside'
---
Content here.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.description).toBe('A "quoted" word inside');
        });

        test('should parse description with escaped quotes in double quotes', () => {
            const content = `---
name: escaped-skill
description: "Say \\"hello\\" to the user"
---
Content here.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.description).toBe('Say "hello" to the user');
        });

        test('should parse unquoted description with apostrophe', () => {
            const content = `---
name: user-skill
description: Read the user's notes and tasks
---
Content here.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.description).toBe("Read the user's notes and tasks");
        });

        test('should return null for missing frontmatter', () => {
            const content = `# No Frontmatter
Just some content.
`;
            const result = parseFrontmatter(content);
            expect(result).toBeNull();
        });

        test('should handle frontmatter with only name', () => {
            const content = `---
name: only-name
---
Content.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.name).toBe('only-name');
            expect(result?.description).toBeUndefined();
        });
    });

    describe('isValidSkillName', () => {
        test('should accept valid names', () => {
            expect(isValidSkillName('a')).toBe(true);
            expect(isValidSkillName('skill')).toBe(true);
            expect(isValidSkillName('my-skill')).toBe(true);
            expect(isValidSkillName('skill123')).toBe(true);
            expect(isValidSkillName('my-cool-skill-2')).toBe(true);
        });

        test('should reject empty names', () => {
            expect(isValidSkillName('')).toBe(false);
        });

        test('should reject names with uppercase', () => {
            expect(isValidSkillName('MySkill')).toBe(false);
            expect(isValidSkillName('SKILL')).toBe(false);
        });

        test('should reject names starting with hyphen', () => {
            expect(isValidSkillName('-skill')).toBe(false);
        });

        test('should reject names ending with hyphen', () => {
            expect(isValidSkillName('skill-')).toBe(false);
        });

        test('should reject names with consecutive hyphens', () => {
            expect(isValidSkillName('my--skill')).toBe(false);
        });

        test('should reject names over 64 characters', () => {
            const longName = 'a'.repeat(65);
            expect(isValidSkillName(longName)).toBe(false);
        });

        test('should reject names with special characters', () => {
            expect(isValidSkillName('my_skill')).toBe(false);
            expect(isValidSkillName('my.skill')).toBe(false);
            expect(isValidSkillName('my skill')).toBe(false);
        });
    });

    describe('scanSkillsDirectory', () => {
        const skillsDir = path.join(testDir, 'scan-skills');

        beforeAll(async () => {
            await fs.mkdir(skillsDir, { recursive: true });
        });

        test('should load valid skill', async () => {
            const skillDir = path.join(skillsDir, 'valid-skill');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
name: valid-skill
description: A valid test skill
---
# Valid Skill
This is a test skill.
`
            );

            const result = await scanSkillsDirectory(skillsDir);

            expect(result.skills.length).toBeGreaterThanOrEqual(1);
            const skill = result.skills.find((s: Skill) => s.name === 'valid-skill');
            expect(skill).toBeDefined();
            expect(skill?.description).toBe('A valid test skill');
        });

        test('should skip skill with missing name', async () => {
            const skillDir = path.join(skillsDir, 'no-name');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
description: Missing name field
---
Content.
`
            );

            const result = await scanSkillsDirectory(skillsDir);

            const error = result.errors.find((e: { path: string }) => e.path.includes('no-name'));
            expect(error).toBeDefined();
            expect(error?.message).toContain('Missing required field: name');
        });

        test('should skip skill with invalid name format', async () => {
            const skillDir = path.join(skillsDir, 'InvalidName');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
name: InvalidName
description: Has invalid name
---
Content.
`
            );

            const result = await scanSkillsDirectory(skillsDir);

            const error = result.errors.find((e: { path: string }) => e.path.includes('InvalidName'));
            expect(error).toBeDefined();
            expect(error?.message).toContain('Invalid skill name');
        });

        test('should skip skill when name does not match directory', async () => {
            const skillDir = path.join(skillsDir, 'dir-name');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
name: different-name
description: Name does not match directory
---
Content.
`
            );

            const result = await scanSkillsDirectory(skillsDir);

            const error = result.errors.find((e: { path: string }) => e.path.includes('dir-name'));
            expect(error).toBeDefined();
            expect(error?.message).toContain('does not match directory name');
        });

        test('should handle non-existent directory gracefully', async () => {
            const result = await scanSkillsDirectory('/nonexistent/path/skills');

            expect(result.skills.length).toBe(0);
            expect(result.errors.length).toBe(0); // Non-existent dir is silently skipped
        });

        test('should load skill with apostrophe in description', async () => {
            const skillDir = path.join(skillsDir, 'apostrophe-skill');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
name: apostrophe-skill
description: "Manage the user's personal accounts"
---
# Apostrophe Skill
`
            );

            const result = await scanSkillsDirectory(skillsDir);

            const skill = result.skills.find((s: Skill) => s.name === 'apostrophe-skill');
            expect(skill).toBeDefined();
            expect(skill?.description).toBe("Manage the user's personal accounts");
        });

        test('should load skill with double quotes in description', async () => {
            const skillDir = path.join(skillsDir, 'quotes-skill');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
name: quotes-skill
description: 'Run the "special" command'
---
# Quotes Skill
`
            );

            const result = await scanSkillsDirectory(skillsDir);

            const skill = result.skills.find((s: Skill) => s.name === 'quotes-skill');
            expect(skill).toBeDefined();
            expect(skill?.description).toBe('Run the "special" command');
        });

        test('should load skill with unquoted description', async () => {
            const skillDir = path.join(skillsDir, 'unquoted-skill');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
name: unquoted-skill
description: A simple unquoted description
---
# Unquoted Skill
`
            );

            const result = await scanSkillsDirectory(skillsDir);

            const skill = result.skills.find((s: Skill) => s.name === 'unquoted-skill');
            expect(skill).toBeDefined();
            expect(skill?.description).toBe('A simple unquoted description');
        });

        test('should load skill with unquoted description containing apostrophe', async () => {
            const skillDir = path.join(skillsDir, 'unquoted-apostrophe');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
name: unquoted-apostrophe
description: Manage the user's notes and tasks
---
# Unquoted Apostrophe Skill
`
            );

            const result = await scanSkillsDirectory(skillsDir);

            const skill = result.skills.find((s: Skill) => s.name === 'unquoted-apostrophe');
            expect(skill).toBeDefined();
            expect(skill?.description).toBe("Manage the user's notes and tasks");
        });

        test('should load skill with metadata visible: false', async () => {
            const skillDir = path.join(skillsDir, 'hidden-skill');
            await fs.mkdir(skillDir, { recursive: true });
            await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                `---
name: hidden-skill
description: A hidden skill
metadata:
  visible: false
---
# Hidden Skill
`
            );

            const result = await scanSkillsDirectory(skillsDir);
            const skill = result.skills.find((s: Skill) => s.name === 'hidden-skill');
            expect(skill).toBeDefined();
            expect(skill?.visible).toBe(false);
        });

        test('should default visible to true when not in frontmatter', async () => {
            const result = await scanSkillsDirectory(skillsDir);
            const skill = result.skills.find((s: Skill) => s.name === 'valid-skill');
            expect(skill).toBeDefined();
            expect(skill?.visible).toBe(true);
        });
    });

    describe('parseFrontmatter visibility', () => {
        test('should parse visible: false under metadata', () => {
            const content = `---
name: hidden-skill
description: A hidden skill
metadata:
  visible: false
---
Content.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.visible).toBe(false);
        });

        test('should parse quoted string visible: "false" under metadata', () => {
            const content = `---
name: quoted-vis
description: Quoted visible value
metadata:
  visible: "false"
---
Content.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.visible).toBe(false);
        });

        test('should not parse top-level visible field', () => {
            const content = `---
name: top-level-skill
description: Has top-level visible
visible: false
---
Content.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.visible).toBeUndefined();
        });
    });

    describe('escapeYamlValue', () => {
        test('should not escape simple values', () => {
            expect(escapeYamlValue('A simple description')).toBe('A simple description');
        });

        test('should escape values with apostrophes', () => {
            expect(escapeYamlValue("Manage the user's notes")).toBe('"Manage the user\'s notes"');
        });

        test('should escape values with double quotes', () => {
            expect(escapeYamlValue('Run the "special" command')).toBe('"Run the \\"special\\" command"');
        });

        test('should escape values with colons', () => {
            expect(escapeYamlValue('Format: JSON')).toBe('"Format: JSON"');
        });

        test('should escape values starting with special characters', () => {
            expect(escapeYamlValue('- list item')).toBe('"- list item"');
            expect(escapeYamlValue('#comment')).toBe('"#comment"');
        });

        test('should handle values with backslashes', () => {
            expect(escapeYamlValue('Path: C:\\Users')).toBe('"Path: C:\\\\Users"');
        });

        test('escaped value should round-trip through parseFrontmatter', () => {
            const description = "Manage the user's notes and tasks";
            const escaped = escapeYamlValue(description);
            const content = `---
name: test-skill
description: ${escaped}
---
Content here.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.description).toBe(description);
        });

        test('escaped value with double quotes should round-trip', () => {
            const description = 'Run the "special" command';
            const escaped = escapeYamlValue(description);
            const content = `---
name: test-skill
description: ${escaped}
---
Content here.
`;
            const result = parseFrontmatter(content);
            expect(result).not.toBeNull();
            expect(result?.description).toBe(description);
        });
    });

    describe('formatSkillsForPrompt', () => {
        test('should return empty string for no skills', () => {
            const result = formatSkillsForPrompt([]);
            expect(result).toBe('');
        });

        test('should format single skill as XML', () => {
            const skills: Skill[] = [
                {
                    name: 'test-skill',
                    description: 'A test skill',
                    location: '/path/to/test-skill/SKILL.md',
                    visible: true,
                },
            ];

            const result = formatSkillsForPrompt(skills);

            expect(result).toContain('<available_skills>');
            expect(result).toContain('</available_skills>');
            expect(result).toContain('<skill>');
            expect(result).toContain('<name>test-skill</name>');
            expect(result).toContain('<description>A test skill</description>');
            expect(result).toContain('<location>/path/to/test-skill/SKILL.md</location>');
        });

        test('should escape XML special characters', () => {
            const skills: Skill[] = [
                {
                    name: 'xml-skill',
                    description: 'Uses <tags> & "quotes"',
                    location: '/path/to/skill',
                    visible: true,
                },
            ];

            const result = formatSkillsForPrompt(skills);

            expect(result).toContain('&lt;tags&gt;');
            expect(result).toContain('&amp;');
            expect(result).toContain('&quot;quotes&quot;');
        });

        test('should format multiple skills', () => {
            const skills: Skill[] = [
                { name: 'skill-1', description: 'First skill', location: '/path/1', visible: true },
                { name: 'skill-2', description: 'Second skill', location: '/path/2', visible: true },
            ];

            const result = formatSkillsForPrompt(skills);

            expect(result).toContain('<name>skill-1</name>');
            expect(result).toContain('<name>skill-2</name>');
        });
    });
});

describe('builtin skill provenance', () => {
    const builtinDir = path.join(import.meta.dir, '..', '..', 'src', 'server', 'skills', 'builtin');
    const shippedDir = path.join(os.tmpdir(), 'skills-provenance-tests');

    const shippedSkillNames = async () =>
        (await fs.readdir(builtinDir, { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
            .map(entry => entry.name);

    beforeAll(async () => {
        await fs.mkdir(shippedDir, { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(shippedDir, { recursive: true, force: true });
        delete process.env.PIPALI_SKILLS_DIR;
    });

    test('every builtin skill we ship has its hash recorded', async () => {
        for (const name of await shippedSkillNames()) {
            const hash = hashSkillFiles(await readSkillDirectory(path.join(builtinDir, name)));
            // Editing a builtin skill without `bun scripts/builtin-skill-hashes.ts` would
            // leave every existing install looking customized, frozen on its old version
            expect(SHIPPED_SKILL_HASHES[name] ?? []).toContain(hash);
        }
    });

    test('an install left by an older release refreshes, an edited one is kept', async () => {
        // A skill we have shipped more than once, so its first hash is genuinely an
        // older release rather than the version on disk now
        const revised = Object.entries(SHIPPED_SKILL_HASHES).find(([, hashes]) => hashes.length > 1);
        expect(revised).toBeDefined();

        const [name, hashes] = revised!;
        const shipped = hashSkillFiles(await readSkillDirectory(path.join(builtinDir, name)));

        expect(builtinSkillAction(name, hashes[0]!, shipped)).toBe('refresh');
        expect(builtinSkillAction(name, shipped, shipped)).toBe('unchanged');
        expect(builtinSkillAction(name, 'a'.repeat(64), shipped)).toBe('keep');
    });

    test('installing and running a skill does not make it look edited', async () => {
        const [name] = await shippedSkillNames();
        const skillDir = path.join(shippedDir, 'generated', name!);
        await fs.cp(path.join(builtinDir, name!), skillDir, { recursive: true });
        const pristine = hashSkillFiles(await readSkillDirectory(skillDir));

        // What each toolchain leaves in a skill directory. Anything counted here would
        // freeze the skill on its current version the first time the user ran it
        const artifacts: [string, string][] = [
            ['scripts/node_modules/left-pad/index.js', 'module.exports = 1;'],
            ['scripts/bun.lock', '{}'],
            ['scripts/__pycache__/helper.cpython-313.pyc', 'compiled bytecode'],
            ['scripts/.venv/pyvenv.cfg', 'home = /usr/bin'],
        ];
        for (const [relPath, content] of artifacts) {
            await fs.mkdir(path.dirname(path.join(skillDir, relPath)), { recursive: true });
            await fs.writeFile(path.join(skillDir, relPath), content);
        }

        expect(hashSkillFiles(await readSkillDirectory(skillDir))).toBe(pristine);
    });

    test('loadSkills marks builtin skills and whether the user edited them', async () => {
        const skillsDir = path.join(shippedDir, 'installed');
        await fs.rm(skillsDir, { recursive: true, force: true });
        await fs.mkdir(skillsDir, { recursive: true });

        const names = await shippedSkillNames();
        for (const name of names) {
            await fs.cp(path.join(builtinDir, name), path.join(skillsDir, name), { recursive: true });
        }
        await fs.mkdir(path.join(skillsDir, 'user-own'), { recursive: true });
        await fs.writeFile(
            path.join(skillsDir, 'user-own', 'SKILL.md'),
            '---\nname: user-own\ndescription: A skill the user wrote themselves\n---\n\nDo the thing.\n',
        );

        const edited = names[0]!;
        await fs.appendFile(path.join(skillsDir, edited, 'SKILL.md'), '\nAlso never record anything about my health.\n');

        process.env.PIPALI_SKILLS_DIR = skillsDir;
        const byName = new Map((await loadSkills()).skills.map(skill => [skill.name, skill]));

        expect(byName.get(edited)).toMatchObject({ builtin: true, modified: true });
        for (const name of names.slice(1)) {
            expect(byName.get(name)).toMatchObject({ builtin: true, modified: false });
        }
        expect(byName.get('user-own')?.builtin).toBeUndefined();
    });

    test('resetting a builtin skill restores our version and clears what the user added', async () => {
        const skillsDir = path.join(shippedDir, 'reset');
        await fs.rm(skillsDir, { recursive: true, force: true });
        await fs.mkdir(skillsDir, { recursive: true });

        // A skill with no scripts/package.json, so the reset does not shell out to `bun install`
        const names = await shippedSkillNames();
        const candidates = await Promise.all(names.map(async name =>
            (await Bun.file(path.join(builtinDir, name, 'scripts', 'package.json')).exists()) ? null : name));
        const name = candidates.find(Boolean)!;
        expect(name).toBeDefined();

        await fs.cp(path.join(builtinDir, name), path.join(skillsDir, name), { recursive: true });
        const shipped = hashSkillFiles(await readSkillDirectory(path.join(builtinDir, name)));

        await fs.appendFile(path.join(skillsDir, name, 'SKILL.md'), '\nAlways read the ledger first.\n');
        await fs.writeFile(path.join(skillsDir, name, 'NOTES.md'), 'a file the user dropped in');

        process.env.PIPALI_SKILLS_DIR = skillsDir;
        expect(hashSkillFiles(await readSkillDirectory(path.join(skillsDir, name)))).not.toBe(shipped);

        const result = await resetBuiltinSkill(name);

        expect(result.success).toBe(true);
        expect(result.skill?.modified).toBe(false);
        // Restoring means the directory holds our files and only our files, so the next
        // release can recognize it as untouched and update it again
        expect(hashSkillFiles(await readSkillDirectory(path.join(skillsDir, name)))).toBe(shipped);
        expect(await Bun.file(path.join(skillsDir, name, 'NOTES.md')).exists()).toBe(false);
    });

    test('a skill we never shipped cannot be reset', async () => {
        expect((await resetBuiltinSkill('user-own')).success).toBe(false);
    });
});
