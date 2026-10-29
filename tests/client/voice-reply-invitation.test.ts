import { describe, expect, test } from 'bun:test';
import { __test__ } from '../../src/client/hooks/useVoiceCompanion';
import { TurnTranscript } from '../../src/client/utils/voice/voice-turn';

const { replyInvitationOpen } = __test__;

function turn(overrides: Partial<{ kind: 'reply' | 'composed'; inFlight: number; finishing: boolean; said: string }> = {}) {
    const transcript = new TurnTranscript();
    if (overrides.said) transcript.addSegment(0, overrides.said);
    return {
        kind: overrides.kind ?? 'reply' as const,
        transcript,
        baseSeq: null,
        inFlight: overrides.inFlight ?? 0,
        finishing: overrides.finishing ?? false,
    };
}

describe('replyInvitationOpen', () => {
    test('a reply turn that has caught nothing is still waiting', () => {
        expect(replyInvitationOpen(turn())).toBe(true);
    });

    // The cough case: onset stops the window, the segment transcribes to
    // nothing, and the turn is back where it started — so the window has to be
    // able to restart. Answering false here is what stranded the turn open,
    // leaving "Hey Pipali" to land as dictation instead of waking anything.
    test('an empty transcript leaves it waiting, whatever landed and vanished', () => {
        for (const said of ['', '   ']) {
            expect(replyInvitationOpen(turn({ said }))).toBe(true);
        }
    });

    test('text of any kind means the user took the floor', () => {
        expect(replyInvitationOpen(turn({ said: 'yes' }))).toBe(false);
        expect(replyInvitationOpen(turn({ said: 'check the deploy logs' }))).toBe(false);
    });

    // "Scratch that" empties the transcript while the user works out a rephrase,
    // which a restarted window would cut off after a long enough pause.
    test('words scratched out still leave the floor with the user', () => {
        const scratched = turn({ said: 'check the deploy logs' });
        scratched.transcript.clear();
        expect(scratched.transcript.text).toBe('');
        expect(replyInvitationOpen(scratched)).toBe(false);
    });

    test('a segment still transcribing is not silence', () => {
        expect(replyInvitationOpen(turn({ inFlight: 1 }))).toBe(false);
    });

    test('a turn already ending does not reopen the window', () => {
        expect(replyInvitationOpen(turn({ finishing: true }))).toBe(false);
    });

    test('composed turns never carry an invitation', () => {
        expect(replyInvitationOpen(turn({ kind: 'composed' }))).toBe(false);
    });
});
