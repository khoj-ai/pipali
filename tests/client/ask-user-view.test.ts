import { describe, expect, test } from 'bun:test';
import { parseAskUserAnswer } from '../../src/client/components/tool-views/AskUserView';

describe('parseAskUserAnswer', () => {
    test('reads each result shape askUser() produces', () => {
        expect(parseAskUserAnswer('User selected: Staging')).toEqual({ kind: 'selected', text: 'Staging' });
        expect(parseAskUserAnswer('User acknowledged: "Backup written"')).toEqual({ kind: 'acknowledged', text: '' });
        expect(parseAskUserAnswer('User responded: neither,\nuse prod')).toEqual({ kind: 'text', text: 'neither,\nuse prod' });
        expect(parseAskUserAnswer('User entered: 42')).toEqual({ kind: 'text', text: '42' });
    });

    test('keeps attachments out of a typed answer', () => {
        const r = parseAskUserAnswer('User responded: see file\n\n<attachments>x</attachments>');
        expect(r?.text).toBe('see file');
    });

    test('is null while pending or on errors', () => {
        expect(parseAskUserAnswer(undefined)).toBeNull();
        expect(parseAskUserAnswer('Error: title is required')).toBeNull();
    });
});
