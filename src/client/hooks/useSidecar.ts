import { createContext, useContext } from "react";

interface SidecarConfig {
    baseUrl: string;
    wsBaseUrl: string;
}

// Context that can be provided by Tauri frontend or left null for web mode
export const SidecarContext = createContext<SidecarConfig | null>(null);

/**
 * Hook to get the sidecar configuration (base URLs for API and WebSocket).
 *
 * When running in Tauri desktop app, this returns the configured sidecar URLs.
 * When running in web browser mode, this falls back to using window.location.
 */
export function useSidecar(): SidecarConfig {
    const context = useContext(SidecarContext);
    if (context) {
        return context;
    }

    // Fallback for web browser mode - use relative URLs
    return {
        baseUrl: "",
        wsBaseUrl: `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`,
    };
}
