/**
 * Path validation utilities for detecting sensitive file paths.
 * Used to request user confirmation before accessing sensitive files.
 */

import path from 'path';
import os from 'os';

/**
 * Patterns that match sensitive file paths requiring user confirmation.
 * Includes SSH keys, credentials, system configs, etc.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
    // System directories
    /^\/etc\//,
    /^\/var\/log\//,
    /^\/private\/etc\//,  // macOS
    /^\/private\/var\//,  // macOS

    // SSH and security keys
    /[\/\\]\.ssh[\/\\]/,
    /[\/\\]\.ssh$/,
    /[\/\\]\.gnupg[\/\\]/,
    /[\/\\]\.gnupg$/,
    /[\/\\]\.gpg[\/\\]/,

    // Cloud credentials
    /[\/\\]\.aws[\/\\]/,
    /[\/\\]\.aws$/,
    /[\/\\]\.azure[\/\\]/,
    /[\/\\]\.gcloud[\/\\]/,
    /[\/\\]\.config\/gcloud[\/\\]/,

    // Package manager credentials
    /[\/\\]\.npmrc$/,
    /[\/\\]\.yarnrc$/,
    /[\/\\]\.pypirc$/,
    /[\/\\]\.netrc$/,
    /[\/\\]\.docker[\/\\]config\.json$/,

    // Environment files (may contain secrets)
    /[\/\\]\.env$/,
    /[\/\\]\.env\.[a-zA-Z]+$/,  // .env.local, .env.production, etc.

    // Keychain and credential stores
    /[\/\\]\.password-store[\/\\]/,
    /[\/\\]\.local\/share\/keyrings[\/\\]/,

    // Browser data
    /[\/\\]\.mozilla[\/\\]/,
    /[\/\\]\.config\/google-chrome[\/\\]/,
    /[\/\\]\.config\/chromium[\/\\]/,

    // Shell history (may contain secrets)
    /[\/\\]\.bash_history$/,
    /[\/\\]\.zsh_history$/,
    /[\/\\]\.history$/,
];

/**
 * Check if a file path is considered sensitive and should require user confirmation.
 *
 * @param filePath - The file path to check (absolute or relative)
 * @returns true if the path matches sensitive patterns
 */
export function isSensitivePath(filePath: string): boolean {
    // Normalize the path for consistent matching
    const normalizedPath = path.normalize(filePath);

    // Expand ~ to home directory for matching
    const expandedPath = normalizedPath.startsWith('~/')
        ? path.join(os.homedir(), normalizedPath.slice(2))
        : normalizedPath === '~'
            ? os.homedir()
            : normalizedPath;

    // Check against all sensitive patterns
    return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(expandedPath));
}

/**
 * Get a human-readable description of why a path is sensitive.
 *
 * @param filePath - The file path to describe
 * @returns Description of the sensitive path type, or null if not sensitive
 */
export function getSensitivePathReason(filePath: string): string | null {
    const normalizedPath = path.normalize(filePath);
    const expandedPath = normalizedPath.startsWith('~/')
        ? path.join(os.homedir(), normalizedPath.slice(2))
        : normalizedPath;

    if (/[\/\\]\.ssh[\/\\]|[\/\\]\.ssh$/.test(expandedPath)) {
        return 'SSH keys and configuration';
    }
    if (/[\/\\]\.gnupg[\/\\]|[\/\\]\.gnupg$|[\/\\]\.gpg[\/\\]/.test(expandedPath)) {
        return 'GPG keys and configuration';
    }
    if (/[\/\\]\.aws[\/\\]|[\/\\]\.aws$/.test(expandedPath)) {
        return 'AWS credentials and configuration';
    }
    if (/[\/\\]\.azure[\/\\]/.test(expandedPath)) {
        return 'Azure credentials';
    }
    if (/[\/\\]\.gcloud[\/\\]|[\/\\]\.config\/gcloud[\/\\]/.test(expandedPath)) {
        return 'Google Cloud credentials';
    }
    if (/^\/etc\/|^\/private\/etc\//.test(expandedPath)) {
        return 'system configuration files';
    }
    if (/^\/var\/log\/|^\/private\/var\//.test(expandedPath)) {
        return 'system log files';
    }
    if (/[\/\\]\.npmrc$|[\/\\]\.yarnrc$|[\/\\]\.pypirc$/.test(expandedPath)) {
        return 'package manager credentials';
    }
    if (/[\/\\]\.netrc$/.test(expandedPath)) {
        return 'network credentials (.netrc)';
    }
    if (/[\/\\]\.docker[\/\\]config\.json$/.test(expandedPath)) {
        return 'Docker registry credentials';
    }
    if (/[\/\\]\.env$|[\/\\]\.env\.[a-zA-Z]+$/.test(expandedPath)) {
        return 'environment variables (may contain secrets)';
    }
    if (/[\/\\]\.password-store[\/\\]/.test(expandedPath)) {
        return 'password store';
    }
    if (/[\/\\]\.bash_history$|[\/\\]\.zsh_history$|[\/\\]\.history$/.test(expandedPath)) {
        return 'shell history (may contain secrets)';
    }
    if (/[\/\\]\.mozilla[\/\\]|[\/\\]\.config\/google-chrome[\/\\]|[\/\\]\.config\/chromium[\/\\]/.test(expandedPath)) {
        return 'browser data';
    }

    return null;
}
