import test from 'node:test';
import assert from 'node:assert/strict';

import { translate } from '../src/core/i18n.js';

const translations = {
    notes: {
        save_conflict_title: 'Arquivo alterado',
        save_conflict_unsaved: '{{name}} não foi salvo',
        zero: 0,
    },
    deep: { nested: { value: 'ok' } },
};

test('translates nested dotted keys', () => {
    assert.equal(translate(translations, 'notes.save_conflict_title'), 'Arquivo alterado');
    assert.equal(translate(translations, 'deep.nested.value'), 'ok');
});

test('missing or non-string entries fall back to the key', () => {
    assert.equal(translate(translations, 'notes.missing'), 'notes.missing');
    assert.equal(translate(translations, 'nao.existe'), 'nao.existe');
    assert.equal(translate(translations, 'notes.zero'), 'notes.zero');
    assert.equal(translate(null, 'notes.x'), 'notes.x');
});

test('interpolates named params and keeps unknown placeholders visible', () => {
    assert.equal(translate(translations, 'notes.save_conflict_unsaved', { name: 'a.md' }), 'a.md não foi salvo');
    assert.equal(translate(translations, 'notes.save_conflict_unsaved', {}), '{{name}} não foi salvo');
});

test('params are optional and non-string values are stringified by the template', () => {
    assert.equal(translate({ x: 'valor' }, 'x'), 'valor');
    assert.equal(translate({ x: 'n={{n}}' }, 'x', { n: 0 }), 'n=0');
});
