import React from "react";
import { createRoot } from "react-dom/client";
import App from "@/app";
import { SidecarProvider } from "./sidecar-context";
import { setApiBaseUrl } from "@/utils/api";

// Get sidecar port from environment or use default
const SIDECAR_PORT = import.meta.env.VITE_SIDECAR_PORT || "6464";
const SIDECAR_BASE_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const SIDECAR_WS_URL = `ws://127.0.0.1:${SIDECAR_PORT}`;

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
