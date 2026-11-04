import test from 'node:test';
import assert from 'node:assert/strict';

import { folderFromPath, filenameFromPath, inferTypeFromPath } from '../src/lib/paths.js';

test('folderFromPath returns the parent folder or an empty string', () => {
    assert.equal(folderFromPath('a/b/nota.md'), 'a/b');
    assert.equal(folderFromPath('nota.md'), '');
});

test('filenameFromPath returns the last segment', () => {
    assert.equal(filenameFromPath('a/b/nota.md'), 'nota.md');
    assert.equal(filenameFromPath('nota.md'), 'nota.md');
});

test('inferTypeFromPath classifies supported media', () => {
    assert.equal(inferTypeFromPath('a/nota.md'), 'note');
    assert.equal(inferTypeFromPath('a/sem-extensao'), 'note');
    assert.equal(inferTypeFromPath('a/foto.PNG'), 'image');
    assert.equal(inferTypeFromPath('a/foto.webp'), 'image');
    assert.equal(inferTypeFromPath('a/som.mp3'), 'audio');
    assert.equal(inferTypeFromPath('a/video.webm'), 'video');
    assert.equal(inferTypeFromPath('a/doc.pdf'), 'document');
    assert.equal(inferTypeFromPath('a/arquivo.zip'), 'note');
});
