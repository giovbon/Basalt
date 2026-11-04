// Reading and writing the settings persisted in localStorage.
//
// LOCAL_SETTINGS (core/config.js) declares the key, type, default and optional
// validation for each value the UI remembers. Keeping the read/write rules here
// means a corrupted entry (bad number, unknown string, broken JSON) always
// falls back to the declared default instead of reaching the component.

function defaultStorage() {
    return globalThis.localStorage;
}

function serialize(type, value) {
    switch (type) {
        case 'boolean':
        case 'number':
            return String(value);
        case 'json':
            return JSON.stringify(value);
        default:
            return String(value);
    }
}

/** Type used for ad-hoc keys that are not declared in LOCAL_SETTINGS. */
function inferType(value) {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (value !== null && typeof value === 'object') return 'json';
    return 'string';
}

/**
 * Parse one persisted value according to its declaration.
 * Never throws: anything invalid resolves to `config.default`.
 */
export function parseSetting(config, saved) {
    if (saved === null || saved === undefined) {
        return config.default;
    }

    switch (config.type) {
        case 'boolean':
            return saved === 'true';

        case 'number': {
            const num = parseFloat(saved);
            const withinMin = config.min === undefined || num >= config.min;
            const withinMax = config.max === undefined || num <= config.max;
            return !isNaN(num) && withinMin && withinMax ? num : config.default;
        }

        case 'string':
            return !config.valid || config.valid.includes(saved) ? saved : config.default;

        case 'json':
            return JSON.parse(saved);

        default:
            return config.default;
    }
}

/**
 * Read every declared setting.
 *
 * Returns a plain object keyed by the property names of `defs` (not the
 * localStorage keys), ready to be assigned onto the Alpine component.
 *
 * @param {Record<string, { key: string, type: string, default: any }>} defs
 * @param {Storage} [storage]
 * @returns {Record<string, any>}
 */
export function readLocalSettings(defs, storage = defaultStorage()) {
    const values = {};

    for (const [prop, config] of Object.entries(defs)) {
        try {
            values[prop] = parseSetting(config, storage.getItem(config.key));
        } catch (error) {
            console.error(`Error loading setting ${prop}:`, error);
            values[prop] = config.default;
        }
    }

    return values;
}

/**
 * Persist one setting.
 *
 * `prop` may be a property declared in `defs` (its key and type are used) or a
 * bare storage key (stringified as-is), which covers one-off preferences such
 * as the theme and locale.
 *
 * @param {string} prop
 * @param {any} value
 * @param {Record<string, { key: string, type: string }>} [defs]
 * @param {Storage} [storage]
 * @returns {string} the storage key that was written
 */
export function saveSetting(prop, value, defs = {}, storage = defaultStorage()) {
    const config = defs[prop];
    const key = config ? config.key : prop;
    const type = config ? config.type : inferType(value);
    storage.setItem(key, serialize(type, value));
    return key;
}
