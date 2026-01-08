import { test, expect, describe } from 'bun:test';
import { isSensitivePath, getSensitivePathReason } from '../../../src/server/security/path-validator';

describe('isSensitivePath', () => {
    describe('SSH and GPG paths', () => {
        test('should detect .ssh directory', () => {
            expect(isSensitivePath('/home/user/.ssh')).toBe(true);
            expect(isSensitivePath('/home/user/.ssh/')).toBe(true);
            expect(isSensitivePath('/home/user/.ssh/id_rsa')).toBe(true);
            expect(isSensitivePath('/home/user/.ssh/authorized_keys')).toBe(true);
            expect(isSensitivePath('/Users/test/.ssh/config')).toBe(true);
        });

        test('should detect .ssh with tilde expansion', () => {
            expect(isSensitivePath('~/.ssh')).toBe(true);
            expect(isSensitivePath('~/.ssh/id_rsa')).toBe(true);
        });

        test('should detect .gnupg directory', () => {
            expect(isSensitivePath('/home/user/.gnupg')).toBe(true);
            expect(isSensitivePath('/home/user/.gnupg/')).toBe(true);
            expect(isSensitivePath('/home/user/.gnupg/private-keys-v1.d')).toBe(true);
        });

        test('should detect .gpg directory', () => {
            expect(isSensitivePath('/home/user/.gpg/trustdb.gpg')).toBe(true);
        });
    });

    describe('Cloud credentials', () => {
        test('should detect AWS credentials', () => {
            expect(isSensitivePath('/home/user/.aws')).toBe(true);
            expect(isSensitivePath('/home/user/.aws/')).toBe(true);
            expect(isSensitivePath('/home/user/.aws/credentials')).toBe(true);
            expect(isSensitivePath('/home/user/.aws/config')).toBe(true);
            expect(isSensitivePath('~/.aws/credentials')).toBe(true);
        });

        test('should detect Azure credentials', () => {
            expect(isSensitivePath('/home/user/.azure/credentials')).toBe(true);
            expect(isSensitivePath('/home/user/.azure/')).toBe(true);
        });

        test('should detect Google Cloud credentials', () => {
            expect(isSensitivePath('/home/user/.gcloud/credentials')).toBe(true);
            expect(isSensitivePath('/home/user/.config/gcloud/credentials.json')).toBe(true);
        });
    });

    describe('Package manager credentials', () => {
        test('should detect .npmrc', () => {
            expect(isSensitivePath('/home/user/.npmrc')).toBe(true);
            expect(isSensitivePath('~/.npmrc')).toBe(true);
        });

        test('should detect .yarnrc', () => {
            expect(isSensitivePath('/home/user/.yarnrc')).toBe(true);
        });

        test('should detect .pypirc', () => {
            expect(isSensitivePath('/home/user/.pypirc')).toBe(true);
        });

        test('should detect .netrc', () => {
            expect(isSensitivePath('/home/user/.netrc')).toBe(true);
        });

        test('should detect Docker config', () => {
            expect(isSensitivePath('/home/user/.docker/config.json')).toBe(true);
        });
    });

    describe('Environment files', () => {
        test('should detect .env files', () => {
            expect(isSensitivePath('/project/.env')).toBe(true);
            expect(isSensitivePath('/project/.env.local')).toBe(true);
            expect(isSensitivePath('/project/.env.production')).toBe(true);
            expect(isSensitivePath('/project/.env.development')).toBe(true);
        });

        test('should not match partial .env in path', () => {
            // .env.backup would match but .envrc would not (no dot before envrc)
            expect(isSensitivePath('/project/environment')).toBe(false);
        });
    });

    describe('System paths', () => {
        test('should detect /etc paths', () => {
            expect(isSensitivePath('/etc/passwd')).toBe(true);
            expect(isSensitivePath('/etc/shadow')).toBe(true);
            expect(isSensitivePath('/etc/ssh/sshd_config')).toBe(true);
        });

        test('should detect /var/log paths', () => {
            expect(isSensitivePath('/var/log/auth.log')).toBe(true);
            expect(isSensitivePath('/var/log/syslog')).toBe(true);
        });

        test('should detect macOS system paths', () => {
            expect(isSensitivePath('/private/etc/hosts')).toBe(true);
            expect(isSensitivePath('/private/var/log/system.log')).toBe(true);
        });
    });

    describe('Shell history', () => {
        test('should detect bash history', () => {
            expect(isSensitivePath('/home/user/.bash_history')).toBe(true);
        });

        test('should detect zsh history', () => {
            expect(isSensitivePath('/home/user/.zsh_history')).toBe(true);
        });

        test('should detect generic history', () => {
            expect(isSensitivePath('/home/user/.history')).toBe(true);
        });
    });

    describe('Browser data', () => {
        test('should detect Firefox profiles', () => {
            expect(isSensitivePath('/home/user/.mozilla/firefox/profile')).toBe(true);
        });

        test('should detect Chrome data', () => {
            expect(isSensitivePath('/home/user/.config/google-chrome/Default')).toBe(true);
        });

        test('should detect Chromium data', () => {
            expect(isSensitivePath('/home/user/.config/chromium/Default')).toBe(true);
        });
    });

    describe('Non-sensitive paths', () => {
        test('should not flag normal project files', () => {
            expect(isSensitivePath('/home/user/projects/app/src/index.ts')).toBe(false);
            expect(isSensitivePath('/Users/dev/code/README.md')).toBe(false);
        });

        test('should not flag directories with similar names', () => {
            expect(isSensitivePath('/home/user/ssh-tutorial')).toBe(false);
            expect(isSensitivePath('/home/user/my-aws-app')).toBe(false);
        });

        test('should not flag regular config files', () => {
            expect(isSensitivePath('/home/user/.config/app/settings.json')).toBe(false);
            expect(isSensitivePath('/home/user/.vscode/settings.json')).toBe(false);
        });
    });

    describe('Windows-style paths', () => {
        test('should detect sensitive paths with backslashes', () => {
            expect(isSensitivePath('C:\\Users\\user\\.ssh\\id_rsa')).toBe(true);
            expect(isSensitivePath('C:\\Users\\user\\.aws\\credentials')).toBe(true);
        });
    });
});

describe('getSensitivePathReason', () => {
    test('should return reason for SSH paths', () => {
        expect(getSensitivePathReason('/home/user/.ssh/id_rsa')).toBe('SSH keys and configuration');
    });

    test('should return reason for GPG paths', () => {
        expect(getSensitivePathReason('/home/user/.gnupg/keys')).toBe('GPG keys and configuration');
    });

    test('should return reason for AWS paths', () => {
        expect(getSensitivePathReason('/home/user/.aws/credentials')).toBe('AWS credentials and configuration');
    });

    test('should return reason for Azure paths', () => {
        expect(getSensitivePathReason('/home/user/.azure/config')).toBe('Azure credentials');
    });

    test('should return reason for GCloud paths', () => {
        expect(getSensitivePathReason('/home/user/.gcloud/credentials')).toBe('Google Cloud credentials');
        expect(getSensitivePathReason('/home/user/.config/gcloud/creds')).toBe('Google Cloud credentials');
    });

    test('should return reason for system paths', () => {
        expect(getSensitivePathReason('/etc/passwd')).toBe('system configuration files');
        expect(getSensitivePathReason('/var/log/auth.log')).toBe('system log files');
    });

    test('should return reason for package manager credentials', () => {
        expect(getSensitivePathReason('/home/user/.npmrc')).toBe('package manager credentials');
        expect(getSensitivePathReason('/home/user/.netrc')).toBe('network credentials (.netrc)');
        expect(getSensitivePathReason('/home/user/.docker/config.json')).toBe('Docker registry credentials');
    });

    test('should return reason for env files', () => {
        expect(getSensitivePathReason('/project/.env')).toBe('environment variables (may contain secrets)');
        expect(getSensitivePathReason('/project/.env.local')).toBe('environment variables (may contain secrets)');
    });

    test('should return reason for shell history', () => {
        expect(getSensitivePathReason('/home/user/.bash_history')).toBe('shell history (may contain secrets)');
        expect(getSensitivePathReason('/home/user/.zsh_history')).toBe('shell history (may contain secrets)');
    });

    test('should return reason for browser data', () => {
        expect(getSensitivePathReason('/home/user/.mozilla/firefox/profile')).toBe('browser data');
        expect(getSensitivePathReason('/home/user/.config/google-chrome/Default')).toBe('browser data');
    });

    test('should return null for non-sensitive paths', () => {
        expect(getSensitivePathReason('/home/user/projects/app.ts')).toBeNull();
        expect(getSensitivePathReason('/tmp/file.txt')).toBeNull();
    });
});
