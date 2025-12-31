import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    plugins: [react()],
    root: ".",
    // Use relative paths for Tauri's file:// protocol
    base: "./",
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "../src/client"),
        },
    },
    define: {
        // Inject the sidecar port - configurable via environment
        "import.meta.env.VITE_SIDECAR_PORT": JSON.stringify(
            process.env.VITE_SIDECAR_PORT || "6464"
        ),
    },
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                  protocol: "ws",
                  host,
                  port: 5174,
              }
            : undefined,
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
    build: {
        outDir: "dist",
        target:
            process.env.TAURI_ENV_PLATFORM === "windows"
                ? "chrome105"
                : "safari13",
        minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
        rollupOptions: {
            input: {
                main: path.resolve(__dirname, "index.html"),
            },
        },
    },
    envPrefix: ["VITE_", "TAURI_ENV_"],
});
