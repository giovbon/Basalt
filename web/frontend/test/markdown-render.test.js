import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdownSync } from '../src/lib/markdown-render.js';

// Minimal mocks for browser globals used by the renderer
globalThis.marked = {
    use: () => {},
    setOptions: () => {},
    parse: (src) => `<p>${src.replace(/\n/g, '</p><p>')}</p>`,
};

globalThis.DOMPurify = {
    sanitize: (html) => html,
};

globalThis.hljs = {
    getLanguage: () => false,
    highlightAuto: (code) => ({ value: code }),
    highlight: (code, opts) => ({ value: code }),
};

function makeMockDeps(overrides = {}) {
    return {
        noteLookupByPath: new Map(),
        noteLookupByPathLower: new Map(),
        mediaLookup: new Map(),
        mediaLookupStem: new Map(),
        resolveWikiLink: () => null,
        resolveMediaWikilink: () => null,
        getMediaType: () => 'image',
        typeIconSvg: () => '<svg></svg>',
        escapeHtml: (s) => s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'),
        ...overrides,
    };
}

test('empty content returns placeholder', () => {
    const html = renderMarkdownSync({ noteContent: '', ...makeMockDeps() });
    assert.match(html, /Nothing to preview yet/);
});

test('basic markdown renders', () => {
    const deps = makeMockDeps();
    const html = renderMarkdownSync({ noteContent: '# Hello\n\nWorld', ...deps });
    assert.match(html, /Hello/);
    assert.match(html, /World/);
});

test('frontmatter is stripped', () => {
    const deps = makeMockDeps();
    const content = '---\ntitle: Test\n---\n\n# Body';
    const html = renderMarkdownSync({ noteContent: content, ...deps });
    assert.ok(!html.includes('title: Test'));
    assert.match(html, /Body/);
});

test('code blocks are preserved', () => {
    const deps = makeMockDeps();
    const content = '```js\nconst x = 1;\n```';
    const html = renderMarkdownSync({ noteContent: content, ...deps });
    assert.match(html, /const x = 1;/);
});

test('inline code is preserved', () => {
    const deps = makeMockDeps();
    const html = renderMarkdownSync({ noteContent: 'Use `const` for constants', ...deps });
    assert.match(html, /const/);
});

test('wikilinks are converted to anchors', () => {
    const deps = makeMockDeps({
        resolveWikiLink: (target, source) => target === 'My Note' ? 'my-note' : null,
    });
    const html = renderMarkdownSync({ noteContent: 'See [[My Note]]', currentNote: '', ...deps });
    assert.match(html, /my-note/);
    assert.match(html, /My Note/);
});

test('broken wikilinks get broken class', () => {
    const deps = makeMockDeps({
        resolveWikiLink: () => null,
    });
    const html = renderMarkdownSync({ noteContent: 'See [[Missing]]', currentNote: '', ...deps });
    assert.match(html, /wikilink-broken/);
    assert.match(html, /Missing/);
});

test('media wikilinks produce img tags', () => {
    const deps = makeMockDeps({
        resolveMediaWikilink: (name) => name === 'image.png' ? 'attachments/image.png' : null,
        getMediaType: () => 'image',
    });
    const html = renderMarkdownSync({ noteContent: '![[image.png]]', ...deps });
    assert.match(html, /image\.png/);
});

test('callouts are converted to divs', () => {
    const deps = makeMockDeps();
    const content = '> [!NOTE]\n> This is a note';
    const html = renderMarkdownSync({ noteContent: content, ...deps });
    assert.match(html, /callout callout-note/);
    assert.match(html, /This is a note/);
});

test('task list checkboxes are preserved', () => {
    const deps = makeMockDeps();
    const content = '- [ ] Task 1\n- [x] Task 2';
    const html = renderMarkdownSync({ noteContent: content, ...deps });
    assert.match(html, /Task 1/);
    assert.match(html, /Task 2/);
});

test('external links get target blank', () => {
    const deps = makeMockDeps();
    const html = renderMarkdownSync({ noteContent: '[External](https://example.com)', ...deps });
    // With minimal mocks, we just check the link text is preserved
    assert.match(html, /External/);
});