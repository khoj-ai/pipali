import { test, expect, describe } from 'bun:test';
import { Glob } from 'bun';
import path from 'path';
import { REFUSAL_CATEGORIES } from '../../src/shared';

/**
 * Extract all leaf key paths from a nested object.
 * Arrays are treated as leaf values (e.g., greeting pools).
 */
function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
    const keys: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            keys.push(...flatKeys(v as Record<string, unknown>, key));
        } else {
            keys.push(key);
        }
    }
    return keys.sort();
}

// Discover all locale files dynamically
const localesDir = path.resolve(import.meta.dir, '../../src/client/i18n/locales');
const localeFiles = Array.from(new Glob('*.json').scanSync(localesDir));
const locales: Record<string, Record<string, unknown>> = {};
for (const file of localeFiles) {
    const code = path.basename(file, '.json');
    locales[code] = await import(path.join(localesDir, file));
}

const enKeys = flatKeys(locales.en!);

describe('i18n locale files', () => {
    test('en.json has keys', () => {
        expect(enKeys.length).toBeGreaterThan(0);
    });

    test('en.json explains every refusal category, and the case with none', () => {
        const refusal = (locales.en as { refusal: Record<string, string> }).refusal;
        for (const key of [...REFUSAL_CATEGORIES, 'generic']) {
            expect(refusal[key], `refusal.${key}`).toBeTruthy();
        }
    });

    for (const [code, data] of Object.entries(locales)) {
        if (code === 'en') continue;

        describe(`${code}.json`, () => {
            const localeKeys = flatKeys(data);

            test('has all keys from en.json', () => {
                const missing = enKeys.filter(k => !localeKeys.includes(k));
                if (missing.length > 0) {
                    throw new Error(
                        `${code}.json is missing ${missing.length} key(s):\n  ${missing.join('\n  ')}`
                    );
                }
            });

            test('has no extra keys absent from en.json', () => {
                const extra = localeKeys.filter(k => !enKeys.includes(k));
                if (extra.length > 0) {
                    throw new Error(
                        `${code}.json has ${extra.length} extra key(s) not in en.json:\n  ${extra.join('\n  ')}`
                    );
                }
            });

            test('array values have same length as en.json', () => {
                const mismatches: string[] = [];
                for (const key of enKeys) {
                    const enVal = key.split('.').reduce((o: any, k) => o?.[k], locales.en);
                    const locVal = key.split('.').reduce((o: any, k) => o?.[k], data);
                    if (Array.isArray(enVal) && Array.isArray(locVal) && enVal.length !== locVal.length) {
                        mismatches.push(`${key}: en has ${enVal.length}, ${code} has ${locVal.length}`);
                    }
                }
                if (mismatches.length > 0) {
                    throw new Error(
                        `Array length mismatches:\n  ${mismatches.join('\n  ')}`
                    );
                }
            });
        });
    }
});
