import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EDITOR_TAB_OUTDENT_MAX_SPACES,
    editorIndentRemoveLen,
    editorOutdentChunk,
    applyEditorOutdent,
} from '../src/lib/editor.js';

test('indent removal is one tab or up to four spaces', () => {
    assert.equal(EDITOR_TAB_OUTDENT_MAX_SPACES, 4);
    assert.equal(editorIndentRemoveLen('\tabc'), 1);
    assert.equal(editorIndentRemoveLen(' abc'), 1);
    assert.equal(editorIndentRemoveLen('    abc'), 4);
    assert.equal(editorIndentRemoveLen('     abc'), 4, 'only one indent level');
    assert.equal(editorIndentRemoveLen('abc'), 0);
    assert.equal(editorIndentRemoveLen(''), 0);
});

test('outdents every line and reports whether anything changed', () => {
    const changed = editorOutdentChunk('    a\n\tb\nc');
    assert.deepEqual(changed, { newChunk: 'a\nb\nc', changed: true });

    const untouched = editorOutdentChunk('a\nb');
    assert.deepEqual(untouched, { newChunk: 'a\nb', changed: false });

    assert.deepEqual(editorOutdentChunk(''), { newChunk: '', changed: false });
});

test('outdents the line under a collapsed caret', () => {
    const result = applyEditorOutdent('    abc', 0, 0);
    assert.equal(result.changed, true);
    assert.equal(result.text, 'abc');
    assert.equal(result.selStart, 0);
    assert.equal(result.selEnd, 0);
});

test('leaves a line without indent untouched', () => {
    const result = applyEditorOutdent('abc', 1, 1);
    assert.deepEqual(result, { changed: false, text: 'abc', selStart: 1, selEnd: 1 });
});

test('maps a caret inside the line after the indent is removed', () => {
    const text = '  a\n    b';
    const caret = text.length - 1; // on the 'b'
    const result = applyEditorOutdent(text, caret, caret);

    assert.equal(result.text, '  a\nb');
    assert.equal(result.selStart, caret - 4);
});

test('outdents all selected lines and keeps the selection ordered', () => {
    const text = '    a\n    b\nc';
    const result = applyEditorOutdent(text, 10, 0);

    assert.equal(result.text, 'a\nb\nc');
    assert.ok(result.selStart <= result.selEnd);
    assert.equal(result.selStart, 0);
    assert.equal(result.selEnd, 2);
});
