/**
 * MCP Tools Page E2E Tests
 *
 * Tests for the MCP tools page functionality including:
 * - Viewing MCP servers
 * - Creating new MCP servers
 * - Editing MCP servers
 * - Deleting MCP servers
 * - Testing connections
 */

import { test, expect } from '@playwright/test';
import { McpToolsPage } from '../helpers/page-objects';

test.describe('MCP Tools Page', () => {
    let mcpToolsPage: McpToolsPage;

    // Track servers created during tests for cleanup
    const createdServerIds: number[] = [];

    test.beforeEach(async ({ page }) => {
        mcpToolsPage = new McpToolsPage(page);
        await mcpToolsPage.goto();
    });

    test.afterEach(async ({ page }) => {
        // Clean up any servers created during tests
        for (const id of createdServerIds) {
            try {
                await page.request.delete(`/api/mcp/servers/${id}`);
            } catch {
                // Ignore errors if server was already deleted
            }
        }
        createdServerIds.length = 0;
    });

    test.describe('Page Layout', () => {
        test('should display MCP tools page header', async () => {
            await expect(mcpToolsPage.mcpToolsHeader).toBeVisible();
            // Header contains h2 with "Tools" text
            const headerTitle = mcpToolsPage.mcpToolsHeader.locator('h2');
            await expect(headerTitle).toContainText('Tools');
        });

        test('should show create button', async () => {
            await expect(mcpToolsPage.createBtn).toBeVisible();
            const btnText = await mcpToolsPage.createBtn.textContent();
            expect(btnText).toContain('Connect Tool');
        });

        test('should show empty state when no servers exist', async () => {
            // First ensure no servers exist
            const count = await mcpToolsPage.getServerCardsCount();
            if (count === 0) {
                await expect(mcpToolsPage.mcpToolsEmpty).toBeVisible();
            }
        });
    });

    test.describe('Create MCP Server', () => {
        test('should open create modal when clicking add button', async () => {
            await mcpToolsPage.openCreateModal();
            await expect(mcpToolsPage.createModal).toBeVisible();
        });

        test('should have transport type selector in create modal', async () => {
            await mcpToolsPage.openCreateModal();
            await expect(mcpToolsPage.transportTypeSelector).toBeVisible();

            // Check both transport options are available
            const stdioBtn = mcpToolsPage.transportTypeSelector.locator('button:has-text("stdio")');
            const sseBtn = mcpToolsPage.transportTypeSelector.locator('button:has-text("HTTP/SSE")');

            await expect(stdioBtn).toBeVisible();
            await expect(sseBtn).toBeVisible();
        });

        test('should create a new stdio server', async ({ page }) => {
            const serverName = `test-server-${Date.now()}`;

            await mcpToolsPage.openCreateModal();
            await mcpToolsPage.fillCreateForm({
                name: serverName,
                description: 'A test MCP server',
                transportType: 'stdio',
                path: '@modelcontextprotocol/server-test',
            });
            await mcpToolsPage.submitCreateForm();

            // Verify server appears in the list
            const serverCard = mcpToolsPage.getServerCardByName(serverName);
            await expect(serverCard).toBeVisible();

            // Clean up
            await mcpToolsPage.deleteServerByNameViaAPI(serverName);
        });

        test('should create a new SSE server', async ({ page }) => {
            const serverName = `test-sse-${Date.now()}`;

            await mcpToolsPage.openCreateModal();
            await mcpToolsPage.fillCreateForm({
                name: serverName,
                description: 'A test SSE MCP server',
                transportType: 'sse',
                path: 'https://example.com/mcp',
            });
            await mcpToolsPage.submitCreateForm();

            // Verify server appears in the list
            const serverCard = mcpToolsPage.getServerCardByName(serverName);
            await expect(serverCard).toBeVisible();

            // Clean up
            await mcpToolsPage.deleteServerByNameViaAPI(serverName);
        });

        test('should auto-format server name on input', async () => {
            await mcpToolsPage.openCreateModal();

            // Type name with uppercase - should be auto-converted to lowercase
            await mcpToolsPage.serverNameInput.fill('MyTestServer');

            // Verify input value is formatted (lowercase, no special chars)
            const inputValue = await mcpToolsPage.serverNameInput.inputValue();
            expect(inputValue).toBe('mytestserver');

            // Spaces and special chars should be converted to hyphens
            await mcpToolsPage.serverNameInput.fill('Test Server Name!');
            const formattedValue = await mcpToolsPage.serverNameInput.inputValue();
            expect(formattedValue).toBe('test-server-name-');
        });

        test('should close create modal when clicking cancel', async () => {
            await mcpToolsPage.openCreateModal();
            await expect(mcpToolsPage.createModal).toBeVisible();

            const cancelBtn = mcpToolsPage.createModal.locator('.btn-secondary');
            await cancelBtn.click();

            await expect(mcpToolsPage.createModal).not.toBeVisible();
        });

        test('should close create modal on Escape key', async () => {
            await mcpToolsPage.openCreateModal();
            await expect(mcpToolsPage.createModal).toBeVisible();

            await mcpToolsPage.closeModalWithEscape();
            await expect(mcpToolsPage.createModal).not.toBeVisible();
        });
    });

    test.describe('View MCP Server Details', () => {
        let testServerId: number;
        const testServerName = `detail-test-${Date.now()}`;

        test.beforeAll(async ({ request }) => {
            // Create a test server for detail tests
            const response = await request.post('/api/mcp/servers', {
                data: {
                    name: testServerName,
                    description: 'Server for detail tests',
                    transportType: 'stdio',
                    path: '@example/test-server',
                    requiresConfirmation: true,
                    enabled: false,
                },
            });
            const data = await response.json();
            testServerId = data.server.id;
        });

        test.afterAll(async ({ request }) => {
            // Clean up test server
            if (testServerId) {
                await request.delete(`/api/mcp/servers/${testServerId}`);
            }
        });

        test('should open detail modal when clicking on server card', async () => {
            // Refresh the page to see the test server
            await mcpToolsPage.goto();

            await mcpToolsPage.openServerDetail(testServerName);
            await expect(mcpToolsPage.detailModal).toBeVisible();
        });

        test('should display server name in detail modal header', async () => {
            await mcpToolsPage.goto();
            await mcpToolsPage.openServerDetail(testServerName);

            const title = await mcpToolsPage.getDetailModalTitle();
            expect(title).toBe(testServerName);
        });

        test('should close detail modal when clicking close button', async () => {
            await mcpToolsPage.goto();
            await mcpToolsPage.openServerDetail(testServerName);
            await expect(mcpToolsPage.detailModal).toBeVisible();

            await mcpToolsPage.closeModal();
            await expect(mcpToolsPage.detailModal).not.toBeVisible();
        });

        test('should close detail modal on Escape key', async () => {
            await mcpToolsPage.goto();
            await mcpToolsPage.openServerDetail(testServerName);
            await expect(mcpToolsPage.detailModal).toBeVisible();

            await mcpToolsPage.closeModalWithEscape();
            await expect(mcpToolsPage.detailModal).not.toBeVisible();
        });
    });

    test.describe('Edit MCP Server', () => {
        let testServerId: number;
        const testServerName = `edit-test-${Date.now()}`;

        test.beforeEach(async ({ request }) => {
            // Create a fresh test server for each edit test
            const response = await request.post('/api/mcp/servers', {
                data: {
                    name: testServerName,
                    description: 'Original description',
                    transportType: 'stdio',
                    path: '@example/original-path',
                    requiresConfirmation: true,
                    enabled: true,
                },
            });
            const data = await response.json();
            testServerId = data.server.id;
            createdServerIds.push(testServerId);

            // Refresh page to see the new server
            await mcpToolsPage.goto();
        });

        test('should have save button disabled when no changes made', async () => {
            await mcpToolsPage.openServerDetail(testServerName);

            const isEnabled = await mcpToolsPage.isSaveButtonEnabled();
            expect(isEnabled).toBe(false);
        });

        test('should enable save button when description is edited', async () => {
            await mcpToolsPage.openServerDetail(testServerName);

            await mcpToolsPage.editDescription('Updated description');

            const isEnabled = await mcpToolsPage.isSaveButtonEnabled();
            expect(isEnabled).toBe(true);
        });

        test('should save updated description', async () => {
            await mcpToolsPage.openServerDetail(testServerName);

            await mcpToolsPage.editDescription('New updated description');
            await mcpToolsPage.saveChanges();

            // Modal should close after save
            await expect(mcpToolsPage.detailModal).not.toBeVisible();

            // Reopen to verify changes persisted
            await mcpToolsPage.openServerDetail(testServerName);
            const descValue = await mcpToolsPage.detailDescriptionInput.inputValue();
            expect(descValue).toBe('New updated description');
        });
    });

    test.describe('Delete MCP Server', () => {
        let testServerId: number;
        let testServerName: string;

        test.beforeEach(async ({ request }) => {
            // Create a fresh test server for each delete test
            testServerName = `delete-test-${Date.now()}`;
            const response = await request.post('/api/mcp/servers', {
                data: {
                    name: testServerName,
                    description: 'Server to be deleted',
                    transportType: 'stdio',
                    path: '@example/delete-me',
                    requiresConfirmation: true,
                    enabled: false,
                },
            });
            const data = await response.json();
            testServerId = data.server.id;

            // Refresh page to see the new server
            await mcpToolsPage.goto();
        });

        test('should show delete button in detail modal', async () => {
            await mcpToolsPage.openServerDetail(testServerName);
            await expect(mcpToolsPage.btnDangerOutline).toBeVisible();
        });

        test('should show delete confirmation when delete button is clicked', async () => {
            await mcpToolsPage.openServerDetail(testServerName);

            await mcpToolsPage.clickDeleteButton();

            await expect(mcpToolsPage.deleteConfirmText).toBeVisible();
            const confirmText = await mcpToolsPage.deleteConfirmText.textContent();
            expect(confirmText).toContain('Delete');
        });

        test('should cancel deletion when cancel is clicked', async () => {
            await mcpToolsPage.openServerDetail(testServerName);

            await mcpToolsPage.clickDeleteButton();
            await mcpToolsPage.cancelDelete();

            // Confirmation should be hidden, modal still open
            await expect(mcpToolsPage.deleteConfirmText).not.toBeVisible();
            await expect(mcpToolsPage.detailModal).toBeVisible();

            // Server should still exist
            await mcpToolsPage.closeModal();
            const serverCard = mcpToolsPage.getServerCardByName(testServerName);
            await expect(serverCard).toBeVisible();

            // Clean up
            await mcpToolsPage.deleteServerViaAPI(testServerId);
        });

        test('should delete server when delete is confirmed', async () => {
            await mcpToolsPage.openServerDetail(testServerName);

            await mcpToolsPage.clickDeleteButton();
            await mcpToolsPage.confirmDelete();

            // Modal should close
            await expect(mcpToolsPage.detailModal).not.toBeVisible();

            // Server should no longer appear in the list
            const serverCard = mcpToolsPage.getServerCardByName(testServerName);
            await expect(serverCard).not.toBeVisible();
        });
    });

    test.describe('Server Status Display', () => {
        test('should show disabled status for disabled server', async ({ request }) => {
            const serverName = `status-test-${Date.now()}`;
            const response = await request.post('/api/mcp/servers', {
                data: {
                    name: serverName,
                    description: 'Disabled server',
                    transportType: 'stdio',
                    path: '@example/disabled',
                    enabled: false,
                },
            });
            const data = await response.json();
            createdServerIds.push(data.server.id);

            await mcpToolsPage.goto();

            const status = await mcpToolsPage.getServerStatus(serverName);
            expect(status.toLowerCase()).toContain('disabled');
        });
    });

    test.describe('API Integration', () => {
        test('should list servers via API', async ({ request }) => {
            const response = await request.get('/api/mcp/servers');
            expect(response.ok()).toBe(true);

            const data = await response.json();
            expect(data).toHaveProperty('servers');
            expect(Array.isArray(data.servers)).toBe(true);
        });

        test('should create server via API', async ({ request }) => {
            const serverName = `api-create-${Date.now()}`;
            const response = await request.post('/api/mcp/servers', {
                data: {
                    name: serverName,
                    description: 'API created server',
                    transportType: 'stdio',
                    path: '@example/api-test',
                },
            });

            expect(response.ok()).toBe(true);
            const data = await response.json();
            expect(data.server.name).toBe(serverName);
            createdServerIds.push(data.server.id);
        });

        test('should update server via API', async ({ request }) => {
            // Create server first
            const serverName = `api-update-${Date.now()}`;
            const createResponse = await request.post('/api/mcp/servers', {
                data: {
                    name: serverName,
                    description: 'Original',
                    transportType: 'stdio',
                    path: '@example/update-test',
                },
            });
            const createData = await createResponse.json();
            const serverId = createData.server.id;
            createdServerIds.push(serverId);

            // Update server
            const updateResponse = await request.put(`/api/mcp/servers/${serverId}`, {
                data: {
                    description: 'Updated description',
                },
            });

            expect(updateResponse.ok()).toBe(true);
            const updateData = await updateResponse.json();
            expect(updateData.server.description).toBe('Updated description');
        });

        test('should delete server via API', async ({ request }) => {
            // Create server first
            const serverName = `api-delete-${Date.now()}`;
            const createResponse = await request.post('/api/mcp/servers', {
                data: {
                    name: serverName,
                    description: 'To be deleted',
                    transportType: 'stdio',
                    path: '@example/delete-test',
                },
            });
            const createData = await createResponse.json();
            const serverId = createData.server.id;

            // Delete server
            const deleteResponse = await request.delete(`/api/mcp/servers/${serverId}`);
            expect(deleteResponse.ok()).toBe(true);

            // Verify it's deleted
            const getResponse = await request.get(`/api/mcp/servers/${serverId}`);
            expect(getResponse.status()).toBe(404);
        });

        test('should reject invalid server name via API', async ({ request }) => {
            const response = await request.post('/api/mcp/servers', {
                data: {
                    name: 'Invalid Name With Spaces',
                    description: 'Should fail',
                    transportType: 'stdio',
                    path: '@example/test',
                },
            });

            expect(response.ok()).toBe(false);
        });

        test('should reject duplicate server name via API', async ({ request }) => {
            const serverName = `duplicate-test-${Date.now()}`;

            // Create first server
            const firstResponse = await request.post('/api/mcp/servers', {
                data: {
                    name: serverName,
                    transportType: 'stdio',
                    path: '@example/first',
                },
            });
            expect(firstResponse.ok()).toBe(true);
            const firstData = await firstResponse.json();
            createdServerIds.push(firstData.server.id);

            // Try to create duplicate
            const secondResponse = await request.post('/api/mcp/servers', {
                data: {
                    name: serverName,
                    transportType: 'stdio',
                    path: '@example/second',
                },
            });

            expect(secondResponse.ok()).toBe(false);
        });
    });
});
