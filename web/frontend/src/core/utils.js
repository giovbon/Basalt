// Small, dependency-free helpers shared across the app: error reporting, URL
// encoding for vault paths and filename validation.
//
// Extracted from the former single-file app.js so they can be unit tested.

// Centralized error handling
export const ErrorHandler = {
    /**
     * Handle errors consistently across the app
     * @param {string} operation - The operation that failed (e.g., "load notes", "save note")
     * @param {Error} error - The error object
     * @param {boolean} notify - Whether to show a toast (listens on notediscovery:toast)
     */
    handle(operation, error, notify = true) {
        console.error(`Failed to ${operation}:`, error);
        if (notify) {
            const message = `Failed to ${operation}. Please try again.`;
            globalThis.dispatchEvent(new CustomEvent('notediscovery:toast', {
                detail: { message, type: 'error' }
            }));
        }
    }
};

/**
 * Encode one vault-relative path for a URL.
 * Each segment is encoded on its own so a `#` stays in the path. Left raw, the
 * browser treats it as a fragment and the request hits a different note.
 */
export function encodeVaultPath(path) {
    if (!path) return '';
    return String(path).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Centralized filename validation
 * Supports Unicode characters (international text) but blocks dangerous filesystem characters.
 * Does NOT silently modify filenames - validates and returns status.
 */
export const FilenameValidator = {
    // Characters that are forbidden in filenames across Windows/macOS/Linux,
    // plus `#`. A hash is legal on disk, but in this app it starts a heading
    // link (`[[Note#heading]]`) and, unencoded, it is a URL fragment.
    // Windows: \ / : * ? " < > |
    // macOS: / :
    // Linux: / \0
    // Common set to block (including control characters)
    FORBIDDEN_CHARS: /[\\/:*?"<>|#\x00-\x1f]/,

    // For display purposes - human readable list
    FORBIDDEN_CHARS_DISPLAY: '\\ / : * ? " < > | #',

    /**
     * Validate a filename (single segment, no path separators)
     * @param {string} name - The filename to validate
     * @returns {{ valid: boolean, error?: string, sanitized?: string }}
     */
    validateFilename(name) {
        if (!name || typeof name !== 'string') {
            return { valid: false, error: 'empty' };
        }

        const trimmed = name.trim();
        if (!trimmed) {
            return { valid: false, error: 'empty' };
        }

        // Check for forbidden characters
        if (this.FORBIDDEN_CHARS.test(trimmed)) {
            return {
                valid: false,
                error: 'forbidden_chars',
                forbiddenChars: this.FORBIDDEN_CHARS_DISPLAY
            };
        }

        // Check for reserved Windows names (case-insensitive)
        const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
        if (reservedNames.test(trimmed)) {
            return { valid: false, error: 'reserved_name' };
        }

        // Check for names starting/ending with dots or spaces (problematic on some systems)
        if (trimmed.startsWith('.') && trimmed.length === 1) {
            return { valid: false, error: 'invalid_dot' };
        }
        if (trimmed.endsWith('.') || trimmed.endsWith(' ')) {
            return { valid: false, error: 'trailing_dot_space' };
        }

        return { valid: true, sanitized: trimmed };
    },

    /**
     * Validate a path (may contain forward slashes for folder separators)
     * @param {string} path - The path to validate
     * @returns {{ valid: boolean, error?: string, sanitized?: string }}
     */
    validatePath(path) {
        if (!path || typeof path !== 'string') {
            return { valid: false, error: 'empty' };
        }

        const trimmed = path.trim();
        if (!trimmed) {
            return { valid: false, error: 'empty' };
        }

        // Split by forward slash and validate each segment
        const segments = trimmed.split('/').filter(s => s.length > 0);
        if (segments.length === 0) {
            return { valid: false, error: 'empty' };
        }

        for (const segment of segments) {
            const result = this.validateFilename(segment);
            if (!result.valid) {
                return result;
            }
        }

        // Rebuild path without empty segments
        return { valid: true, sanitized: segments.join('/') };
    }
};
