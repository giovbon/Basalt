// Vault folder tree model for the sidebar.
//
// Pure data transformation: notes + folder list in, a tree of
// { name, path, children, notes, noteCount } out. Keeping it out of the Alpine
// component makes sorting and the recursive counts testable without a DOM.

/** Key used for the synthetic root node that holds notes outside any folder. */
export const ROOT_KEY = '__root__';

/**
 * @param {Array<{name: string, path: string, folder: string}>} notes
 * @param {string[]} allFolders every folder path the vault reported, empty ones included
 * @param {(a: any, b: any) => number} compareNotes sort comparator for note arrays
 * @returns {Record<string, any>} tree keyed by folder name, with ROOT_KEY for root notes
 */
export function buildFolderTree(notes, allFolders, compareNotes) {
    const tree = {};

    // Add ALL folders from backend (including empty ones)
    allFolders.forEach(folderPath => {
        const parts = folderPath.split('/');
        let current = tree;

        parts.forEach((part, index) => {
            const fullPath = parts.slice(0, index + 1).join('/');

            if (!current[part]) {
                current[part] = {
                    name: part,
                    path: fullPath,
                    children: {},
                    notes: []
                };
            }
            current = current[part].children;
        });
    });

    // Add ALL notes to their folders (no filtering - tree only shown when no filters active)
    notes.forEach(note => {
        if (!note.folder) {
            // Root level note
            if (!tree[ROOT_KEY]) {
                tree[ROOT_KEY] = {
                    name: '',
                    path: '',
                    children: {},
                    notes: []
                };
            }
            tree[ROOT_KEY].notes.push(note);
        } else {
            // Navigate to the folder and add note
            const parts = note.folder.split('/');
            let current = tree;

            for (let i = 0; i < parts.length; i++) {
                if (!current[parts[i]]) {
                    current[parts[i]] = {
                        name: parts[i],
                        path: parts.slice(0, i + 1).join('/'),
                        children: {},
                        notes: []
                    };
                }
                if (i === parts.length - 1) {
                    current[parts[i]].notes.push(note);
                } else {
                    current = current[parts[i]].children;
                }
            }
        }
    });

    // Sort all notes arrays (create new sorted arrays for Alpine reactivity)
    const sortNotes = (obj) => {
        if (obj.notes && obj.notes.length > 0) {
            obj.notes = [...obj.notes].sort(compareNotes);
        }
        if (obj.children && Object.keys(obj.children).length > 0) {
            Object.values(obj.children).forEach(child => sortNotes(child));
        }
    };

    // Sort notes in root (create new array for reactivity)
    if (tree[ROOT_KEY] && tree[ROOT_KEY].notes) {
        tree[ROOT_KEY].notes = [...tree[ROOT_KEY].notes].sort(compareNotes);
    }

    // Sort notes in all folders
    Object.values(tree).forEach(folder => {
        if (folder.path !== undefined) { // Skip __root__ as it was already sorted
            sortNotes(folder);
        }
    });

    // Calculate and cache note counts recursively (for performance)
    const calculateNoteCounts = (folderNode) => {
        const directNotes = folderNode.notes ? folderNode.notes.length : 0;

        if (!folderNode.children || Object.keys(folderNode.children).length === 0) {
            folderNode.noteCount = directNotes;
            return directNotes;
        }

        const childNotesCount = Object.values(folderNode.children).reduce(
            (total, child) => total + calculateNoteCounts(child),
            0
        );

        folderNode.noteCount = directNotes + childNotesCount;
        return folderNode.noteCount;
    };

    // Calculate note counts for all folders
    Object.values(tree).forEach(folder => {
        if (folder.path !== undefined || folder === tree[ROOT_KEY]) {
            calculateNoteCounts(folder);
        }
    });

    return tree;
}

/** Note sort comparators, keyed by the sidebar's sort mode. */
export function noteComparator(sortMode) {
    switch (sortMode) {
        case 'z-a':
            return (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase());
        case 'newest':
            return (a, b) => (b.modified || '').localeCompare(a.modified || '');
        case 'oldest':
            return (a, b) => (a.modified || '').localeCompare(b.modified || '');
        case 'largest':
            return (a, b) => (b.size || 0) - (a.size || 0);
        case 'smallest':
            return (a, b) => (a.size || 0) - (b.size || 0);
        case 'a-z':
        default:
            return (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
}

/** Folder sort comparator (only A-Z/Z-A; other modes default to A-Z). */
export function folderComparator(sortMode) {
    if (sortMode === 'z-a') {
        return (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase());
    }
    return (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}
