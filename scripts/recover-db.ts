#!/usr/bin/env bun
/**
 * Database Recovery Script
 * 
 * Recovers a corrupted PGlite database by:
 * 1. Removing stale lock files
 * 2. Resetting the WAL (Write-Ahead Log) using pg_resetwal
 * 3. Marking all migrations as applied
 * 
 * Usage: bun run scripts/recover-db.ts
 */

import { $ } from "bun";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDbName } from "../src/server/db/utils";

const DB_PATH = getDbName();
const DRIZZLE_DIR = "./drizzle";

/**
 * Get the pg_resetwal path that matches the database's PostgreSQL version.
 * PGlite creates databases with a specific PostgreSQL version, and pg_resetwal
 * must match that version exactly.
 */
async function getPgResetwalPath(): Promise<string> {
    // Read the PostgreSQL version from the database's PG_VERSION file
    const pgVersionFile = join(DB_PATH, "PG_VERSION");
    let pgMajorVersion: string;

    try {
        const versionContent = await readFile(pgVersionFile, "utf-8");
        pgMajorVersion = versionContent.trim();
    } catch {
        throw new Error(`Could not read PG_VERSION file at ${pgVersionFile}. Is the database initialized?`);
    }

    // Try common installation paths for pg_resetwal
    const possiblePaths = [
        // Homebrew Cellar (versioned) - macOS
        `/opt/homebrew/Cellar/libpq/${pgMajorVersion}.*/bin/pg_resetwal`,
        `/opt/homebrew/Cellar/postgresql@${pgMajorVersion}/*/bin/pg_resetwal`,
        // Homebrew opt (symlinked) - might not match version
        `/opt/homebrew/opt/libpq/bin/pg_resetwal`,
        `/opt/homebrew/opt/postgresql@${pgMajorVersion}/bin/pg_resetwal`,
        // Linux common paths
        `/usr/lib/postgresql/${pgMajorVersion}/bin/pg_resetwal`,
        `/usr/pgsql-${pgMajorVersion}/bin/pg_resetwal`,
        // Generic PATH lookup
        `pg_resetwal`,
    ];

    for (const pathPattern of possiblePaths) {
        try {
            // Use bash -c for proper glob expansion (Bun's $ doesn't expand globs)
            const result = await $`bash -c ${"ls " + pathPattern + " 2>/dev/null"}`.quiet();
            if (result.exitCode === 0) {
                const foundPath = result.stdout.toString().trim().split("\n")[0];
                if (foundPath) {
                    // Verify version matches
                    const versionCheck = await $`${foundPath} --version`.quiet();
                    const versionOutput = versionCheck.stdout.toString();
                    if (versionOutput.includes(`(PostgreSQL) ${pgMajorVersion}`)) {
                        return foundPath;
                    }
                }
            }
        } catch {
            // Continue to next path
        }
    }

    throw new Error(
        `Could not find pg_resetwal for PostgreSQL ${pgMajorVersion}. ` +
        `Please install it with: brew install postgresql@${pgMajorVersion}`
    );
}

async function main() {
    console.log("🔧 Starting database recovery...\n");

    // Step 1: Remove lock file
    console.log("1️⃣  Removing lock files...");
    await $`rm -f ${DB_PATH}/postmaster.pid`.quiet();
    console.log("   ✅ Lock files removed\n");

    // Step 2: Reset WAL
    console.log("2️⃣  Resetting WAL (Write-Ahead Log)...");
    const pgResetwalPath = await getPgResetwalPath();
    console.log(`   Using: ${pgResetwalPath}`);
    const resetResult = await $`${pgResetwalPath} -f ${DB_PATH}`.quiet();
    if (resetResult.exitCode !== 0) {
        console.error("   ❌ Failed to reset WAL:", resetResult.stderr.toString());
        process.exit(1);
    }
    console.log("   ✅ WAL reset complete\n");

    // Step 3: Get all migrations from drizzle folder
    console.log("3️⃣  Marking migrations as applied...");
    const files = await readdir(DRIZZLE_DIR);
    const migrations = files
        .filter(f => f.endsWith(".sql"))
        .map(f => f.replace(".sql", ""))
        .sort();

    if (migrations.length === 0) {
        console.error("   ❌ No migrations found in", DRIZZLE_DIR);
        process.exit(1);
    }

    // Step 4: Open database and mark migrations as applied
    const db = await PGlite.create(DB_PATH);
    
    await db.query("DELETE FROM __drizzle_migrations");
    
    for (const hash of migrations) {
        await db.query(
            "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ($1, $2)",
            [hash, Date.now()]
        );
        console.log(`   ✅ ${hash}`);
    }

    await db.close();

    console.log(`\n🎉 Database recovered! ${migrations.length} migrations marked as applied.`);
}

main().catch((error) => {
    console.error("❌ Recovery failed:", error.message);
    process.exit(1);
});
