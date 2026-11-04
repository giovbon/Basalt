// Pure path helpers used by the sidebar's optimistic mutations.
//
// Paths are always vault-relative and slash-separated, never OS paths.

/** Folder part of a vault path ('' for a root-level file). */
export function folderFromPath(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.substring(0, i);
}

/** Last segment of a vault path. */
export function filenameFromPath(path) {
    return path.split('/').pop();
}

/** Media type inferred from a vault path's extension. */
export function inferTypeFromPath(path) {
    const m = /\.([^./]+)$/.exec(path);
    const ext = m ? m[1].toLowerCase() : '';
    if (ext === 'md' || ext === '') return 'note';
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
    if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
    if (ext === 'pdf') return 'document';
    return 'note';
}
