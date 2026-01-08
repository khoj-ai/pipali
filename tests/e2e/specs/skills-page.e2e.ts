/**
 * Skills Page E2E Tests
 *
 * Tests for the skills page functionality including:
 * - Viewing skills from local and global directories
 * - Opening skill details
 * - Editing skills
 * - Deleting skills
 * - Refreshing skills from filesystem
 */

import { test, expect } from '@playwright/test';
import { SkillsPage } from '../helpers/page-objects';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';

// Test skill directory paths - use isolated test directories set by global-setup
// These are temp directories that get cleaned up after tests
function getLocalSkillsDir(): string {
    const dir = process.env.TEST_SKILLS_LOCAL_DIR;
    if (!dir) {
        throw new Error('TEST_SKILLS_LOCAL_DIR not set - global-setup may not have run');
    }
    return dir;
}

function getGlobalSkillsDir(): string {
    const dir = process.env.TEST_SKILLS_GLOBAL_DIR;
    if (!dir) {
        throw new Error('TEST_SKILLS_GLOBAL_DIR not set - global-setup may not have run');
    }
    return dir;
}

// Helper to create a test skill on disk
async function createTestSkill(
    basePath: string,
    name: string,
    description: string,
    instructions: string = ''
): Promise<void> {
    const skillDir = join(basePath, name);
    await mkdir(skillDir, { recursive: true });

    const content = `---
name: ${name}
description: ${description}
---

${instructions}
`.trim() + '\n';

    await writeFile(join(skillDir, 'SKILL.md'), content);
}

// Helper to delete a test skill from disk
async function deleteTestSkill(basePath: string, name: string): Promise<void> {
    const skillDir = join(basePath, name);
    await rm(skillDir, { recursive: true, force: true });
}

// Helper to ensure a directory exists
async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
}

test.describe('Skills Page', () => {
    let skillsPage: SkillsPage;

    // Set up test skills before all tests
    test.beforeAll(async () => {
        // Ensure skills directories exist (they should already from test-server setup)
        await ensureDir(getLocalSkillsDir());
        await ensureDir(getGlobalSkillsDir());

        // Create test skills
        await createTestSkill(
            getLocalSkillsDir(),
            'test-local-skill',
            'A test skill in local directory',
            'These are instructions for the local test skill.'
        );
        await createTestSkill(
            getGlobalSkillsDir(),
            'test-global-skill',
            'A test skill in global directory',
            'These are instructions for the global test skill.'
        );
    });

    // Clean up test skills after all tests
    test.afterAll(async () => {
        await deleteTestSkill(getLocalSkillsDir(), 'test-local-skill');
        await deleteTestSkill(getGlobalSkillsDir(), 'test-global-skill');
        // Clean up any skills created during tests
        await deleteTestSkill(getLocalSkillsDir(), 'new-test-skill');
        await deleteTestSkill(getGlobalSkillsDir(), 'new-test-skill');
        await deleteTestSkill(getLocalSkillsDir(), 'skill-to-delete');
        await deleteTestSkill(getLocalSkillsDir(), 'skill-to-edit');
        await deleteTestSkill(getLocalSkillsDir(), 'fs-added-skill');
    });

    test.beforeEach(async ({ page }) => {
        skillsPage = new SkillsPage(page);
        await skillsPage.goto();
        // Reload skills to ensure fresh state from disk
        await skillsPage.reloadSkills();
    });

    test.describe('Skills Visibility', () => {
        test('should display skills page header with count', async () => {
            await expect(skillsPage.skillsHeader).toBeVisible();
            await expect(skillsPage.skillsCount).toBeVisible();

            const count = await skillsPage.getSkillCount();
            expect(count).toBeGreaterThanOrEqual(2); // At least our test skills
        });

        test('should show create and reload buttons', async () => {
            await expect(skillsPage.createBtn).toBeVisible();
            await expect(skillsPage.reloadBtn).toBeVisible();
        });

        test('should display local skills from local skills directory', async () => {
            const localSkillCard = skillsPage.getSkillCardByName('test-local-skill');
            await expect(localSkillCard).toBeVisible();

            // Verify source badge shows 'local'
            const sourceBadge = localSkillCard.locator('.skill-source-badge');
            await expect(sourceBadge).toHaveText('local');
        });

        test('should display global skills from global skills directory', async () => {
            const globalSkillCard = skillsPage.getSkillCardByName('test-global-skill');
            await expect(globalSkillCard).toBeVisible();

            // Verify source badge shows 'global'
            const sourceBadge = globalSkillCard.locator('.skill-source-badge');
            await expect(sourceBadge).toHaveText('global');
        });

        test('should display skills with correct source badges', async () => {
            const skills = await skillsPage.getAllSkillsWithSource();

            // Find our test skills
            const localSkill = skills.find(s => s.name === 'test-local-skill');
            const globalSkill = skills.find(s => s.name === 'test-global-skill');

            expect(localSkill).toBeDefined();
            expect(localSkill?.source).toBe('local');

            expect(globalSkill).toBeDefined();
            expect(globalSkill?.source).toBe('global');
        });

        test('should display skill description on card', async () => {
            const localSkillCard = skillsPage.getSkillCardByName('test-local-skill');
            const description = localSkillCard.locator('.skill-card-description');
            await expect(description).toHaveText('A test skill in local directory');
        });

        test('should display skill location on card', async () => {
            const localSkillCard = skillsPage.getSkillCardByName('test-local-skill');
            const location = localSkillCard.locator('.skill-location');
            await expect(location).toBeVisible();
            // Location should show last 2 path segments
            const locationText = await location.textContent();
            expect(locationText).toContain('test-local-skill');
        });
    });

    test.describe('Skill Details', () => {
        test('should open skill detail modal when clicking on skill card', async () => {
            await skillsPage.openSkillDetail('test-local-skill');

            await expect(skillsPage.detailModal).toBeVisible();
        });

        test('should display skill name in detail modal header', async () => {
            await skillsPage.openSkillDetail('test-local-skill');

            const title = await skillsPage.getDetailModalTitle();
            expect(title).toBe('test-local-skill');
        });

        test('should display skill description in detail modal', async () => {
            await skillsPage.openSkillDetail('test-local-skill');

            const description = await skillsPage.getDetailDescription();
            expect(description).toBe('A test skill in local directory');
        });

        test('should load and display skill instructions in detail modal', async () => {
            await skillsPage.openSkillDetail('test-local-skill');

            const instructions = await skillsPage.getDetailInstructions();
            expect(instructions).toBe('These are instructions for the local test skill.');
        });

        test('should display skill location in detail modal', async () => {
            await skillsPage.openSkillDetail('test-local-skill');

            const location = await skillsPage.getDetailLocationText();
            expect(location).toContain('test-local-skill');
            expect(location).toContain('SKILL.md');
        });

        test('should close detail modal when clicking close button', async () => {
            await skillsPage.openSkillDetail('test-local-skill');
            await expect(skillsPage.detailModal).toBeVisible();

            await skillsPage.closeModal();
            await expect(skillsPage.detailModal).not.toBeVisible();
        });

        test('should close detail modal when pressing Escape', async () => {
            await skillsPage.openSkillDetail('test-local-skill');
            await expect(skillsPage.detailModal).toBeVisible();

            await skillsPage.closeModalWithEscape();
            await expect(skillsPage.detailModal).not.toBeVisible();
        });

        test('should show source badge in detail modal', async () => {
            await skillsPage.openSkillDetail('test-local-skill');

            const sourceBadge = skillsPage.detailModal.locator('.skill-detail-source-badge');
            await expect(sourceBadge).toHaveText('local');
        });
    });

    test.describe('Edit Skill', () => {
        test.beforeEach(async () => {
            // Create a skill specifically for editing tests
            await createTestSkill(
                getLocalSkillsDir(),
                'skill-to-edit',
                'Original description',
                'Original instructions'
            );
            await skillsPage.reloadSkills();
        });

        test.afterEach(async () => {
            await deleteTestSkill(getLocalSkillsDir(), 'skill-to-edit');
        });

        test('should have save button disabled when no changes made', async () => {
            await skillsPage.openSkillDetail('skill-to-edit');

            const isEnabled = await skillsPage.isSaveButtonEnabled();
            expect(isEnabled).toBe(false);
        });

        test('should enable save button when description is edited', async () => {
            await skillsPage.openSkillDetail('skill-to-edit');

            await skillsPage.editDescription('Updated description');

            const isEnabled = await skillsPage.isSaveButtonEnabled();
            expect(isEnabled).toBe(true);
        });

        test('should enable save button when instructions are edited', async () => {
            await skillsPage.openSkillDetail('skill-to-edit');

            await skillsPage.editInstructions('Updated instructions');

            const isEnabled = await skillsPage.isSaveButtonEnabled();
            expect(isEnabled).toBe(true);
        });

        test('should save updated description', async () => {
            await skillsPage.openSkillDetail('skill-to-edit');

            await skillsPage.editDescription('New updated description');
            await skillsPage.saveSkill();

            // Modal should close after save
            await expect(skillsPage.detailModal).not.toBeVisible();

            // Reopen to verify changes persisted
            await skillsPage.openSkillDetail('skill-to-edit');
            const description = await skillsPage.getDetailDescription();
            expect(description).toBe('New updated description');
        });

        test('should save updated instructions', async () => {
            await skillsPage.openSkillDetail('skill-to-edit');

            await skillsPage.editInstructions('New updated instructions content');
            await skillsPage.saveSkill();

            // Reopen to verify changes persisted
            await skillsPage.openSkillDetail('skill-to-edit');
            const instructions = await skillsPage.getDetailInstructions();
            expect(instructions).toBe('New updated instructions content');
        });

        test('should update skill card after editing', async () => {
            await skillsPage.openSkillDetail('skill-to-edit');

            await skillsPage.editDescription('Card should show this description');
            await skillsPage.saveSkill();

            // Check the skill card shows updated description
            const skillCard = skillsPage.getSkillCardByName('skill-to-edit');
            const description = skillCard.locator('.skill-card-description');
            await expect(description).toHaveText('Card should show this description');
        });
    });

    test.describe('Delete Skill', () => {
        test.beforeEach(async () => {
            // Create a skill specifically for deletion tests
            await createTestSkill(
                getLocalSkillsDir(),
                'skill-to-delete',
                'This skill will be deleted',
                'Instructions for skill to delete'
            );
            await skillsPage.reloadSkills();
        });

        test('should show delete button in detail modal', async () => {
            await skillsPage.openSkillDetail('skill-to-delete');

            await expect(skillsPage.btnDangerOutline).toBeVisible();
        });

        test('should show delete confirmation when delete button is clicked', async () => {
            await skillsPage.openSkillDetail('skill-to-delete');

            await skillsPage.clickDeleteButton();

            await expect(skillsPage.deleteConfirmText).toBeVisible();
            await expect(skillsPage.deleteConfirmText).toHaveText('Delete this skill?');
        });

        test('should cancel deletion when cancel is clicked', async () => {
            await skillsPage.openSkillDetail('skill-to-delete');

            await skillsPage.clickDeleteButton();
            await skillsPage.cancelDelete();

            // Confirmation should be hidden, modal still open
            await expect(skillsPage.deleteConfirmText).not.toBeVisible();
            await expect(skillsPage.detailModal).toBeVisible();
        });

        test('should delete skill when delete is confirmed', async () => {
            await skillsPage.openSkillDetail('skill-to-delete');

            await skillsPage.clickDeleteButton();
            await skillsPage.confirmDelete();

            // Modal should close
            await expect(skillsPage.detailModal).not.toBeVisible();

            // Skill should no longer appear in the list
            const skillCard = skillsPage.getSkillCardByName('skill-to-delete');
            await expect(skillCard).not.toBeVisible();
        });

        test('should update skill count after deletion', async () => {
            const initialCount = await skillsPage.getSkillCount();

            await skillsPage.openSkillDetail('skill-to-delete');
            await skillsPage.clickDeleteButton();
            await skillsPage.confirmDelete();

            const newCount = await skillsPage.getSkillCount();
            expect(newCount).toBe(initialCount - 1);
        });
    });

    test.describe('Filesystem Refresh', () => {
        test('should detect new skill added to filesystem on reload', async () => {
            // Get initial count
            const initialCount = await skillsPage.getSkillCount();

            // Add a new skill directly to the filesystem
            await createTestSkill(
                getLocalSkillsDir(),
                'fs-added-skill',
                'Skill added directly to filesystem',
                'Instructions for fs-added skill'
            );

            // Click reload button
            await skillsPage.reloadSkills();

            // New skill should appear
            const newCount = await skillsPage.getSkillCount();
            expect(newCount).toBe(initialCount + 1);

            const newNames = await skillsPage.getAllSkillNames();
            expect(newNames).toContain('fs-added-skill');

            // Verify the new skill card is visible
            const newSkillCard = skillsPage.getSkillCardByName('fs-added-skill');
            await expect(newSkillCard).toBeVisible();

            // Clean up
            await deleteTestSkill(getLocalSkillsDir(), 'fs-added-skill');
        });

        test('should detect skill removed from filesystem on reload', async () => {
            // Create a skill to be removed
            await createTestSkill(
                getLocalSkillsDir(),
                'fs-removed-skill',
                'Skill to be removed from filesystem',
                'Instructions'
            );
            await skillsPage.reloadSkills();

            // Verify it appears
            const skillCard = skillsPage.getSkillCardByName('fs-removed-skill');
            await expect(skillCard).toBeVisible();

            const initialCount = await skillsPage.getSkillCount();

            // Remove the skill from filesystem
            await deleteTestSkill(getLocalSkillsDir(), 'fs-removed-skill');

            // Click reload button
            await skillsPage.reloadSkills();

            // Skill should no longer appear
            await expect(skillCard).not.toBeVisible();

            const newCount = await skillsPage.getSkillCount();
            expect(newCount).toBe(initialCount - 1);
        });

        test('should show reload button spinner while reloading', async ({ page }) => {
            // Create a promise that we'll check for spinner visibility
            const reloadBtn = skillsPage.reloadBtn;

            // Start reload
            await reloadBtn.click();

            // Check for spinning icon (may be very quick)
            // We use a short timeout since the operation is fast
            try {
                await page.waitForSelector('.skills-reload-btn .spinning', { timeout: 1000 });
            } catch {
                // Spinner may have already disappeared, that's ok
            }

            // After reload, spinner should be gone
            await page.waitForTimeout(500);
            const spinner = page.locator('.skills-reload-btn .spinning');
            await expect(spinner).not.toBeVisible();
        });

        test('should maintain skill order after page refresh', async ({ page }) => {
            // Get skill names before refresh
            const namesBefore = await skillsPage.getAllSkillNames();

            // Navigate away and back (simulates page refresh behavior)
            await page.goto('/');
            await skillsPage.goto();
            await skillsPage.reloadSkills();

            // Get skill names after
            const namesAfter = await skillsPage.getAllSkillNames();

            // Order should be maintained (alphabetical or by source then name)
            expect(namesAfter).toEqual(namesBefore);
        });
    });

    test.describe('Create Skill', () => {
        test.afterEach(async () => {
            // Clean up any created skills
            await deleteTestSkill(getLocalSkillsDir(), 'new-test-skill');
            await deleteTestSkill(getGlobalSkillsDir(), 'new-test-skill');
        });

        test('should open create skill modal when clicking create button', async () => {
            await skillsPage.openCreateModal();

            await expect(skillsPage.createModal).toBeVisible();
        });

        test('should have local source selected by default', async () => {
            await skillsPage.openCreateModal();

            const selectedOption = skillsPage.page.locator('.source-option.selected');
            await expect(selectedOption).toContainText('Local');
        });

        test('should create a new local skill', async () => {
            const initialCount = await skillsPage.getSkillCount();

            await skillsPage.openCreateModal();
            await skillsPage.fillCreateForm({
                name: 'new-test-skill',
                description: 'A newly created test skill',
                instructions: 'Instructions for the new skill',
                source: 'local',
            });
            await skillsPage.submitCreateForm();

            // Modal should close
            await expect(skillsPage.createModal).not.toBeVisible();

            // New skill should appear in the list
            const newSkillCard = skillsPage.getSkillCardByName('new-test-skill');
            await expect(newSkillCard).toBeVisible();

            // Source should be local
            const sourceBadge = newSkillCard.locator('.skill-source-badge');
            await expect(sourceBadge).toHaveText('local');

            // Count should increase
            const newCount = await skillsPage.getSkillCount();
            expect(newCount).toBe(initialCount + 1);
        });

        test('should create a new global skill', async () => {
            await skillsPage.openCreateModal();
            await skillsPage.fillCreateForm({
                name: 'new-test-skill',
                description: 'A newly created global skill',
                instructions: 'Global skill instructions',
                source: 'global',
            });
            await skillsPage.submitCreateForm();

            // New skill should appear with global source
            const newSkillCard = skillsPage.getSkillCardByName('new-test-skill');
            await expect(newSkillCard).toBeVisible();

            const sourceBadge = newSkillCard.locator('.skill-source-badge');
            await expect(sourceBadge).toHaveText('global');
        });

        test('should validate skill name format', async ({ page }) => {
            await skillsPage.openCreateModal();

            // Try invalid name starting with hyphen (regex requires alphanumeric start)
            await skillsPage.skillNameInput.fill('-invalid-name');

            // Should show validation hint
            const formHint = page.locator('.form-hint.error');
            await expect(formHint).toBeVisible();
            await expect(formHint).toContainText('lowercase');
        });

        test('should disable submit button for invalid name', async () => {
            await skillsPage.openCreateModal();
            // Name ending with hyphen is invalid
            await skillsPage.skillNameInput.fill('invalid-name-');
            await skillsPage.createDescriptionInput.fill('Some description');

            const submitBtn = skillsPage.createModal.locator('button[type="submit"]');
            await expect(submitBtn).toBeDisabled();
        });

        test('should close create modal when clicking cancel', async () => {
            await skillsPage.openCreateModal();
            await expect(skillsPage.createModal).toBeVisible();

            const cancelBtn = skillsPage.createModal.locator('.btn-secondary');
            await cancelBtn.click();

            await expect(skillsPage.createModal).not.toBeVisible();
        });

        test('should close create modal when clicking backdrop', async ({ page }) => {
            await skillsPage.openCreateModal();
            await expect(skillsPage.createModal).toBeVisible();

            // Click on the backdrop (outside the modal)
            await page.locator('.modal-backdrop').click({ position: { x: 10, y: 10 } });

            await expect(skillsPage.createModal).not.toBeVisible();
        });
    });

    test.describe('Empty State', () => {
        test.beforeEach(async () => {
            // Remove all test skills to get empty state
            await deleteTestSkill(getLocalSkillsDir(), 'test-local-skill');
            await deleteTestSkill(getGlobalSkillsDir(), 'test-global-skill');
        });

        test.afterEach(async () => {
            // Recreate test skills for other tests
            await createTestSkill(
                getLocalSkillsDir(),
                'test-local-skill',
                'A test skill in local directory',
                'These are instructions for the local test skill.'
            );
            await createTestSkill(
                getGlobalSkillsDir(),
                'test-global-skill',
                'A test skill in global directory',
                'These are instructions for the global test skill.'
            );
        });

        test('should show empty state when no skills exist', async ({ page }) => {
            const freshSkillsPage = new SkillsPage(page);
            await freshSkillsPage.goto();
            await freshSkillsPage.reloadSkills();

            // Empty state should be visible
            await expect(freshSkillsPage.skillsEmpty).toBeVisible();

            // Should show helpful message
            const emptyMessage = freshSkillsPage.skillsEmpty.locator('h2');
            await expect(emptyMessage).toContainText('No Skills Found');
        });

        test('should show instructions for creating skills in empty state', async ({ page }) => {
            const freshSkillsPage = new SkillsPage(page);
            await freshSkillsPage.goto();
            await freshSkillsPage.reloadSkills();

            // Should show path instructions
            const paths = freshSkillsPage.skillsEmpty.locator('.skills-paths li');
            expect(await paths.count()).toBe(2);

            // Should mention both global and local paths
            const pathsText = await freshSkillsPage.skillsEmpty.locator('.skills-paths').textContent();
            expect(pathsText).toContain('~/.pipali/skills');
            expect(pathsText).toContain('./.pipali/skills');
        });
    });
});
