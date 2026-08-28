import { test, expect, describe } from 'bun:test';
import { formatMessageTime, formatRunDuration } from '../../src/client/utils/formatting';

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

describe('formatRunDuration', () => {
    test('grows units as a run wears on, padding once minutes appear', () => {
        expect(formatRunDuration(0)).toBe('0s');
        expect(formatRunDuration(59_400)).toBe('59s');
        expect(formatRunDuration(60_000)).toBe('1m 00s');
        expect(formatRunDuration(134_000)).toBe('2m 14s');
        expect(formatRunDuration(3_600_000)).toBe('1h 00m');
        expect(formatRunDuration(3_780_000)).toBe('1h 03m');
    });
});
