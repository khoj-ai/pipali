import { test, expect, describe } from 'bun:test';
import { formatMessageTime } from '../../src/client/utils/formatting';

describe('formatMessageTime', () => {
    const now = new Date('2026-03-15T18:00:00');

    test('shows only the time for messages sent today', () => {
        expect(formatMessageTime('2026-03-15T09:05:00', 'en-US', now)).toBe('9:05 AM');
    });

    test('names the weekday within the past week', () => {
        // Saturday the 15th, so the 12th is the Thursday before it
        expect(formatMessageTime('2026-03-12T09:05:00', 'en-US', now)).toBe('Thu 9:05 AM');
    });

    test('falls back to the date beyond a week, without the year inside it', () => {
        expect(formatMessageTime('2026-01-04T09:05:00', 'en-US', now)).toBe('Jan 4, 9:05 AM');
    });

    test('carries the year for an older conversation', () => {
        expect(formatMessageTime('2025-11-20T09:05:00', 'en-US', now)).toBe('Nov 20, 2025, 9:05 AM');
    });

    test('returns nothing it cannot read', () => {
        expect(formatMessageTime('not a date', 'en-US', now)).toBe('');
    });
});
