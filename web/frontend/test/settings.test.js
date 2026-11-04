import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCAL_SETTINGS } from '../src/core/config.js';
import { parseSetting, readLocalSettings, saveSetting } from '../src/core/settings.js';

/** Minimal in-memory Storage, with an optional throw-on-get for corruption tests. */
class MemoryStorage {
    constructor(entries = {}) {
        this.entries = new Map(Object.entries(entries));
        this.failOnGet = null;
    }

    getItem(key) {
        if (this.failOnGet === key) throw new Error('storage unavailable');
        return this.entries.has(key) ? this.entries.get(key) : null;
    }

    setItem(key, value) {
        this.entries.set(key, String(value));
    }
}

function silenceConsole(fn) {
    const original = console.error;
    console.error = () => {};
    try {
        return fn();
    } finally {
        console.error = original;
    }
}

test('an empty storage yields every declared default', () => {
    const values = readLocalSettings(LOCAL_SETTINGS, new MemoryStorage());
    for (const [prop, config] of Object.entries(LOCAL_SETTINGS)) {
        assert.deepEqual(values[prop], config.default, `${prop} default`);
    }
    assert.deepEqual(values.favorites, []);
});

test('booleans, numbers, strings and JSON are decoded by type', () => {
    const storage = new MemoryStorage({
        readableLineLength: 'false',
        sidebarWidth: '320',
        sortMode: 'newest',
        noteFavorites: '["a.md"]',
        homepageView: 'list',
    });
    const values = readLocalSettings(LOCAL_SETTINGS, storage);

    assert.equal(values.readableLineLength, false);
    assert.equal(values.sidebarWidth, 320);
    assert.equal(values.sortMode, 'newest');
    assert.deepEqual(values.favorites, ['a.md']);
    assert.equal(values.homepageView, 'list');
});

test('invalid numbers fall back to the default (NaN and out-of-range)', () => {
    const config = LOCAL_SETTINGS.sidebarWidth;
    assert.equal(parseSetting(config, 'abc'), config.default);
    assert.equal(parseSetting(config, '100'), config.default, 'below min');
    assert.equal(parseSetting(config, '900'), config.default, 'above max');
    assert.equal(parseSetting(config, '200'), 200);
    assert.equal(parseSetting(config, '600'), 600);
});

test('strings outside the allowed list fall back to the default', () => {
    const config = LOCAL_SETTINGS.viewMode;
    assert.equal(parseSetting(config, 'split'), 'split');
    assert.equal(parseSetting(config, 'gigante'), config.default);
});

test('corrupted JSON or a throwing storage resolves to the default', () => {
    const values = silenceConsole(() => {
        const broken = readLocalSettings(
            { favorites: LOCAL_SETTINGS.favorites },
            new MemoryStorage({ noteFavorites: '{not json' }),
        );
        const unreadable = new MemoryStorage();
        unreadable.failOnGet = 'noteFavorites';
        return { broken, unreadable: readLocalSettings({ favorites: LOCAL_SETTINGS.favorites }, unreadable) };
    });

    assert.deepEqual(values.broken.favorites, []);
    assert.deepEqual(values.unreadable.favorites, []);
});

test('saveSetting serializes declared settings by their type', () => {
    const storage = new MemoryStorage();

    assert.equal(saveSetting('sidebarWidth', 300, LOCAL_SETTINGS, storage), 'sidebarWidth');
    assert.equal(storage.getItem('sidebarWidth'), '300');

    saveSetting('favorites', ['a.md', 'b.md'], LOCAL_SETTINGS, storage);
    assert.equal(storage.getItem('noteFavorites'), '["a.md","b.md"]');

    saveSetting('favoritesExpanded', false, LOCAL_SETTINGS, storage);
    assert.equal(storage.getItem('favoritesExpanded'), 'false');

    saveSetting('viewMode', 'preview', LOCAL_SETTINGS, storage);
    assert.equal(storage.getItem('viewMode'), 'preview');
});

test('saveSetting accepts ad-hoc keys such as theme and locale', () => {
    const storage = new MemoryStorage();
    assert.equal(saveSetting('noteDiscoveryTheme', 'dark', LOCAL_SETTINGS, storage), 'noteDiscoveryTheme');
    assert.equal(storage.getItem('noteDiscoveryTheme'), 'dark');
    assert.equal(saveSetting('locale', 'pt-BR', LOCAL_SETTINGS, storage), 'locale');
    assert.equal(storage.getItem('locale'), 'pt-BR');
});
