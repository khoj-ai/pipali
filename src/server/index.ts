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

// Parse CLI arguments
function getServerConfig() {
    const { values } = parseArgs({
        args: Bun.argv.slice(2),
        options: {
            host: {
                type: "string",
                short: "h",
                default: process.env.PANINI_HOST || "127.0.0.1",
            },
            port: {
                type: "string",
                short: "p",
                default: process.env.PANINI_PORT || "6464",
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
        console.log(`
Panini - Personal AI Assistant

Usage: panini [options]

Options:
  -h, --host <host>    Host to bind to (default: 127.0.0.1, env: PANINI_HOST)
  -p, --port <port>    Port to listen on (default: 6464, env: PANINI_PORT)
      --help           Show this help message

Examples:
  panini                        # Start on 127.0.0.1:6464
  panini -p 8080                # Start on 127.0.0.1:8080
  panini --host 0.0.0.0         # Start on all interfaces
  panini -h 0.0.0.0 -p 8080     # Start on 0.0.0.0:8080
`);
        process.exit(0);
    }

    return {
        host: values.host as string,
        port: parseInt(values.port as string, 10),
    };
}

async function runEmbeddedMigrations() {
    console.log("Running embedded migrations...");

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
            console.log(`  ⏭️  Skipping ${hash} (already applied)`);
            continue;
        }

        console.log(`  🔄 Running migration: ${hash}`);

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

        console.log(`  ✅ Applied: ${hash}`);
    }

    console.log("Migrations complete.");
}

async function main() {
    // Parse CLI arguments
    const config = getServerConfig();

    // Run migrations - either embedded or from disk
    if (IS_COMPILED_BINARY) {
        await runEmbeddedMigrations();
    } else {
        await migrate(db, { migrationsFolder: getMigrationsFolder() });
    }

    await initializeDatabase();

    // Load skills from global and local paths
    const skillResult = await loadSkills();
    if (skillResult.errors.length > 0) {
        for (const error of skillResult.errors) {
            console.warn(`[Skills] ⚠️  ${error.path}: ${error.message}`);
        }
    }
    if (skillResult.skills.length > 0) {
        console.log(`🎯 Loaded ${skillResult.skills.length} skill(s): ${skillResult.skills.map(s => s.name).join(', ')}`);
    }

    // Start automation system (cron scheduler, file watchers)
    await startAutomationSystem();

    // Load enabled MCP servers asynchronously to not block server startup
    loadEnabledMcpServers().catch(error => {
        console.warn(`[MCP] ⚠️ Failed to load MCP servers:`, error);
    });

    // Build frontend only in development mode (not when running as compiled binary)
    if (!IS_COMPILED_BINARY) {
        console.log("Building frontend...");
        await Bun.build({
            entrypoints: ["src/client/app.tsx"],
            outdir: "src/client/dist",
        });
        console.log("Frontend built.");
    } else {
        console.log("Running in compiled mode - using embedded assets.");
    }

  // Disable development mode (hot reload) in test mode or compiled binary
  // This prevents Bun from restarting the server when files change during tests
  const isDevelopmentMode = !IS_COMPILED_BINARY && process.env.PANINI_TEST_MODE !== 'true';

  const server = Bun.serve<WebSocketData, any>({
    async fetch(req, server) {
        const url = new URL(req.url);
        console.log(`[${req.method}] ${url.pathname}`);

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

  console.log(`Server listening on http://${config.host}:${server.port}`);

  // Graceful shutdown handlers to prevent database corruption
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}, shutting down gracefully...`);
    server.stop();
    stopAutomationSystem();
    await closeMcpClients();
    await closeDatabase();
    console.log('[Server] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
