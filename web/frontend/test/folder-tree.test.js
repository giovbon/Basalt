import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFolderTree, noteComparator, folderComparator, ROOT_KEY } from '../src/lib/folder-tree.js';

const note = (path, extra = {}) => ({
    path,
    name: path.split('/').pop().replace(/\.md$/, ''),
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    size: 0,
    modified: '',
    ...extra,
});

test('places notes in their folder and keeps empty folders', () => {
    const tree = buildFolderTree(
        [note('a/b/nota.md'), note('raiz.md')],
        ['a', 'a/b', 'vazia'],
        noteComparator('a-z'),
    );

    assert.deepEqual(Object.keys(tree['a'].children), ['b']);
    assert.equal(tree['a'].children['b'].notes[0].name, 'nota');
    assert.equal(tree['a'].children['b'].notes[0].folder, 'a/b');
    assert.equal(tree[ROOT_KEY].notes[0].path, 'raiz.md');
    assert.deepEqual(tree['vazia'].notes, []);
    assert.equal(tree['vazia'].noteCount, 0);
});

test('creates missing intermediate folders for notes', () => {
    const tree = buildFolderTree([note('x/y/z/nota.md')], [], noteComparator('a-z'));

    assert.equal(tree['x'].path, 'x');
    assert.equal(tree['x'].children['y'].path, 'x/y');
    assert.equal(tree['x'].children['y'].children['z'].path, 'x/y/z');
    assert.equal(tree['x'].children['y'].children['z'].notes.length, 1);
});

test('counts notes recursively', () => {
    const tree = buildFolderTree(
        [note('a/1.md'), note('a/b/2.md'), note('a/b/c/3.md'), note('d/4.md')],
        ['a', 'a/b', 'a/b/c', 'd'],
        noteComparator('a-z'),
    );

    assert.equal(tree['a'].noteCount, 3);
    assert.equal(tree['a'].children['b'].noteCount, 2);
    assert.equal(tree['a'].children['b'].children['c'].noteCount, 1);
    assert.equal(tree['d'].noteCount, 1);
});

test('sorts notes with every mode without mutating the input', () => {
    const notes = [
        note('b.md', { size: 10, modified: '2024-01-01' }),
        note('a.md', { size: 30, modified: '2024-03-01' }),
        note('c.md', { size: 20, modified: '2024-02-01' }),
    ];
    const snapshot = notes.map(n => n.path);

    const names = (mode) => buildFolderTree(notes, [], noteComparator(mode))[ROOT_KEY].notes.map(n => n.name);

    assert.deepEqual(names('a-z'), ['a', 'b', 'c']);
    assert.deepEqual(names('z-a'), ['c', 'b', 'a']);
    assert.deepEqual(names('newest'), ['a', 'c', 'b']);
    assert.deepEqual(names('oldest'), ['b', 'c', 'a']);
    assert.deepEqual(names('largest'), ['a', 'c', 'b']);
    assert.deepEqual(names('smallest'), ['b', 'c', 'a']);
    assert.deepEqual(names('desconhecido'), ['a', 'b', 'c']);
    assert.deepEqual(notes.map(n => n.path), snapshot, 'input order must not change');
});

test('folder comparator only special-cases z-a', () => {
    const asc = folderComparator('a-z');
    const desc = folderComparator('z-a');
    const biggest = folderComparator('largest');

    assert.ok(asc({ name: 'a' }, { name: 'b' }) < 0);
    assert.ok(desc({ name: 'a' }, { name: 'b' }) > 0);
    assert.ok(biggest({ name: 'a' }, { name: 'b' }) < 0);
});

test('no root node when every note is inside a folder', () => {
    const tree = buildFolderTree([note('a/1.md')], ['a'], noteComparator('a-z'));
    assert.equal(tree[ROOT_KEY], undefined);
});
