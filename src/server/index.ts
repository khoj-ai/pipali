import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { parseArgs } from "util";
import { db, closeDatabase } from "./db";
import app from "./routes";
import api from "./routes/api";
import { initializeDatabase } from "./init";
import { getMigrationsFolder } from "./utils";
import { loadSkills } from "./skills";
import { websocketHandler, type WebSocketData } from "./routes/ws";
import {
    IS_COMPILED_BINARY,
    EMBEDDED_MIGRATIONS,
} from "./embedded-assets";
import { startAutomationSystem, stopAutomationSystem } from "./automation";
import { loadEnabledMcpServers, closeMcpClients } from "./processor/mcp";
import { configureAuth, isAuthenticated } from "./auth";
import { createChildLogger } from './logger';

const log = createChildLogger({ component: 'server' });

// Parse CLI arguments
function getServerConfig() {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            host: {
                type: "string",
                short: "h",
                default: process.env.PIPALI_HOST || "127.0.0.1",
            },
            port: {
                type: "string",
                short: "p",
                default: process.env.PIPALI_PORT || "6464",
            },
            anon: {
                type: "boolean",
                default: process.env.PIPALI_ANON_MODE === "true",
            },
            "platform-url": {
                type: "string",
                default: process.env.PIPALI_PLATFORM_URL || "https://pipali.ai",
            },
            help: {
                type: "boolean",
                default: false,
            },
        },
        strict: true,
        allowPositionals: false,
    });

    if (values.help) {
        log.info(`
Pipali - Personal AI Assistant

Usage: pipali [options]

Options:
  -h, --host <host>        Host to bind to (default: 127.0.0.1, env: PIPALI_HOST)
  -p, --port <port>        Port to listen on (default: 6464, env: PIPALI_PORT)
      --anon               Skip platform authentication, use local API keys (env: PIPALI_ANON_MODE)
      --platform-url <url> Platform URL for authentication (env: PIPALI_PLATFORM_URL)
      --help               Show this help message

Examples:
  pipali                        # Start with platform authentication
  pipali --anon                 # Start without authentication (use local API keys)
  pipali -p 8080                # Start on 127.0.0.1:8080
  pipali --host 0.0.0.0         # Start on all interfaces
`);
        process.exit(0);
    }

    return {
        host: values.host as string,
        port: parseInt(values.port as string, 10),
        anon: values.anon as boolean,
        platformUrl: values["platform-url"] as string,
    };
}

async function runEmbeddedMigrations() {
    log.info("Running embedded migrations...");

    // Create migrations table if it doesn't exist
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
        )
    `);

    // Get already applied migrations
    const applied = await db.execute(sql`SELECT hash FROM "__drizzle_migrations"`);
    const appliedHashes = new Set((applied.rows as any[]).map(r => r.hash));

    // Run each migration that hasn't been applied
    for (const migration of EMBEDDED_MIGRATIONS) {
        const hash = migration.tag;

        if (appliedHashes.has(hash)) {
            log.info(`  ⏭️  Skipping ${hash} (already applied)`);
            continue;
        }

        log.info(`  🔄 Running migration: ${hash}`);

        // Split by the Drizzle breakpoint marker and execute each statement
        const statements = migration.sql.split('--> statement-breakpoint');

        for (const statement of statements) {
            const trimmed = statement.trim();
            if (trimmed) {
                await db.execute(sql.raw(trimmed));
            }
        }

        // Record the migration
        await db.execute(sql`
            INSERT INTO "__drizzle_migrations" (hash, created_at)
            VALUES (${hash}, ${Date.now()})
        `);

        log.info(`  ✅ Applied: ${hash}`);
    }

    log.info("Migrations complete.");
}

async function main() {
    // Parse CLI arguments
    const config = getServerConfig();

    // Configure auth module
    configureAuth({
        platformUrl: config.platformUrl,
        anonMode: config.anon,
    });

    // Run migrations - either embedded or from disk
    if (IS_COMPILED_BINARY) {
        await runEmbeddedMigrations();
    } else {
        await migrate(db, { migrationsFolder: getMigrationsFolder() });
    }

    // Initialize database (creates user, sets up models from env vars in anon mode)
    await initializeDatabase();

    // Check if already authenticated (before starting server)
    const alreadyAuthenticated = !config.anon && await isAuthenticated();
    if (alreadyAuthenticated) {
        log.info('🔐 Using existing platform authentication');
    } else if (config.anon) {
        log.info('🔓 Running in anonymous mode (using local API keys)');
    }

    // Load skills from global and local paths
    const skillResult = await loadSkills();
    if (skillResult.errors.length > 0) {
        for (const error of skillResult.errors) {
            log.warn(`⚠️  ${error.path}: ${error.message}`);
        }
    }
    if (skillResult.skills.length > 0) {
        log.info(`🎯 Loaded ${skillResult.skills.length} skill(s): ${skillResult.skills.map(s => s.name).join(', ')}`);
    }

    // Start automation system (cron scheduler, file watchers)
    await startAutomationSystem();

    // Load enabled MCP servers asynchronously to not block server startup
    loadEnabledMcpServers().catch(error => {
        log.warn(`⚠️ Failed to load MCP servers:`, error);
    });

    // Build frontend only in development mode (not when running as compiled binary)
    if (!IS_COMPILED_BINARY) {
        log.info("Building frontend...");
        await Bun.build({
            entrypoints: ["src/client/app.tsx"],
            outdir: "src/client/dist",
        });
        log.info("Frontend built.");
    } else {
        log.info("Running in compiled mode - using embedded assets.");
    }

  // Disable development mode (hot reload) in test mode or compiled binary
  // This prevents Bun from restarting the server when files change during tests
  const isDevelopmentMode = !IS_COMPILED_BINARY && process.env.PIPALI_TEST_MODE !== 'true';

  const server = Bun.serve<WebSocketData, any>({
    async fetch(req, server) {
        const url = new URL(req.url);
        log.info(`[${req.method}] ${url.pathname}`);

        // WebSocket
        if (url.pathname === "/ws/chat") {
            const success = server.upgrade(req, {
                data: {
                    // Initialize data if needed
                }
            });
            if (success) {
                return undefined;
            }
        }

        // API
        if (url.pathname.startsWith("/api")) {
            const res = await api.fetch(req, server);
            return res;
        }

        // Static and frontend routes
        const res = await app.fetch(req, server);
        return res;
    },
    websocket: websocketHandler,
    hostname: config.host,
    port: config.port,
    development: isDevelopmentMode,
  });

  log.info(`Server listening on http://${config.host}:${server.port}`);

  // Log auth status (authentication is now handled via the frontend login page)
  if (!config.anon && !alreadyAuthenticated) {
      log.info('🔐 Authentication required - sign in via the web interface');
      log.info(`   Platform: ${config.platformUrl}`);
  }

  // Graceful shutdown handlers to prevent database corruption
  const shutdown = async (signal: string) => {
    log.info(`\nReceived ${signal}, shutting down gracefully...`);
    server.stop();
    await stopAutomationSystem();
    await closeMcpClients();
    await closeDatabase();
    log.info('Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
