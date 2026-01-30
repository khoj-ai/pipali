#!/usr/bin/env bun
/**
 * Build script for Tauri desktop application
 *
 * This script bundles Bun and UV runtimes with the server source code for
 * a "just works" experience for non-technical users. Instead of compiling
 * the server into a single-file executable (which would bundle Bun twice),
 * we ship the Bun runtime and use it to run the TypeScript server.
 *
 * This enables:
 * - Document creation skills to use bundled Bun (no manual install)
 * - Python scripts to use bundled UV (no manual install)
 * - Offline-capable document creation
 *
 * Usage: bun run scripts/build-tauri.ts [--platform=<platform>] [--debug] [--no-updater-artifacts]
 *
 * Platforms:
 *   - darwin-arm64 (macOS Apple Silicon)
 *   - darwin-x64 (macOS Intel)
 *   - linux-x64 (Linux x64)
 *   - linux-arm64 (Linux ARM64)
 *   - windows-x64 (Windows x64)
 */

import path from "path";
import fs from "fs/promises";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const TAURI_BINARIES_DIR = path.join(ROOT_DIR, "src-tauri", "binaries");
const TAURI_RESOURCES_DIR = path.join(ROOT_DIR, "src-tauri", "resources");

type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64";

// Map our platform names to Rust target triples (required by Tauri)
const TARGET_TRIPLE_MAP: Record<Platform, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "windows-x64": "x86_64-pc-windows-msvc",
};

// UV download URLs by platform
// Using latest stable release - check https://github.com/astral-sh/uv/releases for updates
const UV_VERSION = "0.5.24";
const UV_DOWNLOAD_MAP: Record<Platform, string> = {
    "darwin-arm64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
    "darwin-x64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-apple-darwin.tar.gz`,
    "linux-x64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`,
    "linux-arm64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz`,
    "windows-x64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
};

async function parseArgs(): Promise<{ platform: Platform; debug: boolean; disableUpdaterArtifacts: boolean }> {
    const args = process.argv.slice(2);
    let platform: Platform | undefined;
    let debug = false;
    let disableUpdaterArtifacts = false;

    for (const arg of args) {
        if (arg.startsWith("--platform=")) {
            platform = arg.split("=")[1] as Platform;
        }
        if (arg === "--debug") {
            debug = true;
        }
        if (arg === "--no-updater-artifacts") {
            disableUpdaterArtifacts = true;
        }
    }

    if (!platform) {
        // Detect current platform
        const arch = process.arch === "arm64" ? "arm64" : "x64";
        if (process.platform === "darwin") {
            platform = `darwin-${arch}` as Platform;
        } else if (process.platform === "linux") {
            platform = `linux-${arch}` as Platform;
        } else if (process.platform === "win32") {
            platform = "windows-x64";
        } else {
            throw new Error(`Unsupported platform: ${process.platform}`);
        }
    }

    return { platform, debug, disableUpdaterArtifacts };
}

/**
 * Download a file using curl (more reliable for GitHub releases)
 */
async function downloadWithCurl(url: string, outputPath: string): Promise<void> {
    const proc = Bun.spawn(["curl", "-fsSL", "-o", outputPath, url], {
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(`curl failed with exit code ${exitCode}`);
    }
}

/**
 * Download the Bun runtime binary for the target platform
 */
async function downloadBunRuntime(platform: Platform): Promise<string> {
    console.log(`📥 Downloading Bun runtime for ${platform}...`);

    const isWindows = platform.includes("windows");
    const bunVersion = Bun.version; // Use the same version as the build environment

    // Bun uses different naming for releases
    // Format: bun-<os>-<arch>.zip
    const bunPlatformMap: Record<Platform, string> = {
        "darwin-arm64": "darwin-aarch64",
        "darwin-x64": "darwin-x64",
        "linux-x64": "linux-x64",
        "linux-arm64": "linux-aarch64",
        "windows-x64": "windows-x64",
    };

    const bunPlatform = bunPlatformMap[platform];
    const downloadUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-${bunPlatform}.zip`;

    console.log(`   URL: ${downloadUrl}`);

    const tempDir = path.join(DIST_DIR, "_temp_bun");
    await fs.mkdir(tempDir, { recursive: true });

    const zipPath = path.join(tempDir, "bun.zip");

    // Download the zip using curl (more reliable for GitHub releases)
    try {
        await downloadWithCurl(downloadUrl, zipPath);
    } catch (err) {
        throw new Error(`Failed to download Bun from ${downloadUrl}: ${err}`);
    }

    // Extract using unzip
    const extractDir = path.join(tempDir, "extracted");
    await fs.mkdir(extractDir, { recursive: true });

    const unzipProc = Bun.spawn(["unzip", "-q", zipPath, "-d", extractDir], {
        cwd: tempDir,
        stdout: "inherit",
        stderr: "inherit",
    });
    await unzipProc.exited;

    // Find the bun binary in the extracted directory
    const bunBinaryName = isWindows ? "bun.exe" : "bun";
    const extractedFolder = path.join(extractDir, `bun-${bunPlatform}`);
    const bunBinaryPath = path.join(extractedFolder, bunBinaryName);

    // Verify the binary exists
    try {
        await fs.access(bunBinaryPath);
    } catch {
        throw new Error(`Bun binary not found at ${bunBinaryPath}`);
    }

    console.log(`✅ Downloaded Bun ${bunVersion}`);
    return bunBinaryPath;
}

/**
 * Download the UV runtime binary for the target platform
 */
async function downloadUvRuntime(platform: Platform): Promise<string> {
    console.log(`📥 Downloading UV runtime for ${platform}...`);

    const downloadUrl = UV_DOWNLOAD_MAP[platform];
    const isWindows = platform.includes("windows");

    console.log(`   URL: ${downloadUrl}`);

    const tempDir = path.join(DIST_DIR, "_temp_uv");
    await fs.mkdir(tempDir, { recursive: true });

    const archiveName = isWindows ? "uv.zip" : "uv.tar.gz";
    const archivePath = path.join(tempDir, archiveName);

    // Download the archive using curl
    try {
        await downloadWithCurl(downloadUrl, archivePath);
    } catch (err) {
        throw new Error(`Failed to download UV from ${downloadUrl}: ${err}`);
    }

    // Extract
    const extractDir = path.join(tempDir, "extracted");
    await fs.mkdir(extractDir, { recursive: true });

    if (isWindows) {
        const unzipProc = Bun.spawn(["unzip", "-q", archivePath, "-d", extractDir], {
            cwd: tempDir,
            stdout: "inherit",
            stderr: "inherit",
        });
        await unzipProc.exited;
    } else {
        const tarProc = Bun.spawn(["tar", "-xzf", archivePath, "-C", extractDir], {
            cwd: tempDir,
            stdout: "inherit",
            stderr: "inherit",
        });
        await tarProc.exited;
    }

    // Find the uv and uvx binaries
    const uvBinaryName = isWindows ? "uv.exe" : "uv";
    const uvxBinaryName = isWindows ? "uvx.exe" : "uvx";

    // UV extracts to a folder like uv-aarch64-apple-darwin/
    const entries = await fs.readdir(extractDir);
    let uvDir = extractDir;
    for (const entry of entries) {
        const entryPath = path.join(extractDir, entry);
        const stat = await fs.stat(entryPath);
        if (stat.isDirectory() && entry.startsWith("uv-")) {
            uvDir = entryPath;
            break;
        }
    }

    const uvBinaryPath = path.join(uvDir, uvBinaryName);
    const uvxBinaryPath = path.join(uvDir, uvxBinaryName);

    // Verify the binaries exist
    try {
        await fs.access(uvBinaryPath);
        await fs.access(uvxBinaryPath);
    } catch {
        throw new Error(`UV binaries not found at ${uvDir}`);
    }

    console.log(`✅ Downloaded UV ${UV_VERSION}`);
    return uvDir; // Return the directory containing both uv and uvx
}

/**
 * Copy runtime binaries to Tauri binaries directory with proper naming
 */
async function copyRuntimesToBinaries(
    platform: Platform,
    bunBinaryPath: string,
    uvDir: string
) {
    console.log("📦 Copying runtime binaries to Tauri binaries directory...");

    // Clean binaries directory to remove old compiled binaries (e.g., pipali-server-*)
    await fs.rm(TAURI_BINARIES_DIR, { recursive: true, force: true });
    await fs.mkdir(TAURI_BINARIES_DIR, { recursive: true });

    const targetTriple = TARGET_TRIPLE_MAP[platform];
    const isWindows = platform.includes("windows");
    const ext = isWindows ? ".exe" : "";

    // Copy Bun binary
    // Naming: bun-<target-triple> (Tauri convention for sidecars)
    const bunDestName = `bun-${targetTriple}${ext}`;
    const bunDestPath = path.join(TAURI_BINARIES_DIR, bunDestName);
    await fs.copyFile(bunBinaryPath, bunDestPath);
    if (!isWindows) {
        await fs.chmod(bunDestPath, 0o755);
    }
    console.log(`   ✅ bun -> ${bunDestName}`);

    // Copy UV binary
    const uvBinaryName = isWindows ? "uv.exe" : "uv";
    const uvDestName = `uv-${targetTriple}${ext}`;
    const uvDestPath = path.join(TAURI_BINARIES_DIR, uvDestName);
    await fs.copyFile(path.join(uvDir, uvBinaryName), uvDestPath);
    if (!isWindows) {
        await fs.chmod(uvDestPath, 0o755);
    }
    console.log(`   ✅ uv -> ${uvDestName}`);

    // Copy UVX binary
    const uvxBinaryName = isWindows ? "uvx.exe" : "uvx";
    const uvxDestName = `uvx-${targetTriple}${ext}`;
    const uvxDestPath = path.join(TAURI_BINARIES_DIR, uvxDestName);
    await fs.copyFile(path.join(uvDir, uvxBinaryName), uvxDestPath);
    if (!isWindows) {
        await fs.chmod(uvxDestPath, 0o755);
    }
    console.log(`   ✅ uvx -> ${uvxDestName}`);
}

/**
 * Build the server for Tauri bundling.
 *
 * We bundle the server into a single JS file and install only the external
 * dependencies that must remain on disk (native/wasm).
 */
async function buildServerBundle() {
    console.log("🔨 Building server bundle...");

    const serverResourceDir = path.join(TAURI_RESOURCES_DIR, "server");

    // Clean and create resources directory
    await fs.rm(serverResourceDir, { recursive: true, force: true });
    await fs.mkdir(serverResourceDir, { recursive: true });

    // Build frontend first (needed for embedded assets)
    console.log("   Building frontend...");
    const frontendResult = await Bun.build({
        entrypoints: ["src/client/app.tsx"],
        outdir: "src/client/dist",
        minify: true,
    });

    if (!frontendResult.success) {
        console.error("Frontend build failed:");
        for (const log of frontendResult.logs) {
            console.error(log);
        }
        throw new Error("Frontend build failed");
    }

    // Bundle CSS
    console.log("   Bundling CSS...");
    const cssResult = await Bun.build({
        entrypoints: ["src/client/styles/index.css"],
        outdir: "src/client/dist",
        minify: true,
    });

    if (!cssResult.success) {
        console.error("CSS build failed:");
        for (const log of cssResult.logs) {
            console.error(log);
        }
        throw new Error("CSS build failed");
    }

    // Bundle the server into a single JS file
    // This embeds all dependencies, making node_modules unnecessary
    console.log("   Bundling server code...");
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let serverResult: Awaited<ReturnType<typeof Bun.build>>;
    try {
        serverResult = await Bun.build({
            entrypoints: ["src/server/index.ts"],
            outdir: path.join(serverResourceDir, "dist"),
            target: "bun",
            minify: true,
            define: {
                "process.env.NODE_ENV": JSON.stringify("production"),
            },
            // Don't bundle native modules that need to be loaded at runtime
            external: [
                // PGlite uses native bindings
                "@electric-sql/pglite",
                // Sandbox runtime has native components
                "@anthropic-ai/sandbox-runtime",
            ],
        });
    } finally {
        if (originalNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalNodeEnv;
        }
    }

    if (!serverResult.success) {
        console.error("Server bundle failed:");
        for (const log of serverResult.logs) {
            console.error(log);
        }
        throw new Error("Server bundle failed");
    }

    // Copy drizzle migrations (needed at runtime)
    console.log("   Copying drizzle migrations...");
    await copyDir(
        path.join(ROOT_DIR, "drizzle"),
        path.join(serverResourceDir, "drizzle")
    );

    // Copy builtin skills (used at runtime)
    console.log("   Copying builtin skills...");
    await copyDir(
        path.join(ROOT_DIR, "src", "server", "skills", "builtin"),
        path.join(serverResourceDir, "skills", "builtin")
    );

    // Copy minimal frontend assets (index.html, public, dist)
    console.log("   Copying frontend assets...");
    const clientDest = path.join(serverResourceDir, "src", "client");
    await fs.mkdir(clientDest, { recursive: true });
    await fs.copyFile(
        path.join(ROOT_DIR, "src", "client", "index.html"),
        path.join(clientDest, "index.html")
    );
    await copyDir(
        path.join(ROOT_DIR, "src", "client", "public"),
        path.join(clientDest, "public"),
        new Set()
    );
    await copyDir(
        path.join(ROOT_DIR, "src", "client", "dist"),
        path.join(clientDest, "dist"),
        new Set()
    );
    const stylesDir = path.join(clientDest, "styles");
    await fs.mkdir(stylesDir, { recursive: true });
    await fs.copyFile(
        path.join(ROOT_DIR, "src", "client", "dist", "index.css"),
        path.join(stylesDir, "index.css")
    );

    // Create a minimal package.json with only the external dependencies
    const minimalPackageJson = {
        name: "pipali-server",
        type: "module",
        dependencies: {
            "@electric-sql/pglite": "^0.3.14",
            "@anthropic-ai/sandbox-runtime": "^0.0.26",
        },
    };
    await fs.writeFile(
        path.join(serverResourceDir, "package.json"),
        JSON.stringify(minimalPackageJson, null, 2)
    );

    // Install only the external dependencies (much smaller!)
    console.log("   Installing external dependencies...");
    const installProc = Bun.spawn(["bun", "install", "--production"], {
        cwd: serverResourceDir,
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await installProc.exited;
    if (exitCode !== 0) {
        throw new Error(`Failed to install dependencies: exit code ${exitCode}`);
    }

    // Copy PGlite WASM assets next to the bundled server
    console.log("   Copying PGlite assets...");
    const pgliteDist = path.join(serverResourceDir, "node_modules", "@electric-sql", "pglite", "dist");
    await fs.copyFile(
        path.join(pgliteDist, "pglite.wasm"),
        path.join(serverResourceDir, "dist", "pglite.wasm")
    );
    await fs.copyFile(
        path.join(pgliteDist, "pglite.data"),
        path.join(serverResourceDir, "dist", "pglite.data")
    );

    console.log("✅ Server bundle built successfully");
}

// Directories to skip when copying (platform is a separate service, not needed in desktop app)
const SKIP_DIRECTORIES = new Set([
    "node_modules",
    ".git",
    "dist",
    "platform", // Pipali Platform is a separate service
]);

/**
 * Recursively copy a directory
 */
async function copyDir(src: string, dest: string, skipDirs: Set<string> = SKIP_DIRECTORIES) {
    await fs.mkdir(dest, { recursive: true });

    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        // Skip unnecessary directories
        if (skipDirs.has(entry.name)) {
            continue;
        }

        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        } else {
            await fs.copyFile(srcPath, destPath);
        }
    }
}

/**
 * Clean up temporary download directories
 */
async function cleanupTemp() {
    console.log("🧹 Cleaning up temporary files...");
    await fs.rm(path.join(DIST_DIR, "_temp_bun"), { recursive: true, force: true });
    await fs.rm(path.join(DIST_DIR, "_temp_uv"), { recursive: true, force: true });
}

async function buildTauri(debug: boolean, platform: Platform, disableUpdaterArtifacts: boolean) {
    console.log(`🚀 Building Tauri app (${debug ? "debug" : "release"})...`);

    // Determine which bundles to build based on platform
    // macOS: app bundle only (DMG created separately via create-dmg for proper layout)
    // Windows: exe
    // Linux: deb and appimage
    let bundles: string[];
    if (platform.startsWith("darwin")) {
        bundles = ["app"];
    } else if (platform.startsWith("windows")) {
        bundles = ["nsis"];
    } else {
        bundles = ["deb", "appimage"];
    }

    const args = ["tauri", "build", "--bundles", bundles.join(",")];
    if (debug) {
        args.push("--debug");
    }
    if (disableUpdaterArtifacts) {
        args.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
    }

    const proc = Bun.spawn(["bunx", ...args], {
        cwd: ROOT_DIR,
        stdout: "inherit",
        stderr: "inherit",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(`Tauri build failed with exit code ${exitCode}`);
    }

    console.log("✅ Tauri app built successfully");
}

async function main() {
    const startTime = Date.now();
    const { platform, debug, disableUpdaterArtifacts } = await parseArgs();

    console.log("🍞 Pipali Tauri Desktop Build (Bundled Runtimes)");
    console.log("=".repeat(50));
    console.log(`Platform: ${platform}`);
    console.log(`Mode: ${debug ? "debug" : "release"}`);
    console.log(`Bun version: ${Bun.version}`);
    console.log(`UV version: ${UV_VERSION}`);
    console.log("=".repeat(50));

    // Ensure dist directory exists
    await fs.mkdir(DIST_DIR, { recursive: true });

    try {
        // Download runtimes
        const bunBinaryPath = await downloadBunRuntime(platform);
        const uvDir = await downloadUvRuntime(platform);

        // Copy runtimes to Tauri binaries
        await copyRuntimesToBinaries(platform, bunBinaryPath, uvDir);

        // Build server bundle (bundles code + installs minimal external deps)
        await buildServerBundle();

        // Build Tauri app
        await buildTauri(debug, platform, disableUpdaterArtifacts);
    } finally {
        await cleanupTemp();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("=".repeat(50));
    console.log(`✨ Build completed in ${elapsed}s`);
    console.log("");
    console.log("📝 The Tauri app bundle is in:");
    console.log(`   ${path.join(ROOT_DIR, "src-tauri", "target", debug ? "debug" : "release", "bundle")}`);
    console.log("");
    console.log("📦 Bundled runtimes:");
    console.log(`   - Bun ${Bun.version} (for server and TypeScript skills)`);
    console.log(`   - UV ${UV_VERSION} (for Python skills)`);
}

main().catch((err) => {
    console.error("❌ Build failed:", err);
    process.exit(1);
});
