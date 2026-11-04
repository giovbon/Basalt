// Translation lookup and interpolation.
//
// Kept free of Alpine and fetch so the resolution rules are testable with
// plain objects: `translations` is the tree returned by /api/locales/<code>.

/**
 * Look up a dotted key and interpolate `{{param}}` placeholders.
 *
 * Missing (or non-string) translations fall back to the key itself, which is
 * what the UI showed before translations were available.
 *
 * @param {Record<string, any>} translations
 * @param {string} key e.g. "notes.save_conflict_title"
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function translate(translations, key, params = {}) {
    if (typeof key !== 'string') return key;

    let value = translations;
    for (const part of key.split('.')) {
        value = value?.[part];
    }

    if (typeof value !== 'string') {
        return key;
    }

    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? `{{${name}}}`);
}
