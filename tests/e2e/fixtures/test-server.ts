/**
 * Test Server Fixture
 *
 * Manages the lifecycle of a test server instance for E2E tests.
 * Starts the server in test mode with mock LLM responses.
 * Uses Node.js child_process for compatibility with Playwright runner.
 */

import { spawn, type ChildProcess } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MockScenario } from './mock-llm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TestServerConfig {
    port: number;
    host?: string;
    mockScenarios?: MockScenario[];
}

export class TestServer {
    private process: ChildProcess | null = null;
    private port: number;
    private host: string;
    private dbPath: string;
    private skillsGlobalDir: string;
    private skillsLocalDir: string;
    private mockScenarios: MockScenario[];

    constructor(config: TestServerConfig) {
        this.port = config.port;
        this.host = config.host || '127.0.0.1';
        const testId = Date.now();
        this.dbPath = `/tmp/pipali/pipali-test-${testId}`;
        this.skillsGlobalDir = `/tmp/pipali/pipali-test-${testId}-skills-global`;
        this.skillsLocalDir = `/tmp/pipali/pipali-test-${testId}-skills-local`;
        this.mockScenarios = config.mockScenarios || [];
    }

    /**
     * Get the global skills directory for this test server
     */
    getSkillsGlobalDir(): string {
        return this.skillsGlobalDir;
    }

    /**
     * Get the local skills directory for this test server
     */
    getSkillsLocalDir(): string {
        return this.skillsLocalDir;
    }

    async start(): Promise<void> {
        console.log(`[TestServer] Starting on ${this.host}:${this.port}...`);

        // Create isolated skills directories for testing
        await mkdir(this.skillsGlobalDir, { recursive: true });
        await mkdir(this.skillsLocalDir, { recursive: true });
        console.log(`[TestServer] Created test skills dirs: global=${this.skillsGlobalDir}, local=${this.skillsLocalDir}`);

        // Set environment variables for the test server
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PIPALI_PORT: String(this.port),
            PIPALI_HOST: this.host,
            POSTGRES_DB: this.dbPath,
            PIPALI_TEST_MODE: 'true',
            // Use isolated skills directories for testing
            PIPALI_SKILLS_GLOBAL_DIR: this.skillsGlobalDir,
            PIPALI_SKILLS_LOCAL_DIR: this.skillsLocalDir,
        };

        // Pass mock scenarios if provided
        if (this.mockScenarios.length > 0) {
            env.PIPALI_MOCK_SCENARIOS = JSON.stringify(this.mockScenarios);
        }

        // Start the server with --preload to inject mock LLM before any modules load
        // The preload script sets globalThis.__pipaliTestMock which sendMessageToModel checks
        const preloadPath = resolve(__dirname, '../mock-preload.ts');
        this.process = spawn('bun', ['run', '--preload', preloadPath, 'src/server/index.ts'], {
            cwd: process.cwd(),
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Log server output for debugging
        this.process.stdout?.on('data', (data) => {
            console.log(`[Server] ${data.toString().trim()}`);
        });

        this.process.stderr?.on('data', (data) => {
            console.error(`[Server Error] ${data.toString().trim()}`);
        });

        // Wait for server to be ready
        await this.waitForReady();
        console.log(`[TestServer] Ready on ${this.host}:${this.port}`);
    }

    private async waitForReady(): Promise<void> {
        const maxAttempts = 60;
        const delay = 500;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const response = await fetch(`http://${this.host}:${this.port}/api/models`);
                if (response.ok) {
                    return;
                }
            } catch {
                // Server not ready yet
            }
            await new Promise((r) => setTimeout(r, delay));
        }
        throw new Error(`Test server failed to start after ${maxAttempts * delay}ms`);
    }

    async stop(): Promise<void> {
        if (this.process) {
            console.log('[TestServer] Stopping...');

            // Kill the process
            this.process.kill('SIGTERM');

            // Wait for process to exit
            await new Promise<void>((resolve) => {
                if (!this.process) {
                    resolve();
                    return;
                }
                this.process.on('exit', () => resolve());
                // Force kill after 5 seconds
                setTimeout(() => {
                    if (this.process && !this.process.killed) {
                        this.process.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);
            });

            this.process = null;
            console.log('[TestServer] Stopped');
        }

        // Clean up test database and skills directories
        try {
            await rm(this.dbPath, { recursive: true, force: true });
            await rm(this.skillsGlobalDir, { recursive: true, force: true });
            await rm(this.skillsLocalDir, { recursive: true, force: true });
            console.log('[TestServer] Cleaned up test database and skills directories');
        } catch {
            // Ignore cleanup errors
        }
    }

    getBaseUrl(): string {
        return `http://${this.host}:${this.port}`;
    }

    getPort(): number {
        return this.port;
    }
}

// Singleton instance for global setup/teardown
let globalTestServer: TestServer | null = null;

export function getGlobalTestServer(): TestServer | null {
    return globalTestServer;
}

export function setGlobalTestServer(server: TestServer | null): void {
    globalTestServer = server;
}
