function getDefaultUser() {
    if (process.env.KHOJ_ADMIN_EMAIL && process.env.KHOJ_ADMIN_PASSWORD) {
        return {
            email: process.env.KHOJ_ADMIN_EMAIL,
            password: process.env.KHOJ_ADMIN_PASSWORD,
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