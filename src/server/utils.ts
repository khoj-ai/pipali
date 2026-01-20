const maxIterations = parseInt(process.env.PIPALI_RESEARCH_ITERATIONS || '100', 10);

function getDefaultUser() {
    if (process.env.PIPALI_ADMIN_EMAIL && process.env.PIPALI_ADMIN_PASSWORD) {
        return {
            email: process.env.PIPALI_ADMIN_EMAIL,
            password: process.env.PIPALI_ADMIN_PASSWORD,
        };
    }
    return {
        email: 'admin@localhost',
        password: 'admin',
    };
}

function getMigrationsFolder(): string {
    // The migration folder from disk is only used in development mode.
    // In compiled mode, migrations are embedded, so this function is not used.
    return `${process.cwd()}/drizzle`;
}

export { getDefaultUser, getMigrationsFolder, maxIterations };