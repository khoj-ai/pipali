// Org-mode grammar for highlight.js, which ships none. Structure only: headlines with their
// state, priority and tags; settings, blocks, drawers and comments; timestamps, links, lists
// and inline emphasis. Block bodies stay plain.

import type { LanguageFn } from 'highlight.js';

// Org emphasis markers count only at a word boundary, so a path like /usr/bin/ is left alone
const inlineMarkup = (marker: string, scope: string) => ({
    scope,
    begin: new RegExp(`(?<=^|[\\s(])${marker}[^${marker}\\n]+${marker}(?=$|[\\s.,;:!?)])`),
});

const org: LanguageFn = (hljs) => ({
    name: 'Org',
    contains: [
        {
            scope: 'section',
            begin: /^\*+ /,
            end: /$/,
            contains: [
                { scope: 'keyword', begin: /\b(?:TODO|NEXT|STARTED|WAITING|DONE|CANCELL?ED)\b/ },
                { scope: 'number', begin: /\[#[A-Z]\]/ },
                { scope: 'symbol', begin: /:[\w@#%]+(?::[\w@#%]+)*:\s*$/ },
            ],
        },
        { scope: 'meta', begin: /^\s*#\+(?:begin|end)_\w+/i, end: /$/ },
        { scope: 'meta', begin: /^\s*#\+\w+:/, end: /$/ },
        hljs.COMMENT(/^\s*# /, /$/),
        { scope: 'meta', begin: /^\s*:[A-Z_]+:\s*$/ },
        { scope: 'attr', begin: /^\s*:[\w-]+:(?=\s)/ },
        { scope: 'keyword', begin: /^\s*(?:SCHEDULED|DEADLINE|CLOSED):/ },
        { scope: 'number', begin: /[<[]\d{4}-\d{2}-\d{2}[^>\]\n]*[>\]]/ },
        { scope: 'link', begin: /\[\[/, end: /\]\]/ },
        { scope: 'bullet', begin: /^\s*(?:[-+]|\d+[.)])\s+/ },
        { scope: 'bullet', begin: /^\s+\*\s+/ },
        { scope: 'literal', begin: /\[[ Xx-]\]/ },
        inlineMarkup('\\*', 'strong'),
        inlineMarkup('/', 'emphasis'),
        inlineMarkup('=', 'code'),
        inlineMarkup('~', 'code'),
    ],
});

export default org;
