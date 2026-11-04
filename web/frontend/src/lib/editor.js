// Indentation helpers for the plain <textarea> editor.
//
// Tab and Shift+Tab are handled manually because the native behaviour loses
// the selection on multi-line outdent. Everything here works on strings and
// offsets, so the caret mapping can be tested without a DOM.

/** Max leading spaces Shift+Tab removes per line when matching one "tab indent" vs \t inserts. */
export const EDITOR_TAB_OUTDENT_MAX_SPACES = 4;

/** How many leading indent characters Shift+Tab removes from one line. */
export function editorIndentRemoveLen(lineSegment) {
    if (!lineSegment || lineSegment.length === 0) return 0;
    if (lineSegment.charCodeAt(0) === 9 /* \t */) return 1;
    let i = 0;
    const max = Math.min(EDITOR_TAB_OUTDENT_MAX_SPACES, lineSegment.length);
    while (i < max && lineSegment[i] === ' ') i++;
    return i;
}

/** Outdent every line of a blocked chunk (no selection boundary). */
export function editorOutdentChunk(chunk) {
    if (chunk.length === 0) return { newChunk: chunk, changed: false };
    const lines = chunk.split('\n');
    const newLines = lines.map((line) => {
        const n = editorIndentRemoveLen(line);
        return n > 0 ? line.slice(n) : line;
    });
    const newChunk = newLines.join('\n');
    return { newChunk, changed: newChunk !== chunk };
}

/** Characters removed from `chunk` before offset `rel` by one outdent pass. */
export function editorRemovedBeforeInChunk(chunk, rel) {
    const target = Math.min(Math.max(rel, 0), chunk.length);
    let off = 0;
    let removed = 0;
    while (off < chunk.length && off < target) {
        const nl = chunk.indexOf('\n', off);
        const lineEnd = nl === -1 ? chunk.length : nl;
        const lineSlice = chunk.slice(off, lineEnd);
        const n = editorIndentRemoveLen(lineSlice);
        if (target >= lineEnd) {
            removed += n;
            if (nl === -1) break;
            off = lineEnd + 1;
        } else {
            const col = target - off;
            removed += Math.min(col, n);
            break;
        }
    }
    return removed;
}

/** Map a caret offset inside `chunk` to its position after the outdent. */
export function editorMapCaretAfterOutdent(chunk, newChunk, rel) {
    const r = Math.max(0, rel);
    if (r >= chunk.length) return newChunk.length;
    return r - editorRemovedBeforeInChunk(chunk, r);
}

/**
 * Shift+Tab outdent while "tab inserts tab" is enabled: remove one leading \t
 * or up to 4 spaces per affected line.
 *
 * @returns {{ changed: boolean, text: string, selStart: number, selEnd: number }}
 */
export function applyEditorOutdent(text, selStart, selEnd) {
    const a = Math.min(selStart, selEnd);
    const b = Math.max(selStart, selEnd);
    const blockStart = text.lastIndexOf('\n', Math.max(0, a - 1)) + 1;
    const ref = b > a ? b - 1 : a;
    let blockEnd = text.indexOf('\n', ref);
    if (blockEnd === -1) blockEnd = text.length;

    const chunk = text.slice(blockStart, blockEnd);
    const { newChunk, changed } = editorOutdentChunk(chunk);
    if (!changed) {
        return { changed: false, text, selStart, selEnd };
    }

    const newText = text.slice(0, blockStart) + newChunk + text.slice(blockEnd);
    const anchorRel = a - blockStart;
    const focusRel = b - blockStart;
    const newA = blockStart + editorMapCaretAfterOutdent(chunk, newChunk, anchorRel);
    const newB = blockStart + editorMapCaretAfterOutdent(chunk, newChunk, focusRel);

    return {
        changed: true,
        text: newText,
        selStart: Math.min(newA, newB),
        selEnd: Math.max(newA, newB),
    };
}
