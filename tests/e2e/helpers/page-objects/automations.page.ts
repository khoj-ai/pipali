/**
 * Automations Page Object
 *
 * Handles automations page interactions including viewing, creating, editing, and deleting automations.
 */

import type { Page, Locator } from '@playwright/test';
import { Selectors } from '../selectors';

export class AutomationsPage {
    readonly page: Page;

    // Main page elements
    readonly automationsGallery: Locator;
    readonly automationsHeader: Locator;
    readonly automationsCount: Locator;
    readonly createBtn: Locator;
    readonly reloadBtn: Locator;
    readonly automationsCards: Locator;
    readonly automationCards: Locator;
    readonly automationsEmpty: Locator;
    readonly automationsLoading: Locator;

    // Automation detail modal elements
    readonly detailModal: Locator;
    readonly detailInstructionsText: Locator;
    readonly detailInstructionsInput: Locator;
    readonly detailSchedule: Locator;
    readonly detailNextRun: Locator;
    readonly deleteConfirmText: Locator;

    // Confirmation section in detail modal
    readonly confirmationSection: Locator;
    readonly confirmationHeader: Locator;
    readonly confirmationContent: Locator;
    readonly confirmationActions: Locator;

    // Modal common elements
    readonly modalBackdrop: Locator;
    readonly modalClose: Locator;
    readonly btnPrimary: Locator;
    readonly btnSecondary: Locator;
    readonly btnDanger: Locator;
    readonly btnDangerOutline: Locator;
    readonly formError: Locator;

    // Toast elements
    readonly toastContainer: Locator;
    readonly automationToasts: Locator;

    constructor(page: Page) {
        this.page = page;

        // Main page
        this.automationsGallery = page.locator(Selectors.automationsGallery);
        this.automationsHeader = page.locator(Selectors.automationsHeader);
        this.automationsCount = page.locator(Selectors.automationsCount);
        this.createBtn = page.locator(Selectors.automationsCreateBtn);
        this.reloadBtn = page.locator(Selectors.automationsReloadBtn);
        this.automationsCards = page.locator(Selectors.automationsCards);
        this.automationCards = page.locator(Selectors.automationCard);
        this.automationsEmpty = page.locator(Selectors.automationsEmpty);
        this.automationsLoading = page.locator(Selectors.automationsLoading);

        // Detail modal
        this.detailModal = page.locator(Selectors.automationDetailModal);
        this.detailInstructionsText = page.locator(Selectors.automationDetailInstructions);
        this.detailInstructionsInput = page.locator(Selectors.instructionsTextarea);
        this.detailSchedule = page.locator(Selectors.automationDetailSchedule);
        this.detailNextRun = page.locator(Selectors.automationDetailNextRun);
        this.deleteConfirmText = page.locator(Selectors.deleteConfirmText);

        // Confirmation section
        this.confirmationSection = page.locator(Selectors.automationConfirmationSection);
        this.confirmationHeader = page.locator(Selectors.confirmationHeader);
        this.confirmationContent = page.locator(Selectors.confirmationContent);
        this.confirmationActions = page.locator(Selectors.confirmationActions);

        // Modal common
        this.modalBackdrop = page.locator(Selectors.modalBackdrop);
        this.modalClose = page.locator(Selectors.modalClose);
        this.btnPrimary = page.locator(Selectors.btnPrimary);
        this.btnSecondary = page.locator(Selectors.btnSecondary);
        this.btnDanger = page.locator(Selectors.btnDanger);
        this.btnDangerOutline = page.locator(Selectors.btnDangerOutline);
        this.formError = page.locator(Selectors.formError);

        // Toast elements
        this.toastContainer = page.locator(Selectors.toastContainer);
        this.automationToasts = page.locator(Selectors.toastAutomation);
    }

    /**
     * Navigate to the automations page
     */
    async goto(): Promise<void> {
        await this.page.goto('/automations');
        await this.waitForLoad();
    }

    /**
     * Wait for automations page to load
     */
    async waitForLoad(): Promise<void> {
        await this.automationsGallery.waitFor({ state: 'visible', timeout: 10000 });
        // Wait for loading state to disappear
        await this.page.waitForFunction(
            (loadingSelector: string) => {
                return !document.querySelector(loadingSelector);
            },
            Selectors.automationsLoading,
            { timeout: 10000 }
        );
    }

    /**
     * Get the count of automations displayed
     */
    async getAutomationCount(): Promise<number> {
        const countText = await this.automationsCount.textContent();
        return parseInt(countText || '0', 10);
    }

    /**
     * Get all automation cards count
     */
    async getAutomationCardsCount(): Promise<number> {
        return await this.automationCards.count();
    }

    /**
     * Check if empty state is shown
     */
    async isEmptyStateVisible(): Promise<boolean> {
        return await this.automationsEmpty.isVisible();
    }

    /**
     * Get automation card by name
     */
    getAutomationCardByName(name: string): Locator {
        return this.page.locator(`${Selectors.automationCard}:has(${Selectors.automationCardTitle}:text-is("${name}"))`);
    }

    /**
     * Get automation card by prompt text (partial match)
     */
    getAutomationCardByPrompt(promptText: string): Locator {
        return this.page.locator(`${Selectors.automationCard}:has(${Selectors.automationCardPrompt}:has-text("${promptText}"))`);
    }

    /**
     * Get automation card by status
     */
    getAutomationCardsByStatus(status: 'active' | 'paused' | 'error'): Locator {
        return this.page.locator(`${Selectors.automationCard}:has(${Selectors.automationStatusBadge}:text-is("${status}"))`);
    }

    /**
     * Get automation cards awaiting confirmation
     */
    getAutomationCardsAwaitingConfirmation(): Locator {
        return this.page.locator(Selectors.automationAwaitingConfirmation);
    }

    /**
     * Open automation detail modal by clicking on a card
     */
    async openAutomationDetail(automationName: string): Promise<void> {
        const automationCard = this.getAutomationCardByName(automationName);
        await automationCard.waitFor({ state: 'visible', timeout: 10000 });
        await automationCard.click();
        await this.detailModal.waitFor({ state: 'visible', timeout: 5000 });
    }

    /**
     * Open automation detail by prompt text
     */
    async openAutomationDetailByPrompt(promptText: string): Promise<void> {
        const automationCard = this.getAutomationCardByPrompt(promptText);
        await automationCard.waitFor({ state: 'visible', timeout: 10000 });
        await automationCard.click();
        await this.detailModal.waitFor({ state: 'visible', timeout: 5000 });
    }

    /**
     * Close the currently open modal
     */
    async closeModal(): Promise<void> {
        await this.modalClose.click();
        await this.modalBackdrop.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Close modal by pressing Escape
     */
    async closeModalWithEscape(): Promise<void> {
        await this.page.keyboard.press('Escape');
        await this.modalBackdrop.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Get automation detail modal title (automation name)
     */
    async getDetailModalTitle(): Promise<string> {
        const header = this.detailModal.locator('h2');
        return (await header.textContent()) || '';
    }

    /**
     * Get automation instructions from detail modal (view mode)
     */
    async getDetailInstructions(): Promise<string> {
        return (await this.detailInstructionsText.textContent()) || '';
    }

    /**
     * Get automation schedule from detail modal
     */
    async getDetailScheduleText(): Promise<string> {
        return (await this.detailSchedule.textContent()) || '';
    }

    /**
     * Get automation next run time from detail modal
     */
    async getDetailNextRunText(): Promise<string> {
        if (!(await this.detailNextRun.isVisible())) return '';
        return (await this.detailNextRun.textContent()) || '';
    }

    /**
     * Get automation status badge text from detail modal
     */
    async getDetailStatus(): Promise<string> {
        const badge = this.detailModal.locator(Selectors.automationStatusBadge);
        return (await badge.textContent()) || '';
    }

    /**
     * Check if automation is awaiting confirmation
     */
    async isAwaitingConfirmation(): Promise<boolean> {
        const badge = this.detailModal.locator(Selectors.automationStatusBadge);
        const text = await badge.textContent();
        return text?.toLowerCase().includes('approval') ?? false;
    }

    /**
     * Click edit button to enter edit mode
     */
    async clickEditButton(): Promise<void> {
        const editBtn = this.detailModal.locator('button:has-text("Edit")');
        await editBtn.click();
    }

    /**
     * Edit automation instructions
     */
    async editInstructions(newInstructions: string): Promise<void> {
        await this.detailInstructionsInput.clear();
        await this.detailInstructionsInput.fill(newInstructions);
    }

    /**
     * Select frequency in edit mode
     */
    async selectFrequency(frequency: 'Hour' | 'Day' | 'Week' | 'Month'): Promise<void> {
        const frequencySelect = this.detailModal.locator(Selectors.frequencySelect).first();
        await frequencySelect.selectOption({ label: frequency });
    }

    /**
     * Select day of week in edit mode (when frequency is Week)
     */
    async selectDayOfWeek(day: string): Promise<void> {
        const daySelect = this.detailModal.locator(Selectors.frequencySelect).nth(1);
        await daySelect.selectOption({ label: day });
    }

    /**
     * Select time in edit mode
     */
    async selectTime(time: string): Promise<void> {
        const timeSelect = this.detailModal.locator('.time-select');
        await timeSelect.selectOption({ label: time });
    }

    /**
     * Save automation changes
     */
    async saveAutomation(): Promise<void> {
        const saveBtn = this.detailModal.locator('button:has-text("Save")');
        await saveBtn.click();
        // Wait for modal to close after successful save
        await this.detailModal.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Check if save button is enabled
     */
    async isSaveButtonEnabled(): Promise<boolean> {
        const saveBtn = this.detailModal.locator('button:has-text("Save")');
        return await saveBtn.isEnabled();
    }

    /**
     * Click delete button in detail modal
     */
    async clickDeleteButton(): Promise<void> {
        await this.btnDangerOutline.click();
    }

    /**
     * Confirm automation deletion
     */
    async confirmDelete(): Promise<void> {
        // Wait for delete confirmation to appear
        await this.deleteConfirmText.waitFor({ state: 'visible', timeout: 3000 });
        // Click confirm delete (danger button)
        await this.btnDanger.click();
        // Wait for modal to close after deletion
        await this.detailModal.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Cancel automation deletion
     */
    async cancelDelete(): Promise<void> {
        await this.deleteConfirmText.waitFor({ state: 'visible', timeout: 3000 });
        await this.btnSecondary.click();
        // Delete confirmation should disappear
        await this.deleteConfirmText.waitFor({ state: 'hidden', timeout: 3000 });
    }

    /**
     * Toggle automation status (pause/resume)
     */
    async toggleStatus(): Promise<void> {
        const toggleBtn = this.detailModal.locator('button:has-text("Pause"), button:has-text("Resume")');
        await toggleBtn.click();
        // Wait for modal to close after toggle
        await this.detailModal.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Pause automation
     */
    async pauseAutomation(): Promise<void> {
        const pauseBtn = this.detailModal.locator('button:has-text("Pause")');
        await pauseBtn.click();
        await this.detailModal.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Resume automation
     */
    async resumeAutomation(): Promise<void> {
        const resumeBtn = this.detailModal.locator('button:has-text("Resume")');
        await resumeBtn.click();
        await this.detailModal.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Refresh automations list
     */
    async reloadAutomations(): Promise<void> {
        await this.reloadBtn.click();
        // Wait for reload to complete
        await this.page.waitForTimeout(500);
        await this.page.waitForFunction(
            (selector: string) => {
                const btn = document.querySelector(selector);
                if (!btn) return true;
                const spinner = btn.querySelector('.spinning');
                return !spinner;
            },
            Selectors.automationsReloadBtn,
            { timeout: 10000 }
        );
    }

    /**
     * Get all automation names displayed on the page
     */
    async getAllAutomationNames(): Promise<string[]> {
        const names: string[] = [];
        const count = await this.automationCards.count();

        for (let i = 0; i < count; i++) {
            const titleElement = this.automationCards.nth(i).locator(Selectors.automationCardTitle);
            const name = await titleElement.textContent();
            if (name) {
                names.push(name);
            }
        }

        return names;
    }

    /**
     * Get all automations with their status
     */
    async getAllAutomationsWithStatus(): Promise<{ name: string; status: string }[]> {
        const automations: { name: string; status: string }[] = [];
        const count = await this.automationCards.count();

        for (let i = 0; i < count; i++) {
            const card = this.automationCards.nth(i);
            const name = await card.locator(Selectors.automationCardTitle).textContent();
            const status = await card.locator(Selectors.automationStatusBadge).textContent();
            if (name && status) {
                automations.push({ name, status });
            }
        }

        return automations;
    }

    /**
     * Create a new automation via API
     */
    async createAutomationViaAPI(options: {
        name: string;
        prompt: string;
        description?: string;
        schedule?: string; // cron format
    }): Promise<string> {
        const response = await this.page.request.post('/api/automations', {
            data: {
                name: options.name,
                prompt: options.prompt,
                description: options.description,
                triggerType: 'cron',
                triggerConfig: {
                    type: 'cron',
                    schedule: options.schedule || '0 12 * * *', // Default to daily at noon
                },
            },
        });

        const data = await response.json();
        return data.automation.id;
    }

    /**
     * Delete an automation via API
     */
    async deleteAutomationViaAPI(automationId: string): Promise<void> {
        await this.page.request.delete(`/api/automations/${automationId}`);
    }

    /**
     * Trigger an automation manually via API
     */
    async triggerAutomationViaAPI(automationId: string): Promise<string | null> {
        const response = await this.page.request.post(`/api/automations/${automationId}/trigger`);
        if (response.ok()) {
            const data = await response.json();
            return data.executionId;
        }
        return null;
    }

    /**
     * Get pending confirmations for automations via API
     */
    async getPendingConfirmationsViaAPI(): Promise<any[]> {
        const response = await this.page.request.get('/api/automations/confirmations/pending');
        const data = await response.json();
        return data.confirmations || [];
    }

    /**
     * Wait for a pending confirmation to appear for a specific automation
     * Polls the API until a confirmation is found or timeout is reached
     * @returns The confirmation if found, null if timeout
     */
    async waitForPendingConfirmation(
        automationId: string,
        options: { timeout?: number; pollInterval?: number } = {}
    ): Promise<any | null> {
        const { timeout = 15000, pollInterval = 500 } = options;
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            const confirmations = await this.getPendingConfirmationsViaAPI();
            const found = confirmations.find((c: any) => c.automationId === automationId);
            if (found) {
                return found;
            }
            await this.page.waitForTimeout(pollInterval);
        }

        return null;
    }

    /**
     * Wait for any pending confirmation to appear
     * Polls the API until at least one confirmation is found or timeout is reached
     * @returns Array of confirmations if found, empty array if timeout
     */
    async waitForAnyPendingConfirmation(
        options: { timeout?: number; pollInterval?: number } = {}
    ): Promise<any[]> {
        const { timeout = 15000, pollInterval = 500 } = options;
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            const confirmations = await this.getPendingConfirmationsViaAPI();
            if (confirmations.length > 0) {
                return confirmations;
            }
            await this.page.waitForTimeout(pollInterval);
        }

        return [];
    }

    /**
     * Check if there are automation toast notifications visible
     */
    async hasAutomationToasts(): Promise<boolean> {
        return await this.automationToasts.isVisible();
    }

    /**
     * Get count of automation toast notifications
     */
    async getAutomationToastCount(): Promise<number> {
        return await this.automationToasts.count();
    }

    /**
     * Respond to confirmation in detail modal
     */
    async respondToConfirmation(optionLabel: string): Promise<void> {
        const confirmBtn = this.confirmationActions.locator(`button:has-text("${optionLabel}")`);
        await confirmBtn.click();
    }

    /**
     * Check if confirmation section is visible in detail modal
     */
    async isConfirmationSectionVisible(): Promise<boolean> {
        return await this.confirmationSection.isVisible();
    }

    /**
     * Get confirmation title from detail modal
     */
    async getConfirmationTitle(): Promise<string> {
        const title = this.confirmationSection.locator('.confirmation-title');
        return (await title.textContent()) || '';
    }

    /**
     * Check if form has validation error
     */
    async hasFormError(): Promise<boolean> {
        return await this.formError.isVisible();
    }

    /**
     * Get form error message
     */
    async getFormErrorMessage(): Promise<string> {
        return (await this.formError.textContent()) || '';
    }
}
