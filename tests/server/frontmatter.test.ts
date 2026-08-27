import { test, expect, describe } from 'bun:test';
import { parseFrontmatter } from '../../src/server/frontmatter';

describe('parseFrontmatter', () => {
    test('separates arbitrary top-level fields from the body', () => {
        const content = `---
name: accountant
location: Mexico City, Mexico
---
The ledger lives at ~/Documents/ledger.beancount.

Second paragraph.
`;
        const result = parseFrontmatter(content);
        expect(result?.fields).toEqual({
            name: 'accountant',
            location: 'Mexico City, Mexico',
        });
        expect(result?.body).toBe('The ledger lives at ~/Documents/ledger.beancount.\n\nSecond paragraph.');
    });

    test('keeps metadata fields out of top-level fields', () => {
        const content = `---
name: scoped-e2e-runs
metadata:
  type: feedback
  visible: false
---
Body.
`;
        const result = parseFrontmatter(content);
        expect(result?.fields).toEqual({ name: 'scoped-e2e-runs' });
        expect(result?.metadata).toEqual({ type: 'feedback', visible: 'false' });
    });

    test('stops a metadata block at the next top-level key', () => {
        const content = `---
metadata:
  type: project
name: after-metadata
---
Body.
`;
        const result = parseFrontmatter(content);
        expect(result?.fields.name).toBe('after-metadata');
        expect(result?.metadata).toEqual({ type: 'project' });
    });

    test('preserves values that regex-per-field parsing dropped', () => {
        const content = `---
location: O'Brien County
description: Format: JSON
---
`;
        const result = parseFrontmatter(content);
        expect(result?.fields.location).toBe("O'Brien County");
        expect(result?.fields.description).toBe('Format: JSON');
    });

    test('handles CRLF line endings', () => {
        const content = '---\r\nname: crlf-skill\r\nmetadata:\r\n  visible: false\r\n---\r\nBody.\r\n';
        const result = parseFrontmatter(content);
        expect(result?.fields.name).toBe('crlf-skill');
        expect(result?.metadata.visible).toBe('false');
        expect(result?.body).toBe('Body.');
    });
});
