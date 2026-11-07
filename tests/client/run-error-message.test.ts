import { test, expect, describe } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../../src/client/i18n/locales/en.json';
import { RunErrorMessage } from '../../src/client/components/messages/RunErrorMessage';
import type { RefusalInfo } from '../../src/shared';

const i18n = i18next.createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });

const render = (props: { message: string; refusal?: RefusalInfo }) =>
    renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(RunErrorMessage, props)))
        .replaceAll('&#x27;', "'");

describe('run error card', () => {
    test('explains a refusal by its category and says what to try next', () => {
        const html = render({ message: 'The model declined to respond (category: cyber)', refusal: { category: 'cyber' } });

        expect(html).toContain('The model declined this request');
        expect(html).toContain(en.refusal.cyber);
        expect(html).not.toContain('model provider error');
    });

    test('asks the user to change their message or try another model when a refusal has no category', () => {
        const html = render({ message: 'The model declined to respond', refusal: {} });

        expect(html).toContain(en.refusal.generic);
        expect(html).toContain('retry with a different model');
    });

    test('still reports a provider failure as before', () => {
        const html = render({ message: '500 upstream failed' });

        expect(html).toContain('This run stopped');
        expect(html).toContain('model provider error');
    });
});
