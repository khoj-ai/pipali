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
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const DB_PATH = "./pipali.db";
const DRIZZLE_DIR = "./drizzle";
const PG_RESETWAL = "/opt/homebrew/opt/libpq/bin/pg_resetwal";

async function main() {
    console.log("🔧 Starting database recovery...\n");

    // Step 1: Remove lock file
    console.log("1️⃣  Removing lock files...");
    await $`rm -f ${DB_PATH}/postmaster.pid`.quiet();
    console.log("   ✅ Lock files removed\n");

    // Step 2: Reset WAL
    console.log("2️⃣  Resetting WAL (Write-Ahead Log)...");
    const resetResult = await $`${PG_RESETWAL} -f ${DB_PATH}`.quiet();
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
