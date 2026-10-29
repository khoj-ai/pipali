import { test, expect, describe } from 'bun:test';
import { normalizeLatexDelimiters, safeMarkdownUrlTransform } from '../../src/client/utils/markdown';

describe('normalizeLatexDelimiters', () => {
    describe('backslash delimiters', () => {
        test('converts inline \\( \\) to $$', () => {
            expect(normalizeLatexDelimiters('Euler: \\(e^{i\\pi} + 1 = 0\\) is neat')).toBe(
                'Euler: $$e^{i\\pi} + 1 = 0$$ is neat'
            );
        });

        test('converts display \\[ \\] to block $$', () => {
            expect(normalizeLatexDelimiters('\\[\nE = mc^2\n\\]')).toBe('\n$$\nE = mc^2\n$$\n');
        });

        test('keeps repeated pairs separate', () => {
            expect(normalizeLatexDelimiters('\\(a\\) and \\(b\\)')).toBe('$$a$$ and $$b$$');
        });
    });

    describe('single-dollar inline math', () => {
        test('converts $x$ spans to $$', () => {
            expect(normalizeLatexDelimiters('a constant $c$ such that')).toBe(
                'a constant $$c$$ such that'
            );
        });

        test('converts LaTeX commands in $ spans', () => {
            expect(normalizeLatexDelimiters('space $(\\Omega, \\mathcal{F}, P)$ where')).toBe(
                'space $$(\\Omega, \\mathcal{F}, P)$$ where'
            );
        });

        test('converts adjacent $ spans separately', () => {
            expect(normalizeLatexDelimiters('$x$ and $y$')).toBe('$$x$$ and $$y$$');
        });

        test('leaves currency ranges untouched', () => {
            expect(normalizeLatexDelimiters('costs $5-$10 per unit')).toBe('costs $5-$10 per unit');
        });

        test('leaves separated currency amounts untouched', () => {
            expect(normalizeLatexDelimiters('I paid $5 and you paid $10')).toBe(
                'I paid $5 and you paid $10'
            );
        });

        test('leaves escaped dollars untouched', () => {
            expect(normalizeLatexDelimiters('costs \\$5 and \\$10 total')).toBe(
                'costs \\$5 and \\$10 total'
            );
        });

        test('requires opening $ hug its content', () => {
            expect(normalizeLatexDelimiters('a $ 5 tip$ works')).toBe('a $ 5 tip$ works');
        });

        test('does not pair across lines', () => {
            expect(normalizeLatexDelimiters('worth $5!\nBut $x_i$ renders')).toBe(
                'worth $5!\nBut $$x_i$$ renders'
            );
        });

        test('leaves existing $$ spans untouched', () => {
            expect(normalizeLatexDelimiters('inline $$K(\\sigma)$$ stays')).toBe(
                'inline $$K(\\sigma)$$ stays'
            );
            expect(normalizeLatexDelimiters('$$\nP(x) = |\\psi|^2\n$$')).toBe(
                '$$\nP(x) = |\\psi|^2\n$$'
            );
        });

        test('does not re-wrap spans converted from backslash delimiters', () => {
            expect(normalizeLatexDelimiters('\\(a\\) then $b$')).toBe('$$a$$ then $$b$$');
        });
    });

    describe('code segments', () => {
        test('leaves inline code untouched', () => {
            expect(normalizeLatexDelimiters('run `echo $HOME$PATH` now, but $x$ renders')).toBe(
                'run `echo $HOME$PATH` now, but $$x$$ renders'
            );
        });

        test('leaves fenced code untouched', () => {
            const code = '```sh\necho $USER$ \\(no math\\)\n```';
            expect(normalizeLatexDelimiters(code)).toBe(code);
        });

        test('leaves an unclosed streaming fence untouched', () => {
            const streaming = 'so far:\n```py\nprint($x$)';
            expect(normalizeLatexDelimiters(streaming)).toBe(streaming);
        });
    });
});

describe('safeMarkdownUrlTransform', () => {
    test('keeps pipali:// deep links, so they stay clickable in a conversation', () => {
        const link = 'pipali://chat/9093ca2b-7f9d-43e0-998f-49dfbd7b6038';
        expect(safeMarkdownUrlTransform(link)).toBe(link);
    });

    test('drops pipali links the app would not route, which would navigate it away', () => {
        expect(safeMarkdownUrlTransform('Pipali://chat/9093ca2b-7f9d-43e0-998f-49dfbd7b6038')).toBe('');
        expect(safeMarkdownUrlTransform('pipali:chat/9093ca2b-7f9d-43e0-998f-49dfbd7b6038')).toBe('');
    });

    test('keeps the protocols the app opens itself', () => {
        expect(safeMarkdownUrlTransform('https://pipali.ai')).toBe('https://pipali.ai');
        expect(safeMarkdownUrlTransform('file:///tmp/notes.md')).toBe('file:///tmp/notes.md');
    });

    test('drops scripting protocols', () => {
        expect(safeMarkdownUrlTransform('javascript:alert(1)')).toBe('');
        expect(safeMarkdownUrlTransform('data:text/html,<script>alert(1)</script>')).toBe('');
        expect(safeMarkdownUrlTransform('vbscript:msgbox(1)')).toBe('');
    });
});
