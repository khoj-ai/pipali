#!/usr/bin/env bun
/**
 * Build script for Tauri desktop application
 *
 * This script:
 * 1. Builds the Panini sidecar executable for the target platform
 * 2. Copies it to src-tauri/binaries with proper Rust target triple naming
 * 3. Invokes the Tauri build process
 *
 * Usage: bun run scripts/build-tauri.ts [--platform=<platform>] [--debug]
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

type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64";

// Map our platform names to Rust target triples (required by Tauri)
const TARGET_TRIPLE_MAP: Record<Platform, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "windows-x64": "x86_64-pc-windows-msvc",
};

async function parseArgs(): Promise<{ platform: Platform; debug: boolean }> {
    const args = process.argv.slice(2);
    let platform: Platform | undefined;
    let debug = false;

    for (const arg of args) {
        if (arg.startsWith("--platform=")) {
            platform = arg.split("=")[1] as Platform;
        }
        if (arg === "--debug") {
            debug = true;
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

    return { platform, debug };
}

async function buildSidecar(platform: Platform) {
    console.log(`🔨 Building sidecar for ${platform}...`);

    const bunTarget = `bun-${platform}`;
    const proc = Bun.spawn(["bun", "run", "build", `--target=${bunTarget}`], {
        cwd: ROOT_DIR,
        stdout: "inherit",
        stderr: "inherit",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(`Sidecar build failed with exit code ${exitCode}`);
    }

    console.log("✅ Sidecar built successfully");
}

async function copySidecarToBinaries(platform: Platform) {
    console.log("📦 Copying sidecar to Tauri binaries directory...");

    await fs.mkdir(TAURI_BINARIES_DIR, { recursive: true });

    const targetTriple = TARGET_TRIPLE_MAP[platform];
    const sourceExt = platform.includes("windows") ? ".exe" : "";
    const sourceName = `panini-${platform}${sourceExt}`;
    // Sidecar named "panini-server" to avoid conflict with Cargo package name "panini"
    const destName = `panini-server-${targetTriple}${sourceExt}`;

    const sourcePath = path.join(DIST_DIR, sourceName);
    const destPath = path.join(TAURI_BINARIES_DIR, destName);

    await fs.copyFile(sourcePath, destPath);

    // Make executable on Unix
    if (!platform.includes("windows")) {
        await fs.chmod(destPath, 0o755);
    }

    console.log(`✅ Copied ${sourceName} -> ${destName}`);
}

async function buildTauri(debug: boolean, platform: Platform) {
    console.log(`🚀 Building Tauri app (${debug ? "debug" : "release"})...`);

    // Determine which bundles to build based on platform
    // macOS: app bundle only (skip dmg which requires additional setup)
    // Windows: msi and exe
    // Linux: deb and appimage
    let bundles: string[];
    if (platform.startsWith("darwin")) {
        bundles = ["app"];
    } else if (platform.startsWith("windows")) {
        bundles = ["msi", "nsis"];
    } else {
        bundles = ["deb", "appimage"];
    }

    const args = ["tauri", "build", "--bundles", bundles.join(",")];
    if (debug) {
        args.push("--debug");
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
    const { platform, debug } = await parseArgs();

    console.log("🍞 Panini Tauri Desktop Build");
    console.log("=".repeat(50));
    console.log(`Platform: ${platform}`);
    console.log(`Mode: ${debug ? "debug" : "release"}`);
    console.log("=".repeat(50));

    await buildSidecar(platform);
    await copySidecarToBinaries(platform);
    await buildTauri(debug, platform);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("=".repeat(50));
    console.log(`✨ Build completed in ${elapsed}s`);
    console.log("");
    console.log("📝 The Tauri app bundle is in:");
    console.log(`   ${path.join(ROOT_DIR, "src-tauri", "target", debug ? "debug" : "release", "bundle")}`);
}

main().catch((err) => {
    console.error("❌ Build failed:", err);
    process.exit(1);
});
