/**
 * Automations Page E2E Tests
 *
 * Tests for the automations page functionality including:
 * - Viewing all existing automations
 * - Opening automation details
 * - Editing automations (description, schedule)
 * - Deleting automations
 * - Scheduled automation triggering
 * - Notification for automation permission confirmation
 */

import { test, expect } from '@playwright/test';
import { AutomationsPage, ChatPage, HomePage } from '../helpers/page-objects';
import { Selectors } from '../helpers/selectors';

test.describe('Automations Page', () => {
    let automationsPage: AutomationsPage;
    const testAutomationIds: string[] = [];

    // Clean up test automations after each test
    test.afterEach(async () => {
        for (const id of testAutomationIds) {
            try {
                await automationsPage.deleteAutomationViaAPI(id);
            } catch {
                // Ignore cleanup errors
            }
        }
        testAutomationIds.length = 0;
    });

    test.beforeEach(async ({ page }) => {
        automationsPage = new AutomationsPage(page);
    });

    test.describe('Automations Visibility', () => {
        test('should display automations page header with count', async () => {
            // Create a test automation
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Test Visibility Automation',
                prompt: 'Test prompt for visibility',
                description: 'A test automation for visibility',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();

            await expect(automationsPage.automationsHeader).toBeVisible();
            await expect(automationsPage.automationsCount).toBeVisible();

            const count = await automationsPage.getAutomationCount();
            expect(count).toBeGreaterThanOrEqual(1);
        });

        test('should show create and reload buttons', async () => {
            await automationsPage.goto();

            await expect(automationsPage.createBtn).toBeVisible();
            await expect(automationsPage.reloadBtn).toBeVisible();
        });

        test('should display all existing automations', async () => {
            // Create multiple test automations
            const automation1Id = await automationsPage.createAutomationViaAPI({
                name: 'First Test Automation',
                prompt: 'First test prompt',
            });
            testAutomationIds.push(automation1Id);

            const automation2Id = await automationsPage.createAutomationViaAPI({
                name: 'Second Test Automation',
                prompt: 'Second test prompt',
            });
            testAutomationIds.push(automation2Id);

            await automationsPage.goto();

            // Both automations should be visible
            const card1 = automationsPage.getAutomationCardByName('First Test Automation');
            const card2 = automationsPage.getAutomationCardByName('Second Test Automation');

            await expect(card1).toBeVisible();
            await expect(card2).toBeVisible();

            // Count should reflect both automations
            const count = await automationsPage.getAutomationCount();
            expect(count).toBeGreaterThanOrEqual(2);
        });

        test('should display automation with active toggle', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Status Toggle Test',
                prompt: 'Test prompt for status',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();

            const automationCard = automationsPage.getAutomationCardByName('Status Toggle Test');
            await expect(automationCard).toBeVisible();

            // New automations are active by default
            const statusToggle = automationCard.locator(Selectors.automationToggleBtn);
            await expect(statusToggle).toHaveAttribute('aria-checked', 'true');
            await expect(automationCard).not.toHaveClass(/paused/);
        });

        test('should display schedule information on automation card', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Schedule Display Test',
                prompt: 'Test prompt for schedule',
                schedule: '0 14 * * *', // Daily at 2 PM
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();

            const automationCard = automationsPage.getAutomationCardByName('Schedule Display Test');
            await expect(automationCard).toBeVisible();
            const scheduleEl = automationCard.locator(Selectors.automationSchedule);
            await expect(scheduleEl).toBeVisible();

            const scheduleText = await scheduleEl.textContent();
            expect(scheduleText?.toLowerCase()).toContain('daily');
        });

        test('should display prompt on automation card', async () => {
            const testPrompt = 'This is a unique test prompt for display';
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Prompt Display Test',
                prompt: testPrompt,
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();

            const automationCard = automationsPage.getAutomationCardByPrompt(testPrompt);
            await expect(automationCard).toBeVisible();
        });

        test('should show empty state when no automations exist', async ({ page }) => {
            const freshPage = new AutomationsPage(page);
            await freshPage.goto();

            // If there are no automations, empty state should be visible
            const count = await freshPage.getAutomationCount();
            if (count === 0) {
                await expect(freshPage.automationsEmpty).toBeVisible();
            }
        });
    });

    test.describe('Automation Details', () => {
        test('should open automation detail modal when clicking on card', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Detail Modal Test',
                prompt: 'Test prompt for detail modal',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Detail Modal Test');

            await expect(automationsPage.detailModal).toBeVisible();
        });

        test('should display automation name in detail modal header', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Name Display Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Name Display Test');

            const title = await automationsPage.getDetailModalTitle();
            expect(title).toBe('Name Display Test');
        });

        test('should display automation instructions in detail modal', async () => {
            const testPrompt = 'These are the test instructions for automation';
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Instructions Display Test',
                prompt: testPrompt,
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Instructions Display Test');

            const instructions = await automationsPage.getDetailInstructions();
            expect(instructions).toBe(testPrompt);
        });

        test('should display schedule in detail modal', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Schedule Detail Test',
                prompt: 'Test prompt',
                schedule: '30 9 * * 1', // Mondays at 9:30 AM
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Schedule Detail Test');

            const schedule = await automationsPage.getDetailScheduleText();
            expect(schedule.toLowerCase()).toContain('monday');
        });

        test('should display status badge in detail modal', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Status Detail Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Status Detail Test');

            const status = await automationsPage.getDetailStatus();
            expect(status).toBe('active');
        });

        test('should close detail modal when clicking close button', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Close Button Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Close Button Test');
            await expect(automationsPage.detailModal).toBeVisible();

            await automationsPage.closeModal();
            await expect(automationsPage.detailModal).not.toBeVisible();
        });

        test('should close detail modal when pressing Escape', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Escape Key Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Escape Key Test');
            await expect(automationsPage.detailModal).toBeVisible();

            await automationsPage.closeModalWithEscape();
            await expect(automationsPage.detailModal).not.toBeVisible();
        });
    });

    test.describe('Edit Automation', () => {
        test('should show edit button in detail modal for cron automations', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Edit Button Test',
                prompt: 'Original prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Edit Button Test');

            const editBtn = automationsPage.detailModal.locator('button:has-text("Edit")');
            await expect(editBtn).toBeVisible();
        });

        test('should enter edit mode when clicking edit button', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Edit Mode Test',
                prompt: 'Original prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Edit Mode Test');
            await automationsPage.clickEditButton();

            // Should show instructions textarea in edit mode
            await expect(automationsPage.detailInstructionsInput).toBeVisible();

            // Should show frequency selector
            const frequencySelector = automationsPage.page.locator(Selectors.frequencySelector);
            await expect(frequencySelector).toBeVisible();
        });

        test('should save updated instructions', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Update Instructions Test',
                prompt: 'Original instructions',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Update Instructions Test');
            await automationsPage.clickEditButton();

            const newInstructions = 'These are the updated instructions';
            await automationsPage.editInstructions(newInstructions);
            await automationsPage.saveAutomation();

            // Modal should close
            await expect(automationsPage.detailModal).not.toBeVisible();

            // Reopen to verify changes persisted
            // Note: The name is now auto-generated from the prompt
            await automationsPage.reloadAutomations();
            const updatedCard = automationsPage.getAutomationCardByPrompt(newInstructions);
            await expect(updatedCard).toBeVisible();
        });

        test('should update schedule when frequency is changed', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Update Schedule Test',
                prompt: 'Test prompt for schedule update',
                schedule: '0 12 * * *', // Daily at noon
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Update Schedule Test');
            await automationsPage.clickEditButton();

            // Change frequency to weekly
            await automationsPage.selectFrequency('Week');

            // Select a day
            await automationsPage.selectDayOfWeek('Friday');

            await automationsPage.saveAutomation();

            // Modal should close
            await expect(automationsPage.detailModal).not.toBeVisible();

            // Reload and verify schedule changed
            await automationsPage.reloadAutomations();
            const updatedCard = automationsPage.getAutomationCardByPrompt('Test prompt for schedule update');
            await expect(updatedCard).toBeVisible();
            const scheduleEl = updatedCard.locator(Selectors.automationSchedule);
            const scheduleText = await scheduleEl.textContent();
            expect(scheduleText?.toLowerCase()).toContain('friday');
        });

        test('editing the schedule keeps the routine timezone', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Timezone Edit Test',
                prompt: 'Test prompt for timezone edit',
                schedule: '0 9 * * *',
                timezone: 'Asia/Tokyo',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Timezone Edit Test');
            await automationsPage.clickEditButton();
            await automationsPage.selectTime('10:00 AM');
            await automationsPage.saveAutomation();

            const response = await page.request.get(`/api/automations/${automationId}`);
            const { automation } = await response.json();
            expect(automation.triggerConfig).toEqual({ type: 'cron', schedule: '0 10 * * *', timezone: 'Asia/Tokyo' });
        });

        test('a weekday routine reads as weekdays and keeps its days through edits', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Weekday Schedule Test',
                prompt: 'Test prompt for a weekday schedule',
                schedule: '0 9 * * 1-5',
            });
            testAutomationIds.push(automationId);
            const schedule = async () => (await (await page.request.get(`/api/automations/${automationId}`)).json()).automation.triggerConfig.schedule;

            await automationsPage.goto();
            const card = automationsPage.getAutomationCardByName('Weekday Schedule Test');
            await expect(card.locator(Selectors.automationSchedule)).toHaveText('Weekdays at 9:00 AM');

            await automationsPage.openAutomationDetail('Weekday Schedule Test');
            await automationsPage.clickEditButton();
            await expect(automationsPage.detailModal.locator(`${Selectors.dayToggle}.active`)).toHaveCount(5);
            await automationsPage.editInstructions('Edited prompt for a weekday schedule');
            await automationsPage.saveAutomation();
            expect(await schedule()).toBe('0 9 * * 1-5');

            await automationsPage.openAutomationDetail('Weekday Schedule Test');
            await automationsPage.clickEditButton();
            await automationsPage.selectTime('10:00 AM');
            await automationsPage.saveAutomation();
            expect(await schedule()).toBe('0 10 * * 1,2,3,4,5');
            await automationsPage.reloadAutomations();
            await expect(card.locator(Selectors.automationSchedule)).toHaveText('Weekdays at 10:00 AM');
        });

        test('a schedule beyond the form reads in plain words and survives an edit', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Twice Daily Test',
                prompt: 'Test prompt for a twice daily schedule',
                schedule: '30 8,16 * * 1-5',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            const card = automationsPage.getAutomationCardByName('Twice Daily Test');
            await expect(card.locator(Selectors.automationSchedule)).toHaveText('At 08:30 AM and 04:30 PM, Monday through Friday');

            await automationsPage.openAutomationDetail('Twice Daily Test');
            await expect(automationsPage.detailNextRun).toContainText('Next runs:');
            await automationsPage.clickEditButton();
            await expect(automationsPage.detailModal.locator('.custom-schedule-description')).toHaveText('At 08:30 AM and 04:30 PM, Monday through Friday');
            await automationsPage.editInstructions('Edited prompt for a twice daily schedule');
            await automationsPage.saveAutomation();

            const response = await page.request.get(`/api/automations/${automationId}`);
            const { automation } = await response.json();
            expect(automation.prompt).toBe('Edited prompt for a twice daily schedule');
            expect(automation.triggerConfig.schedule).toBe('30 8,16 * * 1-5');
        });

        test('a schedule beyond the form can be replaced with one set here', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Replace Schedule Test',
                prompt: 'Test prompt for replacing a schedule',
                schedule: '*/15 * * * *',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Replace Schedule Test');
            await automationsPage.clickEditButton();
            await automationsPage.detailModal.locator('.custom-schedule-replace').click();
            await automationsPage.selectFrequency('Week');
            await automationsPage.selectDayOfWeek('Friday');
            await automationsPage.saveAutomation();

            const response = await page.request.get(`/api/automations/${automationId}`);
            expect((await response.json()).automation.triggerConfig.schedule).toBe('0 12 * * 1,5');
        });

        test('asking Pipali to change a schedule drafts a new chat about the routine', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Ask Pipali Test',
                prompt: 'Test prompt for asking Pipali',
                schedule: '0 9 * * 1#1',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Ask Pipali Test');
            await automationsPage.clickEditButton();
            await automationsPage.detailModal.locator('.custom-schedule-ask').click();

            await expect(automationsPage.detailModal).toBeHidden();
            await expect(page.locator(Selectors.inputTextarea)).toHaveValue('Change the schedule of my routine "Ask Pipali Test" to ');
            await expect(page.locator(Selectors.inputTextarea)).toBeFocused();
        });

        test('should cancel edit mode and discard changes', async () => {
            const originalPrompt = 'Original prompt that should not change';
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Cancel Edit Test',
                prompt: originalPrompt,
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Cancel Edit Test');
            await automationsPage.clickEditButton();

            // Make changes
            await automationsPage.editInstructions('This change should be discarded');

            // Cancel by pressing Escape
            await automationsPage.page.keyboard.press('Escape');

            // Should exit edit mode without closing modal (first escape exits edit mode)
            await expect(automationsPage.detailModal).toBeVisible();

            // Original instructions should be preserved
            const instructions = await automationsPage.getDetailInstructions();
            expect(instructions).toBe(originalPrompt);
        });
    });

    test.describe('Delete Automation', () => {
        test('should show delete button in detail modal', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Delete Button Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Delete Button Test');

            await expect(automationsPage.btnDangerOutline).toBeVisible();
        });

        test('should show delete confirmation when delete button is clicked', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Delete Confirm Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Delete Confirm Test');

            await automationsPage.clickDeleteButton();

            await expect(automationsPage.deleteConfirmText).toBeVisible();
            await expect(automationsPage.deleteConfirmText).toHaveText('Delete this routine?');
        });

        test('should cancel deletion when cancel is clicked', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Cancel Delete Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Cancel Delete Test');

            await automationsPage.clickDeleteButton();
            await automationsPage.cancelDelete();

            // Confirmation should be hidden, modal still open
            await expect(automationsPage.deleteConfirmText).not.toBeVisible();
            await expect(automationsPage.detailModal).toBeVisible();
        });

        test('should delete automation when delete is confirmed', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Confirm Delete Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Confirm Delete Test');

            await automationsPage.clickDeleteButton();
            await automationsPage.confirmDelete();

            // Modal should close
            await expect(automationsPage.detailModal).not.toBeVisible();

            // Automation should no longer appear in the list
            const automationCard = automationsPage.getAutomationCardByName('Confirm Delete Test');
            await expect(automationCard).not.toBeVisible();

            // Remove from cleanup list since it's already deleted
            const idx = testAutomationIds.indexOf(automationId);
            if (idx > -1) testAutomationIds.splice(idx, 1);
        });

        test('should update automation count after deletion', async () => {
            const automation1Id = await automationsPage.createAutomationViaAPI({
                name: 'Count Test Automation 1',
                prompt: 'First prompt',
            });
            testAutomationIds.push(automation1Id);

            const automation2Id = await automationsPage.createAutomationViaAPI({
                name: 'Count Test Automation 2',
                prompt: 'Second prompt',
            });
            testAutomationIds.push(automation2Id);

            await automationsPage.goto();

            const initialCount = await automationsPage.getAutomationCount();

            await automationsPage.openAutomationDetail('Count Test Automation 2');
            await automationsPage.clickDeleteButton();
            await automationsPage.confirmDelete();

            const newCount = await automationsPage.getAutomationCount();
            expect(newCount).toBe(initialCount - 1);

            // Remove from cleanup list
            const idx = testAutomationIds.indexOf(automation2Id);
            if (idx > -1) testAutomationIds.splice(idx, 1);
        });
    });

    test.describe('Automation Status Toggle', () => {
        test('should pause active automation', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Pause Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();

            // Should be active initially
            const card = automationsPage.getAutomationCardByName('Pause Test');
            const toggle = card.locator(Selectors.automationToggleBtn);
            await expect(toggle).toHaveAttribute('aria-checked', 'true');
            await expect(card).not.toHaveClass(/paused/);

            // Pause it from the card without opening details.
            const pauseResponsePromise = automationsPage.page.waitForResponse((response) =>
                response.url().includes(`/api/automations/${automationId}/pause`) && response.request().method() === 'POST'
            );
            await automationsPage.pauseAutomation('Pause Test');
            const pauseResponse = await pauseResponsePromise;
            expect(pauseResponse.ok()).toBe(true);
            await expect(automationsPage.detailModal).not.toBeVisible();

            await automationsPage.reloadAutomations();
            await expect(toggle).toHaveAttribute('aria-checked', 'false');
            await expect(card).toHaveClass(/paused/);
        });

        test('should resume paused automation', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Resume Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            // Pause it via API first
            await automationsPage.page.request.post(`/api/automations/${automationId}/pause`);

            await automationsPage.goto();

            // Resume it from the card without opening details.
            const resumeResponsePromise = automationsPage.page.waitForResponse((response) =>
                response.url().includes(`/api/automations/${automationId}/resume`) && response.request().method() === 'POST'
            );
            await automationsPage.resumeAutomation('Resume Test');
            const resumeResponse = await resumeResponsePromise;
            expect(resumeResponse.ok()).toBe(true);
            await expect(automationsPage.detailModal).not.toBeVisible();

            await automationsPage.reloadAutomations();
            const card = automationsPage.getAutomationCardByName('Resume Test');
            const toggle = card.locator(Selectors.automationToggleBtn);
            await expect(toggle).toHaveAttribute('aria-checked', 'true');
            await expect(card).not.toHaveClass(/paused/);
        });

        test('should show an error and revert when status update fails', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Toggle Failure Test',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.page.route(`**/api/automations/${automationId}/pause`, async (route) => {
                await route.fulfill({
                    status: 500,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'Cannot pause right now' }),
                });
            });

            const card = automationsPage.getAutomationCardByName('Toggle Failure Test');
            const toggle = card.locator(Selectors.automationToggleBtn);
            await expect(toggle).toHaveAttribute('aria-checked', 'true');

            await automationsPage.pauseAutomation('Toggle Failure Test');

            await expect(automationsPage.page.locator('.automations-status-error')).toHaveText('Cannot pause right now');
            await expect(toggle).toHaveAttribute('aria-checked', 'true');
            await expect(card).not.toHaveClass(/paused/);
        });
    });

    test.describe('Scheduled Automation Trigger', () => {
        test('should trigger automation manually via API', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Manual Trigger Test',
                prompt: 'Say hello',
            });
            testAutomationIds.push(automationId);

            // Trigger the automation
            const executionId = await automationsPage.triggerAutomationViaAPI(automationId);
            expect(executionId).toBeTruthy();
        });

        test('waits for a run already going in its conversation to finish', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Busy Conversation Test',
                prompt: 'Say hello',
            });
            testAutomationIds.push(automationId);

            const completes = (executionId: string | null) => expect.poll(async () => {
                const response = await page.request.get(`/api/automations/executions/${executionId}`);
                return (await response.json()).execution?.status;
            }, { timeout: 30000 }).toBe('completed');

            // A first run gives the routine its conversation
            await completes(await automationsPage.triggerAutomationViaAPI(automationId));
            const { automation } = await (await page.request.get(`/api/automations/${automationId}`)).json();

            // The user follows up there, and the routine fires while that run awaits approval
            const chatPage = new ChatPage(page);
            await chatPage.gotoConversation(automation.conversationId);
            await chatPage.sendMessage('work through a long step');
            await chatPage.waitForConfirmationDialog();
            const executionId = await automationsPage.triggerAutomationViaAPI(automationId);
            await chatPage.clickConfirmationButton('yes');

            // The user's run finishes in view, and only then does the routine's begin
            await expect(page.locator(Selectors.assistantMessage).filter({ hasText: 'The long step is done.' }))
                .toBeVisible({ timeout: 20000 });
            await completes(executionId);
            const { history } = await (await page.request.get(`/api/chat/${automation.conversationId}/history`)).json() as {
                history: Array<{ message?: string }>;
            };
            const messages = history.map(step => step.message ?? '');
            expect(messages.findLastIndex(message => message.includes('Say hello')))
                .toBeGreaterThan(messages.indexOf('The long step is done.'));
        });

        test('should display next run time for scheduled automations', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Next Run Display Test',
                prompt: 'Test prompt',
                schedule: '0 12 * * *', // Daily at noon
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();

            const card = automationsPage.getAutomationCardByName('Next Run Display Test');
            const nextRun = card.locator(Selectors.automationNextRun);

            // Next run should be visible for active automations
            await expect(nextRun).toBeVisible();
        });

        test('should show next run in detail modal', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Next Run Detail Test',
                prompt: 'Test prompt',
                schedule: '0 12 * * *',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Next Run Detail Test');

            const nextRun = await automationsPage.getDetailNextRunText();
            expect(nextRun).toBeTruthy();
            expect(nextRun.toLowerCase()).toContain('next run');
        });
    });

    test.describe('Routine Start Date', () => {
        const START_DATE = '2099-03-14';

        type ListedAutomation = {
            id: string;
            prompt: string;
            triggerConfig: { startDate?: string };
            nextScheduledAt?: string;
        };

        async function findAutomation(page: import('@playwright/test').Page, prompt: string) {
            const response = await page.request.get('/api/automations');
            const { automations } = await response.json() as { automations: ListedAutomation[] };
            return automations.find(a => a.prompt === prompt);
        }

        test('a routine set up now first runs on its start date', async ({ page }) => {
            const prompt = 'Draft the quarterly review';
            await automationsPage.goto();
            await automationsPage.createBtn.click();

            const createModal = page.locator(Selectors.createAutomationModal);
            await createModal.locator('.instructions-textarea').fill(prompt);
            await createModal.locator('.schedule-toggle').click();
            await createModal.locator('.start-date-input').fill(START_DATE);
            await createModal.locator('button[type="submit"]').click();
            await expect(createModal).toBeHidden({ timeout: 5000 });

            const created = await findAutomation(page, prompt);
            expect(created).toBeDefined();
            testAutomationIds.push(created!.id);
            expect(created!.triggerConfig.startDate).toBe(START_DATE);

            // The create modal defaults to every day at noon.
            await expect.poll(async () => (await findAutomation(page, prompt))?.nextScheduledAt)
                .toBe(new Date(`${START_DATE}T12:00`).toISOString());

            await automationsPage.openAutomationDetailByPrompt(prompt);
            await expect(automationsPage.detailModal.locator('.automation-detail-start-date')).toContainText('2099');
        });

        test('clearing the start date lets the routine run right away', async ({ page }) => {
            const prompt = 'Test prompt for clearing start date';
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Clear Start Date Test',
                prompt,
                startDate: START_DATE,
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Clear Start Date Test');
            await automationsPage.clickEditButton();
            await automationsPage.detailModal.locator('.start-date-clear').click();
            await automationsPage.saveAutomation();

            expect((await findAutomation(page, prompt))?.triggerConfig.startDate).toBeUndefined();
            await expect.poll(async () => {
                const nextRun = (await findAutomation(page, prompt))?.nextScheduledAt;
                return nextRun ? new Date(nextRun).getTime() - Date.now() : Infinity;
            }).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

            await automationsPage.openAutomationDetail('Clear Start Date Test');
            await expect(automationsPage.detailModal.locator('.automation-detail-start-date')).toHaveCount(0);
        });
    });

    test.describe('Automation Confirmation Notifications', () => {
        /**
         * These tests verify that automations requiring user confirmation display
         * the appropriate UI elements on the automations page, home page, and in toasts.
         *
         * The tests create an automation with a prompt that triggers a shell_command tool,
         * which requires user confirmation before execution.
         */

        test('should show awaiting confirmation badge on automation card', async () => {
            // Create an automation that triggers a shell command (which requires confirmation)
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Confirmation Badge Test',
                prompt: 'Run a shell command to list files',
            });
            testAutomationIds.push(automationId);

            // Trigger the automation
            await automationsPage.triggerAutomationViaAPI(automationId);

            // Wait for confirmation to be generated (poll with timeout)
            const confirmation = await automationsPage.waitForPendingConfirmation(automationId, {
                timeout: 15000,
            });

            // Confirmation must exist for this test
            expect(confirmation).not.toBeNull();

            await automationsPage.goto();
            await automationsPage.reloadAutomations();

            // Card should show awaiting confirmation
            const awaitingCards = automationsPage.getAutomationCardsAwaitingConfirmation();
            const count = await awaitingCards.count();
            expect(count).toBeGreaterThanOrEqual(1);
        });

        test('should show confirmation section in detail modal when pending', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Confirmation Section Test',
                prompt: 'Run a shell command to list files',
            });
            testAutomationIds.push(automationId);

            // Trigger the automation
            await automationsPage.triggerAutomationViaAPI(automationId);

            // Wait for confirmation to be generated
            const confirmation = await automationsPage.waitForPendingConfirmation(automationId, {
                timeout: 15000,
            });

            // Confirmation must exist for this test
            expect(confirmation).not.toBeNull();

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Confirmation Section Test');

            // Confirmation section should be visible
            const isVisible = await automationsPage.isConfirmationSectionVisible();
            expect(isVisible).toBe(true);
        });

        test('should show automation confirmation toast on automations page', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Toast Test Automation',
                prompt: 'Run a shell command to list files',
            });
            testAutomationIds.push(automationId);

            // Trigger the automation
            await automationsPage.triggerAutomationViaAPI(automationId);

            // Wait for confirmation to be generated
            const confirmation = await automationsPage.waitForPendingConfirmation(automationId, {
                timeout: 15000,
            });

            // Confirmation must exist for this test
            expect(confirmation).not.toBeNull();

            await automationsPage.goto();

            // Toast container should appear for automation confirmations
            const toastContainer = page.locator(Selectors.toastContainer);
            await expect(toastContainer).toBeVisible({ timeout: 5000 });

            // Should have automation-specific toast
            const automationToasts = page.locator(Selectors.toastAutomation);
            const toastCount = await automationToasts.count();
            expect(toastCount).toBeGreaterThanOrEqual(1);

            // Toast should show automation source
            const automationSource = page.locator(Selectors.automationSource);
            await expect(automationSource).toBeVisible();
            const sourceText = await automationSource.textContent();
            expect(sourceText).toContain('Toast Test Automation');
        });

        test('should show automation confirmation toast on home page', async ({ page }) => {
            const homePage = new HomePage(page);
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Home Toast Test',
                prompt: 'Run a shell command to list files',
            });
            testAutomationIds.push(automationId);

            // Trigger the automation
            await automationsPage.triggerAutomationViaAPI(automationId);

            // Wait for confirmation to be generated
            const confirmation = await automationsPage.waitForPendingConfirmation(automationId, {
                timeout: 15000,
            });

            // Confirmation must exist for this test
            expect(confirmation).not.toBeNull();

            await homePage.goto();

            // Toast container should appear on home page too
            const toastContainer = page.locator(Selectors.toastContainer);
            await expect(toastContainer).toBeVisible({ timeout: 5000 });

            // Should have automation-specific toast
            const automationToasts = page.locator(Selectors.toastAutomation);
            const toastCount = await automationToasts.count();
            expect(toastCount).toBeGreaterThanOrEqual(1);
        });

        test('should respond to confirmation from detail modal', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Respond Confirmation Test',
                prompt: 'Run a shell command to list files',
            });
            testAutomationIds.push(automationId);

            // Trigger the automation
            await automationsPage.triggerAutomationViaAPI(automationId);

            // Wait for confirmation to be generated
            const confirmation = await automationsPage.waitForPendingConfirmation(automationId, {
                timeout: 15000,
            });

            // Confirmation must exist for this test
            expect(confirmation).not.toBeNull();

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Respond Confirmation Test');

            // Confirmation section should be visible
            const isVisible = await automationsPage.isConfirmationSectionVisible();
            expect(isVisible).toBe(true);

            // Get confirmation buttons
            const confirmBtns = automationsPage.confirmationActions.locator('button');
            const btnCount = await confirmBtns.count();
            expect(btnCount).toBeGreaterThan(0);

            // Click the first button (usually "Yes" or "Allow")
            await confirmBtns.first().click();

            // Wait for response to be processed
            await page.waitForTimeout(1000);

            // Confirmation section should be gone or modal closed
            // After responding, the section should update
            const stillVisible = await automationsPage.isConfirmationSectionVisible();
            expect(stillVisible).toBe(false);
        });

        test('should show needs approval badge on automation card when confirmation pending', async () => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Needs Approval Badge Test',
                prompt: 'Run a shell command to list files',
            });
            testAutomationIds.push(automationId);

            // Trigger the automation
            await automationsPage.triggerAutomationViaAPI(automationId);

            // Wait for confirmation to be generated
            const confirmation = await automationsPage.waitForPendingConfirmation(automationId, {
                timeout: 15000,
            });

            // Confirmation must exist for this test
            expect(confirmation).not.toBeNull();

            await automationsPage.goto();
            await automationsPage.reloadAutomations();

            // Find the automation card
            const card = automationsPage.getAutomationCardByName('Needs Approval Badge Test');
            await expect(card).toBeVisible();

            // The status badge should show "needs approval"
            const statusBadge = card.locator(Selectors.automationStatusBadge);
            const badgeText = await statusBadge.textContent();
            expect(badgeText?.toLowerCase()).toContain('approval');
        });
    });

    test.describe('Refresh Automations', () => {
        test('should refresh automations list when reload button is clicked', async () => {
            await automationsPage.goto();

            const initialCount = await automationsPage.getAutomationCount();

            // Create a new automation while on the page
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Refresh Test Automation',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            // Reload
            await automationsPage.reloadAutomations();

            // Count should increase
            const newCount = await automationsPage.getAutomationCount();
            expect(newCount).toBe(initialCount + 1);

            // New automation should be visible
            const card = automationsPage.getAutomationCardByName('Refresh Test Automation');
            await expect(card).toBeVisible();
        });
    });
    test.describe('Automation Model', () => {
        /** Models come from configured providers, so an unconfigured environment has none. */
        async function availableModels(page: import('@playwright/test').Page) {
            const response = await page.request.get('/api/models');
            return response.ok() ? (await response.json()).models as { id: number; name: string; friendlyName?: string }[] : [];
        }

        async function readAutomation(page: import('@playwright/test').Page, id: string) {
            const response = await page.request.get(`/api/automations/${id}`);
            expect(response.ok()).toBe(true);
            return (await response.json()).automation as { chatModelId: number | null; conversationId: string | null };
        }

        test('a routine follows the default model until one is chosen', async ({ page }) => {
            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Default Model Routine',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            expect((await readAutomation(page, automationId)).chatModelId).toBeNull();

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Default Model Routine');

            // Says so, rather than leaving the question to the chat model picker.
            await expect(automationsPage.detailModal.locator('.automation-detail-model')).toContainText('My default model');
        });

        test('choosing a model pins the routine to it', async ({ page }) => {
            const models = await availableModels(page);
            test.skip(models.length === 0, 'no chat models configured in this environment');
            const model = models[0]!;
            const label = model.friendlyName || model.name;

            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Pinned Model Routine',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Pinned Model Routine');
            await automationsPage.clickEditButton();
            await automationsPage.detailModal.locator('.automation-model-select').selectOption({ label });
            await automationsPage.saveAutomation();

            expect((await readAutomation(page, automationId)).chatModelId).toBe(model.id);

            await automationsPage.openAutomationDetail('Pinned Model Routine');
            await expect(automationsPage.detailModal.locator('.automation-detail-model')).toHaveText(label);
        });

        test('a routine can be created on a chosen model', async ({ page }) => {
            const models = await availableModels(page);
            test.skip(models.length === 0, 'no chat models configured in this environment');
            const model = models[0]!;

            await automationsPage.goto();
            await automationsPage.createBtn.click();

            const createModal = page.locator(Selectors.createAutomationModal);
            await expect(createModal).toBeVisible();
            await createModal.locator('.instructions-textarea').fill('Summarise the release notes each morning');
            await createModal.locator('.automation-model-select').selectOption({ label: model.friendlyName || model.name });
            await createModal.locator('button[type="submit"]').click();
            await expect(createModal).toBeHidden({ timeout: 5000 });

            const listed = await page.request.get('/api/automations');
            const { automations } = await listed.json();
            const created = automations.find((a: { prompt: string }) => a.prompt.includes('Summarise the release notes'));
            expect(created).toBeDefined();
            testAutomationIds.push(created.id);
            expect(created.chatModelId).toBe(model.id);
        });

        /** Triggering is what gives a routine its conversation. */
        async function triggerAndGetConversation(page: import('@playwright/test').Page, automationId: string) {
            const response = await page.request.post(`/api/automations/${automationId}/trigger`);
            expect(response.ok()).toBe(true);
            const { conversationId } = await response.json();
            expect(conversationId).toBeTruthy();
            return conversationId as string;
        }

        async function conversationModel(page: import('@playwright/test').Page, conversationId: string) {
            const response = await page.request.get(`/api/chat/${conversationId}/history`);
            expect(response.ok()).toBe(true);
            return (await response.json()).chatModelId as number | null;
        }

        test("setting a routine's model moves its conversation's picker with it", async ({ page }) => {
            const models = await availableModels(page);
            test.skip(models.length < 2, 'needs two chat models to tell them apart');

            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Mirrored Model Routine',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);
            const conversationId = await triggerAndGetConversation(page, automationId);

            await page.request.put(`/api/automations/${automationId}`, { data: { chatModelId: models[0]!.id } });
            expect(await conversationModel(page, conversationId)).toBe(models[0]!.id);

            await page.request.put(`/api/automations/${automationId}`, { data: { chatModelId: models[1]!.id } });
            expect(await conversationModel(page, conversationId)).toBe(models[1]!.id);

            // Back to the default, which the conversation follows the same way the routine does.
            await page.request.put(`/api/automations/${automationId}`, { data: { chatModelId: null } });
            expect(await conversationModel(page, conversationId)).toBeNull();
        });

        test("editing a routine's name leaves its model alone", async ({ page }) => {
            const models = await availableModels(page);
            test.skip(models.length === 0, 'no chat models configured in this environment');

            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Renamed Routine',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);
            const conversationId = await triggerAndGetConversation(page, automationId);
            await page.request.put(`/api/automations/${automationId}`, { data: { chatModelId: models[0]!.id } });

            await page.request.put(`/api/automations/${automationId}`, { data: { name: 'Renamed Routine II' } });

            expect((await readAutomation(page, automationId)).chatModelId).toBe(models[0]!.id);
            expect(await conversationModel(page, conversationId)).toBe(models[0]!.id);
        });

        test("a routine's first conversation starts on the routine's model", async ({ page }) => {
            const models = await availableModels(page);
            test.skip(models.length === 0, 'no chat models configured in this environment');

            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'First Run Model Routine',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);
            // Pinned before the routine has ever run, so the conversation is born with it.
            await page.request.put(`/api/automations/${automationId}`, { data: { chatModelId: models[0]!.id } });

            const conversationId = await triggerAndGetConversation(page, automationId);

            expect(await conversationModel(page, conversationId)).toBe(models[0]!.id);
        });

        test('a pinned routine can be put back on the default', async ({ page }) => {
            const models = await availableModels(page);
            test.skip(models.length === 0, 'no chat models configured in this environment');

            const automationId = await automationsPage.createAutomationViaAPI({
                name: 'Unpinned Model Routine',
                prompt: 'Test prompt',
            });
            testAutomationIds.push(automationId);

            const pinned = await page.request.put(`/api/automations/${automationId}`, {
                data: { chatModelId: models[0]!.id },
            });
            expect(pinned.ok()).toBe(true);
            expect((await readAutomation(page, automationId)).chatModelId).toBe(models[0]!.id);

            await automationsPage.goto();
            await automationsPage.openAutomationDetail('Unpinned Model Routine');
            await automationsPage.clickEditButton();
            await automationsPage.detailModal.locator('.automation-model-select').selectOption({ value: '' });
            await automationsPage.saveAutomation();

            expect((await readAutomation(page, automationId)).chatModelId).toBeNull();
        });
    });
});
