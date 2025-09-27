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

export { getDefaultUser };