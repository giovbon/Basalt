// SVG icons for the sidebar file tree.
//
// Pure string helpers (no DOM), so the markup for a row can be unit tested
// without a browser. Shapes follow Feather icons (24x24 grid, stroked); the
// PDF variant fills the corner fold so it stays distinguishable from a note
// even before the red colour is taken into account.

const SVG_OPEN = '<svg class="tree-icon{cls}" viewBox="0 0 24 24" width="14" height="14" '
    + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    + 'stroke-linejoin="round" aria-hidden="true">';
const SVG_CLOSE = '</svg>';

const FOLDER_PATH = '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>';

const NOTE_PATHS =
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
    + '<path d="M14 2v6h6"/>'
    + '<path d="M16 13H8"/><path d="M16 17H8"/>';

const PDF_PATHS =
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
    + '<path d="M14 2v6h6" fill="currentColor" stroke="none"/>';

const KINDS = {
    folder: { cls: ' tree-icon--folder', paths: FOLDER_PATH },
    note: { cls: ' tree-icon--note', paths: NOTE_PATHS },
    pdf: { cls: ' tree-icon--pdf', paths: PDF_PATHS },
};

/**
 * Which tree icon a NoteRecord type maps to.
 * The backend reports "document" for PDFs; everything else (image, audio,
 * video) keeps the emoji the app already shows.
 * @param {string} type NoteRecord.type
 * @returns {'folder'|'note'|'pdf'|null}
 */
export function treeIconKind(type) {
    if (type === 'folder') return 'folder';
    if (type === 'note') return 'note';
    if (type === 'document' || type === 'pdf') return 'pdf';
    return null;
}

/**
 * @param {'folder'|'note'|'pdf'} kind
 * @returns {string} inline <svg> markup, empty string for unknown kinds
 */
export function treeIconSvg(kind) {
    const spec = KINDS[kind];
    if (!spec) return '';
    return SVG_OPEN.replace('{cls}', spec.cls) + spec.paths + SVG_CLOSE;
}

/** Class that colours the row for a given tree kind. */
export function treeKindClass(kind) {
    switch (kind) {
        case 'folder': return 'tree--folder';
        case 'note': return 'tree--note';
        case 'pdf': return 'tree--pdf';
        default: return 'tree--media';
    }
}
