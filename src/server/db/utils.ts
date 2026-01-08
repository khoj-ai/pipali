function getDbName() {
    const defaultDbPath = `${process.cwd()}/pipali.db`;
    return process.env.POSTGRES_DB || defaultDbPath;
}

// Import PGlite WASM files to embed in binary
// @ts-ignore
import wasmFile from '../../../node_modules/@electric-sql/pglite/dist/pglite.wasm' with { type: 'file' };
// @ts-ignore
import dataFile from '../../../node_modules/@electric-sql/pglite/dist/pglite.data' with { type: 'file' };

async function getPGliteConfig() {
    const wasmModule = await WebAssembly.compile(await Bun.file(wasmFile).arrayBuffer());
    const fsBundle = Bun.file(dataFile);

    return {
        wasmModule,
        fsBundle,
    };
}

export { getDbName, getPGliteConfig };

