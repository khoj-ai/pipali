import { ReactNode } from "react";
// Import the shared context from the client hooks - this is the same context
// that useSidecar() reads from in app.tsx
import { SidecarContext } from "@/hooks/useSidecar";

/**
 * Provider that wraps the app and supplies sidecar configuration.
 * This uses the shared SidecarContext so that useSidecar() in app.tsx
 * can read the values.
 */
export function SidecarProvider({
    baseUrl,
    wsBaseUrl,
    children,
}: {
    baseUrl: string;
    wsBaseUrl: string;
    children: ReactNode;
}) {
    return (
        <SidecarContext.Provider value={{ baseUrl, wsBaseUrl }}>
            {children}
        </SidecarContext.Provider>
    );
}
