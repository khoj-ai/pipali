#!/usr/bin/env bun
/**
 * Build script for creating a TRUE single-file executable of Pipali
 *
 * This script:
 * 1. Builds the frontend (React app)
 * 2. Embeds all assets (migrations, frontend) into the source code
 * 3. Compiles everything into a single executable with no external dependencies
 *
 * Usage: bun run scripts/build.ts [--target=<platform>]
 *
 * Targets:
 *   - bun-darwin-arm64 (macOS Apple Silicon)
 *   - bun-darwin-x64 (macOS Intel)
 *   - bun-linux-x64 (Linux x64)
 *   - bun-linux-arm64 (Linux ARM64)
 *   - bun-windows-x64 (Windows x64)
 */

import path from "path";
import fs from "fs/promises";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const CLIENT_SRC = path.join(ROOT_DIR, "src/client");
const DRIZZLE_SRC = path.join(ROOT_DIR, "drizzle");
const BUILTIN_SKILLS_SRC = path.join(ROOT_DIR, "src/server/skills/builtin");
const EMBEDDED_ASSETS_PATH = path.join(ROOT_DIR, "src/server/embedded-assets.ts");
const EMBEDDED_ASSETS_BACKUP = path.join(ROOT_DIR, "src/server/embedded-assets.ts.bak");

type Target = "bun-darwin-arm64" | "bun-darwin-x64" | "bun-linux-x64" | "bun-linux-arm64" | "bun-windows-x64";

async function parseArgs(): Promise<{ target?: Target }> {
    const args = process.argv.slice(2);
    let target: Target | undefined;

    for (const arg of args) {
        if (arg.startsWith("--target=")) {
            target = arg.split("=")[1] as Target;
        }
    }

    return { target };
}

async function ensureDir(dir: string) {
    await fs.mkdir(dir, { recursive: true });
}

async function clean() {
    console.log("🧹 Cleaning dist directory...");
    await fs.rm(DIST_DIR, { recursive: true, force: true });
    await ensureDir(DIST_DIR);
}

async function buildFrontend(): Promise<{ appJs: string }> {
    console.log("🔨 Building frontend...");

    const tempOutDir = path.join(DIST_DIR, "_temp_frontend");
    await ensureDir(tempOutDir);

    // Build the React app with Bun
    const result = await Bun.build({
        entrypoints: [path.join(CLIENT_SRC, "app.tsx")],
        outdir: tempOutDir,
        minify: true,
        sourcemap: "none",
    });

    if (!result.success) {
        console.error("Frontend build failed:");
        for (const log of result.logs) {
            console.error(log);
        }
        process.exit(1);
    }

    // Read the built JS
    const appJs = await fs.readFile(path.join(tempOutDir, "app.js"), "utf-8");

    // Clean up temp dir
    await fs.rm(tempOutDir, { recursive: true, force: true });

    console.log("✅ Frontend built successfully");
    return { appJs };
}

async function bundleCss(): Promise<string> {
    console.log("🎨 Bundling CSS...");

    const tempOutDir = path.join(DIST_DIR, "_temp_css");
    await ensureDir(tempOutDir);

    // Use Bun's bundler to process CSS with @import resolution
    const result = await Bun.build({
        entrypoints: [path.join(CLIENT_SRC, "styles/index.css")],
        outdir: tempOutDir,
        minify: true,
    });

    if (!result.success) {
        console.error("CSS build failed:");
        for (const log of result.logs) {
            console.error(log);
        }
        process.exit(1);
    }

    // Read the bundled CSS
    const bundledCss = await fs.readFile(path.join(tempOutDir, "index.css"), "utf-8");

    // Clean up temp dir
    await fs.rm(tempOutDir, { recursive: true, force: true });

    console.log("✅ CSS bundled successfully");
    return bundledCss;
}

async function readMigrations(): Promise<{ migrations: { sql: string; tag: string }[] }> {
    console.log("📦 Reading database migrations...");

    const journalPath = path.join(DRIZZLE_SRC, "meta", "_journal.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));

    const migrations: { sql: string; tag: string }[] = [];

    for (const entry of journal.entries) {
        const sqlPath = path.join(DRIZZLE_SRC, `${entry.tag}.sql`);
        const sql = await fs.readFile(sqlPath, "utf-8");
        migrations.push({ sql, tag: entry.tag });
    }

    console.log(`✅ Read ${migrations.length} migration(s)`);
    return { migrations };
}

async function readIcons(): Promise<{ [key: string]: string }> {
    console.log("🎨 Reading icon assets...");

    const iconsDir = path.join(ROOT_DIR, "src/client/public", "icons");
    const icons: { [key: string]: string } = {};

    const files = await fs.readdir(iconsDir);
    for (const file of files) {
        if (file.endsWith('.png')) {
            const filePath = path.join(iconsDir, file);
            const buffer = await fs.readFile(filePath);
            icons[file] = buffer.toString('base64');
        }
    }

    console.log(`✅ Read ${Object.keys(icons).length} icon(s)`);
    return icons;
}

// Binary file extensions that should be base64 encoded
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.tar', '.gz']);

function isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

async function readBuiltinSkills(): Promise<{ [relativePath: string]: { content: string; binary: boolean } }> {
    console.log("📚 Reading builtin skills...");

    const skills: { [relativePath: string]: { content: string; binary: boolean } } = {};

    async function readDirRecursive(dir: string, baseDir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(baseDir, fullPath);

            if (entry.isDirectory()) {
                // Skip hidden directories
                if (!entry.name.startsWith('.')) {
                    await readDirRecursive(fullPath, baseDir);
                }
            } else if (entry.isFile()) {
                // Skip hidden files
                if (!entry.name.startsWith('.')) {
                    const binary = isBinaryFile(fullPath);
                    const buffer = await fs.readFile(fullPath);
                    skills[relativePath] = {
                        content: binary ? buffer.toString('base64') : buffer.toString('utf-8'),
                        binary,
                    };
                }
            }
        }
    }

    try {
        await readDirRecursive(BUILTIN_SKILLS_SRC, BUILTIN_SKILLS_SRC);
        console.log(`✅ Read ${Object.keys(skills).length} builtin skill file(s)`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            console.log("⚠️  No builtin skills directory found");
        } else {
            throw err;
        }
    }

    return skills;
}

function escapeForTemplate(str: string): string {
    // Escape backticks and ${} for template literals
    return str
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
}

async function generateEmbeddedAssets(
    migrations: { sql: string; tag: string }[],
    indexHtml: string,
    stylesCss: string,
    appJs: string,
    icons: { [key: string]: string },
    builtinSkills: { [path: string]: { content: string; binary: boolean } }
) {
    console.log("📝 Generating embedded assets module...");

    // Backup original file
    const original = await fs.readFile(EMBEDDED_ASSETS_PATH, "utf-8");
    await fs.writeFile(EMBEDDED_ASSETS_BACKUP, original);

    const migrationsArray = migrations.map(m =>
        `  { sql: \`${escapeForTemplate(m.sql)}\`, tag: "${m.tag}" }`
    ).join(",\n");

    const iconsObject = Object.entries(icons).map(([name, data]) =>
        `  "${name}": "${data}"`
    ).join(",\n");

    const builtinSkillsObject = Object.entries(builtinSkills).map(([filePath, { content, binary }]) => {
        // Normalize path separators to forward slashes (Windows uses backslashes which break JS strings)
        const normalizedPath = filePath.replace(/\\/g, '/');
        return `  "${normalizedPath}": { content: \`${escapeForTemplate(content)}\`, binary: ${binary} }`;
    }).join(",\n");

    const content = `/**
 * Embedded assets for single-file executable builds.
 * This file is auto-generated by scripts/build.ts during compilation.
 * DO NOT EDIT MANUALLY.
 */

export const EMBEDDED_MIGRATIONS: { sql: string; tag: string }[] = [
${migrationsArray}
];

export const EMBEDDED_INDEX_HTML = \`${escapeForTemplate(indexHtml)}\`;

export const EMBEDDED_STYLES_CSS = \`${escapeForTemplate(stylesCss)}\`;

export const EMBEDDED_APP_JS = \`${escapeForTemplate(appJs)}\`;

export const EMBEDDED_ICONS: { [key: string]: string } = {
${iconsObject}
};

export const EMBEDDED_BUILTIN_SKILLS: { [path: string]: { content: string; binary: boolean } } = {
${builtinSkillsObject}
};

export const IS_COMPILED_BINARY = true;
`;

    await fs.writeFile(EMBEDDED_ASSETS_PATH, content);
    console.log("✅ Embedded assets generated");
}

async function restoreEmbeddedAssets() {
    // Restore original placeholder file
    try {
        const backup = await fs.readFile(EMBEDDED_ASSETS_BACKUP, "utf-8");
        await fs.writeFile(EMBEDDED_ASSETS_PATH, backup);
        await fs.rm(EMBEDDED_ASSETS_BACKUP, { force: true });
    } catch {
        // Backup doesn't exist, create fresh placeholder
        const placeholder = `/**
 * Embedded assets for single-file executable builds.
 * This file is auto-generated by scripts/build.ts during compilation.
 * DO NOT EDIT MANUALLY.
 *
 * In development mode, assets are served from disk.
 * In compiled mode, assets are served from these embedded strings.
 */

// Placeholder - this file is regenerated during build
export const EMBEDDED_MIGRATIONS: { sql: string; tag: string }[] = [];
export const EMBEDDED_INDEX_HTML = "";
export const EMBEDDED_STYLES_CSS = "";
export const EMBEDDED_APP_JS = "";

// Icon assets (base64 encoded)
export const EMBEDDED_ICONS: { [key: string]: string } = {};

// Builtin skills (path -> content, binary files are base64 encoded)
export const EMBEDDED_BUILTIN_SKILLS: { [path: string]: { content: string; binary: boolean } } = {};

// Flag to check if assets are embedded (set to true during build)
export const IS_COMPILED_BINARY = false;
`;
        await fs.writeFile(EMBEDDED_ASSETS_PATH, placeholder);
    }
}

async function compile(target?: Target) {
    console.log(`🚀 Compiling single-file executable${target ? ` for ${target}` : ""}...`);

    const outputName = target
        ? `pipali-${target.replace("bun-", "")}${target.includes("windows") ? ".exe" : ""}`
        : `pipali${process.platform === "win32" ? ".exe" : ""}`;

    const outputPath = path.join(DIST_DIR, outputName);
    const entrypoint = path.join(ROOT_DIR, "src/server/index.ts");

    const args = [
        "build",
        "--compile",
        entrypoint,
        "--outfile",
        outputPath,
    ];

    if (target) {
        args.push("--target", target);
    }

    // Run bun build --compile
    const proc = Bun.spawn(["bun", ...args], {
        cwd: ROOT_DIR,
        stdout: "inherit",
        stderr: "inherit",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        console.error(`❌ Compilation failed with exit code ${exitCode}`);
        process.exit(exitCode);
    }

    console.log(`✅ Compiled to: ${outputPath}`);

    // Get file size
    const stat = await fs.stat(outputPath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(`📊 Executable size: ${sizeMB} MB`);
}

async function main() {
    const startTime = Date.now();
    const { target } = await parseArgs();

    console.log("🍞 Pipali Single-File Build Script");
    console.log("=".repeat(40));

    try {
        await clean();

        // Build frontend and read assets
        const { appJs } = await buildFrontend();
        const stylesCss = await bundleCss();
        const { migrations } = await readMigrations();
        const icons = await readIcons();
        const builtinSkills = await readBuiltinSkills();
        const indexHtml = await fs.readFile(path.join(CLIENT_SRC, "index.html"), "utf-8");

        // Generate embedded assets module
        await generateEmbeddedAssets(migrations, indexHtml, stylesCss, appJs, icons, builtinSkills);

        // Compile
        await compile(target);

    } finally {
        // Always restore the placeholder file
        await restoreEmbeddedAssets();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log("=".repeat(40));
    console.log(`✨ Build completed in ${elapsed}s`);
    console.log("");
    console.log("📝 To run the compiled app:");
    console.log(`   ${path.join(DIST_DIR, "pipali")}`);
    console.log("");
    console.log("🎉 This is a TRUE single-file executable!");
    console.log("   No additional files or folders required.");
}

main().catch(async (err) => {
    await restoreEmbeddedAssets();
    console.error("Build failed:", err);
    process.exit(1);
});

