import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, LOCAL_SETTINGS } from '../src/core/config.js';
import { ErrorHandler, encodeVaultPath, FilenameValidator } from '../src/core/utils.js';

test('CONFIG exposes the defaults the UI hydrates from /api/config', () => {
    assert.equal(CONFIG.DEFAULT_THEME, 'light');
    assert.equal(CONFIG.SEARCH_MIN_QUERY_LENGTH, 2);
    assert.ok(CONFIG.DEFAULT_SIDEBAR_WIDTH >= 200);
});

test('every persisted setting has a key and a declared type', () => {
    for (const [name, setting] of Object.entries(LOCAL_SETTINGS)) {
        assert.ok(setting.key, `${name} is missing a key`);
        assert.ok(['boolean', 'string', 'number', 'json'].includes(setting.type), `${name} has an unknown type`);
        assert.ok('default' in setting, `${name} is missing a default`);
    }
});

test('encodeVaultPath encodes each segment but keeps slashes', () => {
    assert.equal(encodeVaultPath('a/b c/nota#1.md'), 'a/b%20c/nota%231.md');
    assert.equal(encodeVaultPath(''), '');
    assert.equal(encodeVaultPath(null), '');
});

test('FilenameValidator accepts Unicode names and rejects filesystem hazards', () => {
    assert.deepEqual(FilenameValidator.validateFilename('  História  '), { valid: true, sanitized: 'História' });
    assert.equal(FilenameValidator.validateFilename('a/b').error, 'forbidden_chars');
    assert.equal(FilenameValidator.validateFilename('nota#1').error, 'forbidden_chars');
    assert.equal(FilenameValidator.validateFilename('CON').error, 'reserved_name');
    assert.equal(FilenameValidator.validateFilename('trailing.').error, 'trailing_dot_space');
    // Leading/trailing spaces are trimmed, so the "ends with space" branch is
    // unreachable — this pins the current behaviour rather than the intent.
    assert.deepEqual(FilenameValidator.validateFilename('trailing '), { valid: true, sanitized: 'trailing' });
    assert.equal(FilenameValidator.validateFilename('.').error, 'invalid_dot');
    assert.equal(FilenameValidator.validateFilename('').error, 'empty');
    assert.equal(FilenameValidator.validateFilename(42).error, 'empty');
});

test('FilenameValidator.validatePath validates each segment and drops empties', () => {
    assert.deepEqual(FilenameValidator.validatePath('a//b/nota.md'), { valid: true, sanitized: 'a/b/nota.md' });
    assert.equal(FilenameValidator.validatePath('a/bad:name').error, 'forbidden_chars');
    assert.equal(FilenameValidator.validatePath('///').error, 'empty');
});

test('ErrorHandler notifies through the documented event', () => {
    const events = [];
    const original = globalThis.dispatchEvent;
    const originalConsoleError = console.error;
    globalThis.dispatchEvent = (event) => { events.push(event); return true; };
    console.error = () => {};
    try {
        ErrorHandler.handle('load notes', new Error('boom'));
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'notediscovery:toast');
        assert.equal(events[0].detail.type, 'error');
        assert.match(events[0].detail.message, /load notes/);

        ErrorHandler.handle('load notes', new Error('boom'), false);
        assert.equal(events.length, 1, 'notify=false must not dispatch');
    } finally {
        globalThis.dispatchEvent = original;
        console.error = originalConsoleError;
    }
});
