import test from 'node:test';
import assert from 'node:assert/strict';

import { typeIconSvg, treeIconKind, treeIconSvg, treeKindClass } from '../src/lib/file-icons.js';

// The sidebar is colour-coded by file type: folders amber, .md notes light
// blue, PDFs red, other media keeps its emoji. These helpers are the whole
// of that mapping, so they are tested directly (they are pure strings, no DOM).

test('treeIconKind maps backend types onto tree kinds', () => {
    assert.equal(treeIconKind('folder'), 'folder');
    assert.equal(treeIconKind('note'), 'note');
    // The backend reports PDFs as "document"; accept the literal too.
    assert.equal(treeIconKind('document'), 'pdf');
    assert.equal(treeIconKind('pdf'), 'pdf');
});

test('treeIconKind returns null for media that keeps its emoji', () => {
    for (const type of ['image', 'audio', 'video', undefined, null, '']) {
        assert.equal(treeIconKind(type), null, `type=${type}`);
    }
});

test('every kind renders a self-contained inline svg', () => {
    for (const kind of ['folder', 'note', 'pdf']) {
        const svg = treeIconSvg(kind);
        assert.ok(svg.startsWith('<svg '), kind);
        assert.ok(svg.endsWith('</svg>'), kind);
        assert.match(svg, /aria-hidden="true"/, kind);
        assert.match(svg, /viewBox="0 0 24 24"/, kind);
        // Stroke follows the text colour so the icon picks up the row hue.
        assert.match(svg, /stroke="currentColor"/, kind);
    }
});

test('the pdf icon is distinguishable from a note icon by shape alone', () => {
    const note = treeIconSvg('note');
    const pdf = treeIconSvg('pdf');
    assert.notEqual(note, pdf);
    // The PDF variant fills its corner fold, so it survives greyscale.
    assert.match(pdf, /fill="currentColor" stroke="none"/);
    assert.doesNotMatch(note, /fill="currentColor"/);
});

test('treeIconSvg returns an empty string for unknown kinds', () => {
    assert.equal(treeIconSvg('image'), '');
    assert.equal(treeIconSvg(undefined), '');
});

test('treeKindClass colours folders, notes and pdfs, everything else is media', () => {
    assert.equal(treeKindClass('folder'), 'tree--folder');
    assert.equal(treeKindClass('note'), 'tree--note');
    assert.equal(treeKindClass('pdf'), 'tree--pdf');
    assert.equal(treeKindClass(null), 'tree--media');
    assert.equal(treeKindClass('bogus'), 'tree--media');
});

test('typeIconSvg covers notes, pdfs and every media type', () => {
    for (const type of ['folder', 'note', 'document', 'image', 'audio', 'video']) {
        const svg = typeIconSvg(type);
        assert.ok(svg.startsWith('<svg '), type);
        assert.match(svg, new RegExp(`tree-icon--${type === 'document' ? 'pdf' : type}`), type);
    }
    assert.equal(typeIconSvg('bogus'), '');
});

test('typeIconSvg honours the requested size for cards and lists', () => {
    assert.match(typeIconSvg('note', { size: 18 }), /width="18" height="18"/);
    assert.match(typeIconSvg('image', { size: 16 }), /width="16" height="16"/);
});
