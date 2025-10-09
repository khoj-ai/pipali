function getDefaultUser() {
    if (process.env.PANINI_ADMIN_EMAIL && process.env.PANINI_ADMIN_PASSWORD) {
        return {
            email: process.env.PANINI_ADMIN_EMAIL,
            password: process.env.PANINI_ADMIN_PASSWORD,
        };
    }
    return {
        email: 'admin@localhost',
        password: 'admin',
    };
}

function getDbName() {
    return process.env.POSTGRES_DB || './local.db';
}

export { getDefaultUser, getDbName };