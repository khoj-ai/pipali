/**
 * MCP Tools Page Object
 *
 * Handles MCP tools page interactions including viewing, creating, editing, and deleting MCP servers.
 */

import type { Page, Locator } from '@playwright/test';

export class McpToolsPage {
    readonly page: Page;

    // Main page elements
    readonly mcpToolsGallery: Locator;
    readonly mcpToolsHeader: Locator;
    readonly mcpToolsCount: Locator;
    readonly createBtn: Locator;
    readonly reloadBtn: Locator;
    readonly mcpServerCards: Locator;
    readonly mcpToolsEmpty: Locator;
    readonly mcpToolsLoading: Locator;

    // Create modal elements
    readonly createModal: Locator;
    readonly serverNameInput: Locator;
    readonly serverDescriptionInput: Locator;
    readonly serverPathInput: Locator;
    readonly serverApiKeyInput: Locator;
    readonly transportTypeSelector: Locator;
    readonly confirmationCheckbox: Locator;
    readonly enabledCheckbox: Locator;

    // Detail modal elements
    readonly detailModal: Locator;
    readonly detailDescriptionInput: Locator;
    readonly detailPathInput: Locator;
    readonly testConnectionBtn: Locator;
    readonly testResult: Locator;
    readonly toolsList: Locator;
    readonly toolItems: Locator;
    readonly deleteConfirmText: Locator;

    // Modal common elements
    readonly modalBackdrop: Locator;
    readonly modalClose: Locator;
    readonly btnPrimary: Locator;
    readonly btnSecondary: Locator;
    readonly btnDanger: Locator;
    readonly btnDangerOutline: Locator;
    readonly formError: Locator;

    constructor(page: Page) {
        this.page = page;

        // Main page
        this.mcpToolsGallery = page.locator('.mcp-tools-gallery');
        this.mcpToolsHeader = page.locator('.mcp-tools-header');
        this.mcpToolsCount = page.locator('.mcp-tools-header h1');
        this.createBtn = page.locator('.mcp-tools-header .mcp-tools-create-btn');
        this.reloadBtn = page.locator('.mcp-tools-header .mcp-tools-refresh-btn');
        this.mcpServerCards = page.locator('.mcp-server-card');
        this.mcpToolsEmpty = page.locator('.mcp-tools-empty');
        this.mcpToolsLoading = page.locator('.mcp-tools-loading');

        // Create modal
        this.createModal = page.locator('.modal.mcp-server-modal:not(.mcp-server-detail-modal)');
        this.serverNameInput = page.locator('#server-name');
        this.serverDescriptionInput = page.locator('#server-description');
        this.serverPathInput = page.locator('#server-path');
        this.serverApiKeyInput = page.locator('#server-api-key');
        this.transportTypeSelector = page.locator('.transport-type-selector');
        this.confirmationCheckbox = page.locator('input[type="checkbox"]').first();
        this.enabledCheckbox = page.locator('input[type="checkbox"]').nth(1);

        // Detail modal
        this.detailModal = page.locator('.mcp-server-detail-modal');
        this.detailDescriptionInput = this.detailModal.locator('#server-description');
        this.detailPathInput = this.detailModal.locator('#server-path');
        this.testConnectionBtn = page.locator('button:has-text("Test Connection")');
        this.testResult = page.locator('.test-result');
        this.toolsList = page.locator('.mcp-tools-list');
        this.toolItems = page.locator('.tool-item');
        this.deleteConfirmText = page.locator('.delete-confirm-text');

        // Modal common
        this.modalBackdrop = page.locator('.modal-backdrop');
        this.modalClose = page.locator('.modal-close');
        this.btnPrimary = page.locator('.btn-primary');
        this.btnSecondary = page.locator('.btn-secondary');
        this.btnDanger = page.locator('.btn-danger');
        this.btnDangerOutline = page.locator('.btn-danger-outline');
        this.formError = page.locator('.form-error');
    }

    /**
     * Navigate to the MCP tools page
     */
    async goto(): Promise<void> {
        await this.page.goto('/tools');
        await this.waitForLoad();
    }

    /**
     * Wait for MCP tools page to load
     */
    async waitForLoad(): Promise<void> {
        await this.mcpToolsGallery.waitFor({ state: 'visible', timeout: 10000 });
    }

    /**
     * Get the count of MCP servers displayed in header
     */
    async getServerCountFromHeader(): Promise<number> {
        const headerText = await this.mcpToolsCount.textContent();
        const match = headerText?.match(/\((\d+)\)/);
        return match && match[1] ? parseInt(match[1], 10) : 0;
    }

    /**
     * Get actual count of server cards displayed
     */
    async getServerCardsCount(): Promise<number> {
        return await this.mcpServerCards.count();
    }

    /**
     * Check if empty state is shown
     */
    async isEmptyStateVisible(): Promise<boolean> {
        return await this.mcpToolsEmpty.isVisible();
    }

    /**
     * Get server card by name
     */
    getServerCardByName(name: string): Locator {
        return this.page.locator(`.mcp-server-card:has(.mcp-server-card-title:text-is("${name}"))`);
    }

    /**
     * Open create modal
     */
    async openCreateModal(): Promise<void> {
        await this.createBtn.click();
        await this.createModal.waitFor({ state: 'visible', timeout: 5000 });
    }

    /**
     * Fill create form
     */
    async fillCreateForm(options: {
        name: string;
        description?: string;
        transportType: 'stdio' | 'sse';
        path: string;
        apiKey?: string;
        requiresConfirmation?: boolean;
    }): Promise<void> {
        await this.serverNameInput.fill(options.name);

        if (options.description) {
            await this.serverDescriptionInput.fill(options.description);
        }

        // Select transport type
        const transportBtn = this.transportTypeSelector.locator(
            `button:has-text("${options.transportType === 'stdio' ? 'stdio' : 'HTTP/SSE'}")`
        );
        await transportBtn.click();

        await this.serverPathInput.fill(options.path);

        if (options.transportType === 'sse' && options.apiKey) {
            await this.serverApiKeyInput.fill(options.apiKey);
        }
    }

    /**
     * Submit create form
     */
    async submitCreateForm(): Promise<void> {
        const submitBtn = this.createModal.locator('button[type="submit"]');
        await submitBtn.click();
        // Wait for modal to close after creation
        await this.createModal.waitFor({ state: 'hidden', timeout: 10000 });
    }

    /**
     * Open server detail modal by clicking on a card
     */
    async openServerDetail(serverName: string): Promise<void> {
        const serverCard = this.getServerCardByName(serverName);
        await serverCard.click();
        await this.detailModal.waitFor({ state: 'visible', timeout: 5000 });
    }

    /**
     * Close the currently open modal
     */
    async closeModal(): Promise<void> {
        const closeBtn = this.page.locator('.modal:visible .modal-close');
        await closeBtn.click();
        await this.page.waitForTimeout(300);
    }

    /**
     * Close modal by pressing Escape
     */
    async closeModalWithEscape(): Promise<void> {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(300);
    }

    /**
     * Get detail modal title (server name)
     */
    async getDetailModalTitle(): Promise<string> {
        const header = this.detailModal.locator('h2');
        return (await header.textContent()) || '';
    }

    /**
     * Edit description in detail modal
     */
    async editDescription(newDescription: string): Promise<void> {
        await this.detailDescriptionInput.clear();
        await this.detailDescriptionInput.fill(newDescription);
    }

    /**
     * Edit path in detail modal
     */
    async editPath(newPath: string): Promise<void> {
        await this.detailPathInput.clear();
        await this.detailPathInput.fill(newPath);
    }

    /**
     * Save changes in detail modal
     */
    async saveChanges(): Promise<void> {
        const saveBtn = this.detailModal.locator('button:has-text("Save Changes")');
        await saveBtn.click();
        await this.detailModal.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Check if save button is enabled
     */
    async isSaveButtonEnabled(): Promise<boolean> {
        const saveBtn = this.detailModal.locator('button:has-text("Save Changes")');
        return await saveBtn.isEnabled();
    }

    /**
     * Test connection to server
     */
    async testConnection(): Promise<void> {
        await this.testConnectionBtn.click();
        // Wait for test to complete
        await this.testResult.waitFor({ state: 'visible', timeout: 30000 });
    }

    /**
     * Check if test result is successful
     */
    async isTestSuccessful(): Promise<boolean> {
        const hasSuccess = await this.testResult.locator('.success').isVisible();
        return hasSuccess || (await this.testResult.textContent())?.includes('successful') || false;
    }

    /**
     * Get test result message
     */
    async getTestResultMessage(): Promise<string> {
        return (await this.testResult.textContent()) || '';
    }

    /**
     * Get tool count from test result
     */
    async getToolCountFromTestResult(): Promise<number> {
        const message = await this.getTestResultMessage();
        const match = message.match(/(\d+)\s+tool/);
        return match && match[1] ? parseInt(match[1], 10) : 0;
    }

    /**
     * Check if tools list is visible
     */
    async isToolsListVisible(): Promise<boolean> {
        return await this.toolsList.isVisible();
    }

    /**
     * Get count of tools displayed
     */
    async getToolsCount(): Promise<number> {
        return await this.toolItems.count();
    }

    /**
     * Click delete button
     */
    async clickDeleteButton(): Promise<void> {
        await this.btnDangerOutline.click();
    }

    /**
     * Confirm server deletion
     */
    async confirmDelete(): Promise<void> {
        await this.deleteConfirmText.waitFor({ state: 'visible', timeout: 3000 });
        await this.btnDanger.click();
        await this.detailModal.waitFor({ state: 'hidden', timeout: 5000 });
    }

    /**
     * Cancel server deletion
     */
    async cancelDelete(): Promise<void> {
        await this.deleteConfirmText.waitFor({ state: 'visible', timeout: 3000 });
        const cancelBtn = this.detailModal.locator('.modal-actions-left .btn-secondary');
        await cancelBtn.click();
        await this.deleteConfirmText.waitFor({ state: 'hidden', timeout: 3000 });
    }

    /**
     * Get all server names displayed on the page
     */
    async getAllServerNames(): Promise<string[]> {
        const names: string[] = [];
        const count = await this.mcpServerCards.count();

        for (let i = 0; i < count; i++) {
            const titleElement = this.mcpServerCards.nth(i).locator('.mcp-server-card-title');
            const name = await titleElement.textContent();
            if (name) {
                names.push(name);
            }
        }

        return names;
    }

    /**
     * Get server status badge text from card
     */
    async getServerStatus(serverName: string): Promise<string> {
        const card = this.getServerCardByName(serverName);
        const badge = card.locator('.mcp-server-status-badge');
        return (await badge.textContent()) || '';
    }

    /**
     * Create a server via API
     */
    async createServerViaAPI(options: {
        name: string;
        description?: string;
        transportType: 'stdio' | 'sse';
        path: string;
        apiKey?: string;
        requiresConfirmation?: boolean;
        enabled?: boolean;
    }): Promise<number> {
        const response = await this.page.request.post('/api/mcp/servers', {
            data: {
                name: options.name,
                description: options.description,
                transportType: options.transportType,
                path: options.path,
                apiKey: options.apiKey,
                requiresConfirmation: options.requiresConfirmation ?? true,
                enabled: options.enabled ?? true,
            },
        });

        const data = await response.json();
        return data.server.id;
    }

    /**
     * Delete a server via API
     */
    async deleteServerViaAPI(serverId: number): Promise<void> {
        await this.page.request.delete(`/api/mcp/servers/${serverId}`);
    }

    /**
     * Delete a server by name via API
     */
    async deleteServerByNameViaAPI(serverName: string): Promise<void> {
        // First, get the server ID
        const response = await this.page.request.get('/api/mcp/servers');
        const data = await response.json();
        const server = data.servers?.find((s: any) => s.name === serverName);
        if (server) {
            await this.deleteServerViaAPI(server.id);
        }
    }

    /**
     * Reload the servers list
     */
    async reloadServers(): Promise<void> {
        // Check if reload button exists in current view
        const reloadBtnInHeader = this.page.locator('.mcp-tools-header .btn-secondary:has(.lucide-refresh-cw)');
        if (await reloadBtnInHeader.isVisible()) {
            await reloadBtnInHeader.click();
        }
        await this.page.waitForTimeout(500);
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
