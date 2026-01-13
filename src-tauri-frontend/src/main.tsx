import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "@/app";
import { SidecarProvider } from "./sidecar-context";
import { setApiBaseUrl } from "@/utils/api";

interface SidecarConfig {
    host: string;
    port: number;
}

async function initApp() {
    // Get sidecar config from Tauri backend
    const config = await invoke<SidecarConfig>("get_sidecar_config");
    const SIDECAR_BASE_URL = `http://${config.host}:${config.port}`;
    const SIDECAR_WS_URL = `ws://${config.host}:${config.port}`;

    // Set the API base URL BEFORE rendering the app
    // This ensures all API calls use the sidecar URL from the start
    setApiBaseUrl(SIDECAR_BASE_URL);

    const container = document.getElementById("root");
    if (!container) {
        throw new Error("Root element not found");
    }

    const root = createRoot(container);
    root.render(
        <SidecarProvider baseUrl={SIDECAR_BASE_URL} wsBaseUrl={SIDECAR_WS_URL}>
            <App />
        </SidecarProvider>
    );
}

initApp().catch(console.error);
