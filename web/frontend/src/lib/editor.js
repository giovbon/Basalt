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

/** Map a caret offset inside `chunk` to its position after every line gains a tab. */
export function editorMapCaretAfterIndent(chunk, newChunk, rel) {
    const r = Math.max(0, rel);
    if (r >= chunk.length) return newChunk.length;
    let newlinesBefore = 0;
    for (let i = 0; i < r; i++) {
        if (chunk.charCodeAt(i) === 10 /* \n */) newlinesBefore++;
    }
    return r + newlinesBefore + 1;
}

/**
 * Tab with a multi-line selection: prefix every selected line with a tab and
 * keep the selection in place. A plain Tab (collapsed caret or a selection
 * inside one line) still inserts a single tab at the caret, which the caller
 * handles so the character lands exactly where the user is typing.
 *
 * @returns {{ changed: boolean, text: string, selStart: number, selEnd: number }}
 */
export function applyEditorIndent(text, selStart, selEnd) {
    const a = Math.min(selStart, selEnd);
    const b = Math.max(selStart, selEnd);
    if (a === b || !text.slice(a, b).includes('\n')) {
        return { changed: false, text, selStart, selEnd };
    }

    const blockStart = text.lastIndexOf('\n', Math.max(0, a - 1)) + 1;
    const ref = b > a ? b - 1 : a;
    let blockEnd = text.indexOf('\n', ref);
    if (blockEnd === -1) blockEnd = text.length;

    const chunk = text.slice(blockStart, blockEnd);
    if (chunk.length === 0) return { changed: false, text, selStart, selEnd };

    const newChunk = chunk.split('\n').map((line) => '\t' + line).join('\n');
    const newText = text.slice(0, blockStart) + newChunk + text.slice(blockEnd);
    const newA = blockStart + editorMapCaretAfterIndent(chunk, newChunk, a - blockStart);
    const newB = blockStart + editorMapCaretAfterIndent(chunk, newChunk, b - blockStart);

    return {
        changed: true,
        text: newText,
        selStart: Math.min(newA, newB),
        selEnd: Math.max(newA, newB),
    };
}

/**
 * Wrap a selection (or insert a placeholder at the caret) with markdown
 * delimiters, keeping edge whitespace outside inline wrappers so the result
 * stays valid CommonMark ("** house **" is invalid).
 *
 * @returns {{ text: string, selStart: number, selEnd: number }}
 */
export function applyMarkdownWrap(text, selStart, selEnd, before, after, placeholder = '') {
    const start = Math.min(selStart, selEnd);
    const end = Math.max(selStart, selEnd);
    const selectedText = text.substring(start, end);

    const isInline = !before.includes('\n') && !after.includes('\n');
    let leading = '';
    let trailing = '';
    let core = selectedText;
    if (isInline && selectedText) {
        const m = selectedText.match(/^(\s*)([\s\S]*?)(\s*)$/);
        leading = m[1];
        core = m[2];
        trailing = m[3];
    }
    const textToWrap = core || placeholder;

    const newText = leading + before + textToWrap + after + trailing;
    const newContent = text.substring(0, start) + newText + text.substring(end);
    const coreStart = start + leading.length + before.length;
    const coreEnd = coreStart + textToWrap.length;

    return { text: newContent, selStart: coreStart, selEnd: coreEnd };
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
