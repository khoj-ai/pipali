import { migrate } from "drizzle-orm/pglite/migrator";
import { db } from "./db";
import app from "./routes";
import api from "./routes/api";
import { initializeDatabase } from "./init";
import { getMigrationsFolder } from "./utils";
import { websocketHandler, type WebSocketData } from "./routes/ws";

async function main() {
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  await initializeDatabase();

  // Build frontend
  console.log("Building frontend...");
  await Bun.build({
    entrypoints: ["src/client/app.tsx"],
    outdir: "src/client/dist",
  });
  console.log("Frontend built.");

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
    port: 3000,
    development: true,
  });

  console.log(`Server listening on http://localhost:${server.port}`);
}

main();
