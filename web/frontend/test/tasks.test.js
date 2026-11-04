import test from 'node:test';
import assert from 'node:assert/strict';

import { scanTaskLines, toggleTaskAt, setAllTasks, TASK_ITEM_RE } from '../src/lib/tasks.js';

test('finds task lines and skips frontmatter and fenced code', () => {
    const source = [
        '---',
        'tags: [x]',
        '---',
        '- [ ] a',
        '```md',
        '- [ ] hidden',
        '```',
        '1. [x] done',
    ].join('\n');

    assert.deepEqual(scanTaskLines(source), [3, 7]);
});

test('recognizes nested, quoted and ordered task markers', () => {
    const source = [
        '  - [ ] nested',
        '> - [x] quoted',
        '3. [ ] ordered',
        '- [X] upper',
        '- plain bullet',
    ].join('\n');

    assert.deepEqual(scanTaskLines(source), [0, 1, 2, 3]);
    assert.ok(TASK_ITEM_RE.test('- [ ] x'));
});

test('an indented fence still hides its tasks', () => {
    const source = ['- item', '  ```', '  - [ ] hidden', '  ```', '- [ ] visible'].join('\n');
    assert.deepEqual(scanTaskLines(source), [4]);
});

test('toggleTaskAt flips only the target line and returns the changed text', () => {
    const source = '- [ ] a\n- [x] b\n- [ ] c';
    const result = toggleTaskAt(source, 1);

    assert.equal(result.found, true);
    assert.equal(result.changed, true);
    assert.equal(result.lineIndex, 1);
    assert.equal(result.oldLine, '- [x] b');
    assert.equal(result.newLine, '- [ ] b');
    assert.equal(result.text, '- [ ] a\n- [ ] b\n- [ ] c');
});

test('toggleTaskAt preserves indentation and container prefixes', () => {
    const source = '  > 1. [ ] item';
    const result = toggleTaskAt(source, 0);
    assert.equal(result.text, '  > 1. [x] item');
});

test('toggleTaskAt reports missing indexes instead of editing', () => {
    const result = toggleTaskAt('- [ ] a', 5);
    assert.equal(result.found, false);
    assert.equal(result.changed, false);
    assert.equal(result.text, '- [ ] a');
});

test('setAllTasks applies the opposite state of the clicked task to every task', () => {
    const source = '- [ ] a\n- [x] b\n- [ ] c';
    const result = setAllTasks(source, 0);

    assert.equal(result.found, true);
    assert.equal(result.nextState, 'x');
    assert.equal(result.total, 3);
    assert.equal(result.changeCount, 2);
    assert.equal(result.text, '- [x] a\n- [x] b\n- [x] c');
});

test('setAllTasks unchecks everything when the clicked task is checked', () => {
    const result = setAllTasks('- [x] a\n- [ ] b', 0);
    assert.equal(result.nextState, ' ');
    assert.equal(result.changeCount, 1);
    assert.equal(result.text, '- [ ] a\n- [ ] b');
});

test('setAllTasks leaves non-task lines untouched', () => {
    const source = '# Título\n\n- [ ] a\ntexto\n- [ ] b';
    const result = setAllTasks(source, 0);
    assert.equal(result.total, 2);
    assert.equal(result.text, '# Título\n\n- [x] a\ntexto\n- [x] b');
});

test('setAllTasks rejects an out-of-range index', () => {
    const result = setAllTasks('- [ ] a', 9);
    assert.equal(result.found, false);
    assert.equal(result.changed, false);
    assert.equal(result.text, '- [ ] a');
});
