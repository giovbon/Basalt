// NoteDiscovery Frontend Application

// Configuration constants
const CONFIG = {
    AUTOSAVE_DELAY: 1000,              // ms - Fallback only; runtime value lives on this.autosaveDelayMs (hydrated from /api/config). Used by autoSave().
    DEFAULT_THEME: 'light',            // Fallback only; runtime value lives on this.defaultTheme (hydrated from /api/config). Used by initTheme() when localStorage has no saved preference.
    UPLOAD_MAX_NOTE_MB: 10,            // MB - Fallback only; runtime value lives on this.uploadMaxNoteMb (hydrated from /api/config). Used by importMarkdownFile() to cap drag-drop .md imports.
    SEARCH_DEBOUNCE_DELAY: 500,        // ms - Delay before running note search while typing
    SEARCH_MIN_QUERY_LENGTH: 2,        // Shorter queries show the folder tree instead of searching
    SAVE_INDICATOR_DURATION: 2000,     // ms - How long to show "saved" indicator
    SCROLL_SYNC_DELAY: 50,             // ms - Delay to prevent scroll sync interference
    SCROLL_SYNC_MAX_RETRIES: 10,       // Maximum attempts to find editor/preview elements
    SCROLL_SYNC_RETRY_INTERVAL: 100,   // ms - Time between setupScrollSync retries
    MAX_UNDO_HISTORY: 50,              // Maximum number of undo steps to keep
    DEFAULT_SIDEBAR_WIDTH: 256,        // px - Default sidebar width (w-64 in Tailwind)
    TOAST_MAX_VISIBLE: 4,              // Max stacked toasts; oldest dropped when exceeded
    TOAST_DURATION_ERROR_MS: 7000,
    TOAST_DURATION_WARNING_MS: 5500,
    TOAST_DURATION_INFO_MS: 4500,
    TOAST_DURATION_SUCCESS_MS: 3500,
};

// Combining marks removed by _foldForSearch (accent-insensitive matching).
const SEARCH_COMBINING_MARKS = /\p{M}/gu;

// localStorage settings configuration - centralized definition of all persisted settings
const LOCAL_SETTINGS = {
    // Boolean settings
    syntaxHighlightEnabled: { key: 'syntaxHighlightEnabled', type: 'boolean', default: false },
    readableLineLength: { key: 'readableLineLength', type: 'boolean', default: true },
    favoritesExpanded: { key: 'favoritesExpanded', type: 'boolean', default: true },
    tagsExpanded: { key: 'tagsExpanded', type: 'boolean', default: false },
    hideUnderscoreFolders: { key: 'hideUnderscoreFolders', type: 'boolean', default: false },
    tabInsertsTab: { key: 'tabInsertsTab', type: 'boolean', default: false },
    sidebarPanelCollapsed: { key: 'sidebarPanelCollapsed', type: 'boolean', default: false },
    autoFillNoteTitle: { key: 'autoFillNoteTitle', type: 'boolean', default: false },
    // String settings
    sortMode: { key: 'sortMode', type: 'string', default: 'a-z' },
    newButtonAction: {
        key: 'newButtonAction', type: 'string', default: 'chooser',
        valid: ['chooser', 'note', 'folder']
    },
    // Number settings with validation
    sidebarWidth: { key: 'sidebarWidth', type: 'number', default: CONFIG.DEFAULT_SIDEBAR_WIDTH, min: 200, max: 600 },
    editorWidth: { key: 'editorWidth', type: 'number', default: 50, min: 20, max: 80 },
    // String settings with validation
    viewMode: { key: 'viewMode', type: 'string', default: 'split', valid: ['edit', 'split', 'preview'] },
    // Homepage layout. Cards stay the default so existing vaults look unchanged.
    homepageView: { key: 'homepageView', type: 'string', default: 'cards', valid: ['cards', 'list'] },
    // JSON settings
    favorites: { key: 'noteFavorites', type: 'json', default: [] },
};

// Centralized error handling
const ErrorHandler = {
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
            window.dispatchEvent(new CustomEvent('notediscovery:toast', {
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
function encodeVaultPath(path) {
    if (!path) return '';
    return String(path).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Centralized filename validation
 * Supports Unicode characters (international text) but blocks dangerous filesystem characters.
 * Does NOT silently modify filenames - validates and returns status.
 */
const FilenameValidator = {
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

/** Max leading spaces Shift+Tab removes per line when matching one “tab indent” vs \t inserts. */
const EDITOR_TAB_OUTDENT_MAX_SPACES = 4;

const MEDIA_FORMATS_DISPLAY = 'JPG, PNG, GIF, WebP, MP3, MP4, PDF, MD';

/** GFM task item as (everything up to `[`)(state). Literal spaces around the
 *  brackets, not \s, because that is what marked requires; the leading chain covers
 *  containers opened on the same line, e.g. `- > - [ ] x`, which marked does render.
 *  Missing a task marked renders is the one unsafe direction: see _scanTaskLines. */
const TASK_ITEM_RE = /^(\s*(?:(?:[-*+]|\d{1,9}[.)]) +|>\s*)*(?:[-*+]|\d{1,9}[.)]) +\[)([ xX])(?=\] )/;

function editorIndentRemoveLen(lineSegment) {
    if (!lineSegment || lineSegment.length === 0) return 0;
    if (lineSegment.charCodeAt(0) === 9 /* \t */) return 1;
    let i = 0;
    const max = Math.min(EDITOR_TAB_OUTDENT_MAX_SPACES, lineSegment.length);
    while (i < max && lineSegment[i] === ' ') i++;
    return i;
}

function editorOutdentChunk(chunk) {
    if (chunk.length === 0) return { newChunk: chunk, changed: false };
    const lines = chunk.split('\n');
    const newLines = lines.map((line) => {
        const n = editorIndentRemoveLen(line);
        return n > 0 ? line.slice(n) : line;
    });
    const newChunk = newLines.join('\n');
    return { newChunk, changed: newChunk !== chunk };
}

function editorRemovedBeforeInChunk(chunk, rel) {
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

function editorMapCaretAfterOutdent(chunk, newChunk, rel) {
    const r = Math.max(0, rel);
    if (r >= chunk.length) return newChunk.length;
    return r - editorRemovedBeforeInChunk(chunk, r);
}

/**
 * Shift+Tab outdent while “tab inserts tab” is enabled: remove one leading \t or up to 4 spaces per affected line.
 * @returns {{ changed: boolean, text: string, selStart: number, selEnd: number }}
 */
function applyEditorOutdent(text, selStart, selEnd) {
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

function noteApp() {
    return {
        // App state
        appName: 'NoteDiscovery',
        appVersion: '0.0.0',
        authEnabled: false,
        demoMode: false,
        alreadyDonated: false,
        autosaveDelayMs: CONFIG.AUTOSAVE_DELAY,  // hydrated from /api/config in loadConfig()
        defaultTheme: CONFIG.DEFAULT_THEME,      // hydrated from /api/config in loadConfig()
        uploadMaxNoteMb: CONFIG.UPLOAD_MAX_NOTE_MB, // hydrated from /api/config in loadConfig()
        notes: [],

        // True while /api/notes is in flight. Drives the "Loading your vault…"
        // placeholder + the delayed overlay (notesLoadingShowOverlay).
        notesLoading: true,
        notesLoadingShowOverlay: false,
        _notesLoadingOverlayTimer: null,

        currentNote: '',
        currentNoteName: '',
        noteContent: '',
        viewMode: 'split', // 'edit', 'split', 'preview'
        searchQuery: '',
        
        // Graph state (separate overlay, doesn't affect viewMode)
        showGraph: false,
        graphInstance: null,
        graphLoaded: false,
        graphEmpty: false,   // vault returned zero nodes — show the empty state
        graphError: '',      // non-empty: message shown instead of the canvas
        graphData: null,
        searchResults: [],
        currentSearchHighlight: '', // Track current highlighted search term
        currentMatchIndex: 0, // Current match being viewed
        totalMatches: 0, // Total number of matches in the note
        isSaving: false,
        lastSaved: false,
        noteBaseHash: null,        // Fingerprint of the current note as last read or written on disk
        _saveQueued: false,        // A save was requested while another was in flight
        _saveConflictOpen: false,  // The "changed elsewhere" prompt is showing; saves wait
        linkCopied: false,
        zenMode: false,
        // Hides only the .sidebar-panel content (files / search / tags / outline / etc.) while
        // keeping the icon rail visible — a lighter "focus mode" than zenMode. Persisted via
        // LOCAL_SETTINGS so it survives reload; hydrated by loadLocalSettings() at app init,
        // which is why the initial value here matches the LOCAL_SETTINGS default.
        sidebarPanelCollapsed: false,
        previousViewMode: 'split',
        favorites: [],
        favoritesSet: new Set(), // For O(1) lookups
        favoritesExpanded: true,
        saveTimeout: null,
        
        // Note lookup maps for O(1) wikilink resolution (built on loadNotes).
        // Values are the note's URL path (path without .md). Mirrors the rule
        // order of vault.LinkResolver: see resolveWikiLink().
        _noteLookup: {
            byPath: new Map(),           // path (with/without .md) -> urlPath
            byPathLower: new Map(),      // path.toLowerCase() -> urlPath
            byName: new Map(),           // stem (with/without .md) -> urlPath
            byNameLower: new Map(),      // stem.toLowerCase() -> urlPath
        },
        
        // Media lookup map for O(1) media wikilink resolution (built on loadNotes)
        // Maps media filename (case-insensitive) -> full path
        _mediaLookup: new Map(),
        
        // Preview rendering debounce
        _previewDebounceTimeout: null,
        _lastRenderedContent: '',
        _lastRenderedNote: '',
        _cachedRenderedHTML: '',
        _mathDebounceTimeout: null,
        _mermaidDebounceTimeout: null,
        
        // Theme state
        currentTheme: 'light',
        availableThemes: [],
        
        // Locale/i18n state
        currentLocale: localStorage.getItem('locale') || 'pt-BR',
        availableLocales: [],
        // Translations loaded from backend (preloaded before Alpine init via window.__preloadedTranslations)
        translations: window.__preloadedTranslations || {},
        
        // Syntax highlighting
        syntaxHighlightEnabled: false,
        syntaxHighlightTimeout: null,
        
        // Readable line length (preview max-width)
        readableLineLength: true,
        
        // Hide underscore-prefixed folders (_attachments, _templates) from sidebar
        // Read synchronously to prevent flash on initial render
        hideUnderscoreFolders: localStorage.getItem('hideUnderscoreFolders') === 'true',

        // Tab key inserts tab character instead of changing focus
        tabInsertsTab: localStorage.getItem('tabInsertsTab') === 'true',

        // Note sorting mode (a-z, z-a, newest, oldest, largest, smallest)
        sortMode: localStorage.getItem('sortMode') || 'a-z',

        // Icon rail / panel state
        activePanel: 'files', // 'files', 'search', 'tags', 'outline', 'backlinks', 'settings'
        
        // Folder state
        folderTree: [],
        allFolders: [],
        expandedFolders: new Set(),
        dragOverFolder: null,  // Track which folder is being hovered during drag
        
        // Tags state
        allTags: {},
        selectedTags: [],
        tagsExpanded: false,
        tagReloadTimeout: null, // For debouncing tag reloads

        // Search state
        searchDebounceTimeout: null,
        isSearching: false,
        expandedSearchResults: {}, // note path -> true when its occurrence list is open
        
        // Outline (TOC) state
        outline: [], // [{level: 1, text: 'Heading', slug: 'heading'}, ...]

        // Backlinks state
        backlinks: [], // [{path: 'note.md', name: 'Note', references: [{line_number: 5, context: '...', type: 'wikilink'}]}]

        // Scroll sync state
        isScrolling: false,
        // performance.now() until which scroll events come from programmatic
        // writes (search jump) and must not be mirrored between panes.
        _scrollSyncSuppressUntil: 0,
        
        // Unified drag state for notes, folders, and media
        draggedItem: null,  // { path: string, type: 'note' | 'folder' | 'image' | 'audio' | 'video' | 'document' }
        dropTarget: null,   // 'editor' | 'folder' | null
        externalDragActive: false,  // true while OS files (not sidebar items) are being dragged over the editor
        
        // Undo/Redo history
        undoHistory: [],
        redoHistory: [],
        maxHistorySize: CONFIG.MAX_UNDO_HISTORY,
        isUndoRedo: false,
        hasPendingHistoryChanges: false,

        // Per-note editor scroll position, keyed by note path. Captured when leaving a note in
        // loadNote() and restored when returning to the same note in the same session. Stays
        // in memory only — cleared on page reload, intentionally (matches typical editor UX).
        noteScrollPositions: {},
        
        // Note metadata (frontmatter) state
        noteMetadata: null,
        metadataExpanded: false,
        // Sidebar resize state
        sidebarWidth: CONFIG.DEFAULT_SIDEBAR_WIDTH,
        isResizing: false,
        
        // Mobile sidebar state
        mobileSidebarOpen: false,
        
        // Split view resize state
        editorWidth: 50, // percentage
        isResizingSplit: false,
        
        // Dropdown state
        showNewDropdown: false,
        dropdownTargetFolder: null, // Folder context for "New" dropdown ('' = root, null = not set)
        dropdownPosition: { top: 0, left: 0 }, // Position for contextual dropdown

        // Wikilink / media autocomplete (triggered by [[ for notes, ![[ for media)
        wikilinkAutocomplete: {
            open: false,
            mode: 'note',        // 'note' | 'media'
            query: '',
            tokenStart: 0,       // index in noteContent right after the opening [[
            items: [],           // [{label, secondary, insert, kind, prefix, modified}]
            activeIndex: 0,
            position: { top: 0, left: 0 },
        },
        _noteNameCounts: new Map(), // lower note stem -> count, for name-vs-path insertion
        
        newButtonAction: 'chooser',
        autoFillNoteTitle: false,
        
        // New note / folder name modal (replaces window.prompt)
        showCreateNameModal: false,
        createNameModalKind: 'note',
        createNameModalTargetFolder: '',
        createNameModalInput: '',
        
        // Rename folder modal (replaces window.prompt)
        showRenameFolderModal: false,
        renameFolderPath: '',
        renameFolderOldName: '',
        renameFolderInput: '',
        
        // Generic confirm dialog (replaces window.confirm)
        showConfirmModal: false,
        confirmModalTitle: '',
        confirmModalMessage: '',
        confirmModalDanger: true,
        confirmModalConfirmLabel: '',
        confirmModalCancelLabel: '',
        _confirmModalResolve: null,
        
        // Quick Switcher state (Ctrl+Alt+P)
        showQuickSwitcher: false,
        quickSwitcherQuery: '',
        quickSwitcherIndex: 0,
        quickSwitcherResults: [],
        
        // Non-blocking notifications (replaces window.alert)
        toasts: [],
        _toastIdSeq: 0,
        
        // Homepage state
        selectedHomepageFolder: '',
        _homepageCache: {
            folderPath: null,
            notes: null,
            folders: null,
            breadcrumb: null
        },
        
        // Homepage constants
        HOMEPAGE_MAX_NOTES: 50,
        // Read before init() so the first paint matches the saved layout.
        homepageView: localStorage.getItem('homepageView') === 'list' ? 'list' : 'cards',
        // Name filter for the current homepage folder. Separate from searchQuery,
        // which is the sidebar's full-text search.
        homepageNameQuery: '',
        
        // Computed-like helpers for homepage (cached for performance)
        homepageNotes() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.notes) {
                return this._homepageCache.notes;
            }
            
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return [];
            }
            
            const folderNode = this.getFolderNode(this.selectedHomepageFolder || '');
            const result = (folderNode && Array.isArray(folderNode.notes)) ? folderNode.notes : [];
            
            // Cache the result
            this._homepageCache.notes = result;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return result;
        },
        
        homepageFolders() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.folders) {
                return this._homepageCache.folders;
            }
            
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return [];
            }
            
            // Get child folders
            let childFolders = [];
            if (!this.selectedHomepageFolder) {
                // Root level: all top-level folders
                childFolders = Object.entries(this.folderTree)
                    .filter(([key]) => key !== '__root__')
                    .map(([, folder]) => folder);
            } else {
                // Inside a folder: get its children
                const parentFolder = this.getFolderNode(this.selectedHomepageFolder);
                if (parentFolder && parentFolder.children) {
                    childFolders = Object.values(parentFolder.children);
                }
            }
            
            // Map to simplified structure (note count already cached in folder node)
            const result = childFolders
                .map(folder => ({
                    name: folder.name,
                    path: folder.path,
                    noteCount: folder.noteCount || 0  // Use pre-calculated count
                }))
                .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
            
            // Cache the result
            this._homepageCache.folders = result;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return result;
        },
        
        homepageBreadcrumb() {
            // Return cached result if folder hasn't changed
            if (this._homepageCache.folderPath === this.selectedHomepageFolder && this._homepageCache.breadcrumb) {
                return this._homepageCache.breadcrumb;
            }
            
            const breadcrumb = [{ name: this.t('homepage.title'), path: '' }];
            
            if (this.selectedHomepageFolder) {
                const parts = this.selectedHomepageFolder.split('/').filter(Boolean);
                let currentPath = '';
                
                parts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}/${part}` : part;
                    breadcrumb.push({ name: part, path: currentPath });
                });
            }
            
            // Cache the result
            this._homepageCache.breadcrumb = breadcrumb;
            this._homepageCache.folderPath = this.selectedHomepageFolder;
            
            return breadcrumb;
        },

        setHomepageView(mode) {
            if (mode !== 'cards' && mode !== 'list') return;
            if (mode === this.homepageView) return;
            this.homepageView = mode;
            localStorage.setItem('homepageView', mode);
        },

        homepageNameNeedle() {
            return (this.homepageNameQuery || '').trim().toLowerCase();
        },

        // Filter the current folder's notes or folders by name. An empty query
        // returns the cached source array so Alpine does not rebuild the grid.
        // Notes and folders keep separate cache entries: they share a folder, but
        // a hit for one must not satisfy the other.
        _filterHomepageByName(items, kind) {
            const needle = this.homepageNameNeedle();
            if (!needle) return items;
            const cacheKey = kind === 'notes' ? 'noteFilter' : 'folderFilter';
            const cache = this._homepageCache;
            const entry = cache[cacheKey];
            if (entry && entry.needle === needle && entry.source === items) {
                return entry.result;
            }
            const filtered = items.filter(item => (item.name || '').toLowerCase().includes(needle));
            cache[cacheKey] = { needle, source: items, result: filtered };
            return filtered;
        },

        homepageVisibleNotes() {
            return this._filterHomepageByName(this.homepageNotes(), 'notes');
        },

        homepageVisibleFolders() {
            return this._filterHomepageByName(this.homepageFolders(), 'folders');
        },
        
        // Helper: Format file size nicely
        formatSize(bytes) {
            if (!bytes) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        },
        
        // Helper: Format date using current locale
        formatDate(dateStr) {
            if (!dateStr) return '';
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return '';
            return date.toLocaleDateString(this.currentLocale, { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            });
        },
        
        getFolderNode(folderPath = '') {
            if (!this.folderTree || typeof this.folderTree !== 'object') {
                return null;
            }
            
            if (!folderPath) {
                return this.folderTree['__root__'] || { name: '', path: '', children: {}, notes: [], noteCount: 0 };
            }
            
            const parts = folderPath.split('/').filter(Boolean);
            let currentLevel = this.folderTree;
            let node = null;
            
            for (const part of parts) {
                if (!currentLevel[part]) {
                    return null;
                }
                node = currentLevel[part];
                currentLevel = node.children || {};
            }
            
            return node;
        },
        
        // Check if app is empty (no notes and no folders)
        get isAppEmpty() {
            const notesArray = Array.isArray(this.notes) ? this.notes : [];
            const foldersArray = Array.isArray(this.allFolders) ? this.allFolders : [];
            return notesArray.length === 0 && foldersArray.length === 0;
        }, 
        
        // Mermaid state cache
        lastMermaidTheme: null,
        
        // Media viewer state
        currentMedia: '',  // Path to current media file (kept as 'currentMedia' for compatibility)
        currentMediaType: 'image',  // 'image', 'audio', 'video', 'document'
        
        // DOM element cache (to avoid repeated querySelector calls)
        _domCache: {
            editor: null,
            previewContainer: null,
            previewContent: null
        },
        
        // Initialize app
        async init() {
            // Prevent double initialization (Alpine.js may call x-init twice in some cases)
            if (window.__noteapp_initialized) return;
            window.__noteapp_initialized = true;
            
            // Store global reference for native event handlers in x-html content
            window.$root = this;

            // Hover cards for internal links in the preview
            this.initLinkPreviews();
            
            // ESC key to cancel drag operations
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.draggedItem) {
                    this.cancelDrag();
                }
            });
            
            await this.loadConfig();
            await this.loadThemes();
            await this.initTheme();
            await this.loadAvailableLocales();
            // Note: Translations are preloaded synchronously before Alpine init (see index.html)
            // loadLocale() is only called when user changes language from settings
            await this.loadNotes();
            this.loadLocalSettings();
            
            // Parse URL and load specific note if provided
            this.loadItemFromURL();
            
            // Set initial homepage state ONLY if we're actually on the homepage
            if (window.location.pathname === '/') {
                window.history.replaceState({ homepageFolder: '' }, '', '/');
                document.title = this.appName;
            }
            
            // Listen for browser back/forward navigation
            window.addEventListener('popstate', (e) => {
                if (e.state && e.state.notePath) {
                    // Navigating to a note
                    const searchQuery = e.state.searchQuery || '';
                    const targetLine = e.state.targetLine || null;
                    const targetColumn = e.state.targetColumn || null;
                    this.loadNote(e.state.notePath, false, searchQuery, targetLine, targetColumn); // false = don't update history
                    
                    // Update search box and trigger search if needed
                    if (searchQuery) {
                        this.searchQuery = searchQuery;
                        this.searchNotes();
                    } else {
                        this.searchQuery = '';
                        this.searchResults = [];
                        this.expandedSearchResults = {};
                        this.clearSearchHighlights();
                    }
                } else if (e.state && e.state.mediaPath) {
                    // Navigating to a media file
                    this.viewMedia(e.state.mediaPath, null, false);
                } else {
                    // Navigating back to homepage
                    this.currentNote = '';
                    this.noteContent = '';
                    this.currentNoteName = '';
                    this.outline = [];
                    this.backlinks = [];
                    document.title = this.appName;
                    
                    // Restore homepage folder state if it was saved
                    if (e.state && e.state.homepageFolder !== undefined) {
                        this.selectedHomepageFolder = e.state.homepageFolder || '';
                    } else {
                        // No folder state in history, go to root
                        this.selectedHomepageFolder = '';
                    }
                    
                    // Invalidate cache to force recalculation
                    this._homepageCache = {
                        folderPath: null,
                        notes: null,
                        folders: null,
                        breadcrumb: null
                    };
                    
                    // Clear search
                    this.searchQuery = '';
                    this.searchResults = [];
                    this.expandedSearchResults = {};
                    this.clearSearchHighlights();
                }
            });
            
            // Cache DOM references after initial render
            this.$nextTick(() => {
                this.refreshDOMCache();
            });
            
            // Setup mobile view mode handler
            this.setupMobileViewMode();
            
            // Watch view mode changes and auto-save
            this.$watch('viewMode', (newValue) => {
                this.saveViewMode();
                // Suppress scroll-position stores while Alpine toggles the
                // panes' visibility: for a few ms after the switch the pane
                // that is going away can still fire scroll events from a
                // degenerate layout (width 0), and the bogus editorPct they
                // produce is applied to the editor by _restoreNoteScroll(),
                // which is what made the editor jump to the end of the note.
                this._viewModeSwitching = true;
                // Re-apply the saved scroll position to whichever pane just became visible.
                // x-show toggles display:none/block; an overflow:auto element resets its
                // scrollTop on that transition, so the previously-hidden pane lands at 0
                // unless we explicitly restore. $nextTick waits for Alpine to flush the
                // x-show change, the rAF then waits for layout so scrollHeight is valid.
                this.$nextTick(() => {
                    requestAnimationFrame(() => {
                        this._restoreNoteScroll();
                        // One more frame: lets any scroll event emitted by the
                        // layout settle pass through while still suppressed.
                        requestAnimationFrame(() => {
                            this._viewModeSwitching = false;
                        });
                    });
                });
            });
            
            // Watch for changes in note content to re-apply search highlights
            this.$watch('noteContent', () => {
                if (this.currentSearchHighlight) {
                    // Re-apply highlights after content changes (with small delay for render)
                    this.$nextTick(() => {
                        setTimeout(() => {
                            this._reapplySearchHighlights();
                        }, 50);
                    });
                }
            });
            
            // Watch tags panel expanded state and save to localStorage
            this.$watch('tagsExpanded', () => {
                this.saveTagsExpanded();
            });
            
            // Watch favorites expanded state and save to localStorage
            this.$watch('favoritesExpanded', () => {
                this.saveFavoritesExpanded();
            });
            
            // Setup keyboard shortcuts (only once to prevent double triggers)
            if (!window.__noteapp_shortcuts_initialized) {
                window.__noteapp_shortcuts_initialized = true;
                window.addEventListener('keydown', (e) => {
                    // Use e.key (not e.code) for letter keys to support non-QWERTY keyboard layouts
                    
                    // Ctrl/Cmd + S to save the current note
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                        e.preventDefault();
                        this.saveNote();
                    }
                    
                    // Ctrl/Cmd + Alt + P for Quick Switcher
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'p') {
                        e.preventDefault();
                        this.openQuickSwitcher();
                        return;
                    }
                    
                    // Ctrl/Cmd + Alt/Option + N for new note
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'n') {
                        e.preventDefault();
                        this.createNote();
                    }
                    
                    // Ctrl/Cmd + Alt/Option + F for new folder
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'f') {
                        e.preventDefault();
                        this.createFolder();
                    }
                    
                    // Ctrl/Cmd + Z for undo
                    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
                        e.preventDefault();
                        this.undo();
                    }
                    
                    // Ctrl/Cmd + Y OR Ctrl/Cmd+Shift+Z for redo
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                        e.preventDefault();
                        this.redo();
                    }
                    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
                        e.preventDefault();
                        this.redo();
                    }
                    
                    // F3 for next search match
                    if (e.code === 'F3' && !e.shiftKey) {
                        e.preventDefault();
                        this.nextMatch();
                    }
                    
                    // Shift + F3 for previous search match
                    if (e.code === 'F3' && e.shiftKey) {
                        e.preventDefault();
                        this.previousMatch();
                    }
                    
                    // Ctrl/Cmd + Alt/Option + Z to toggle Zen mode.
                    // Global (fires regardless of focus) so users can enter/exit Zen without
                    // first clicking into the editor. Requires an open note; noop otherwise.
                    if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 'z') {
                        if (this.currentNote) {
                            e.preventDefault();
                            this.toggleZenMode();
                        }
                    }
                    
                    // View-mode shortcuts (global — fire regardless of focus):
                    //   Ctrl/Cmd + Alt/Option + 1  → Edit
                    //   Ctrl/Cmd + Alt/Option + 2  → Split  (falls back to Edit on mobile)
                    //   Ctrl/Cmd + Alt/Option + 3  → Preview
                    //   Ctrl/Cmd + Alt/Option + V  → Cycle Edit → Split → Preview → Edit
                    // Skipped when no note is open, in Zen mode (edit-only), or while the graph
                    // overlay is showing. Uses e.code for digits so the physical top-row keys
                    // fire on AZERTY/QWERTZ layouts (where 1/2/3 need Shift) and to bypass
                    // Mac's Option+digit dead-key composer (Option+1 = ¡, etc.).
                    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey
                        && this.currentNote && !this.zenMode && !this.showGraph) {
                        const isMobile = window.innerWidth <= 768;
                        let targetMode = null;
                        if (e.code === 'Digit1') {
                            targetMode = 'edit';
                        } else if (e.code === 'Digit2') {
                            targetMode = isMobile ? 'edit' : 'split';
                        } else if (e.code === 'Digit3') {
                            targetMode = 'preview';
                        } else if (e.key.toLowerCase() === 'v') {
                            if (isMobile) {
                                targetMode = this.viewMode === 'edit' ? 'preview' : 'edit';
                            } else {
                                const order = ['edit', 'split', 'preview'];
                                const currentIdx = order.indexOf(this.viewMode);
                                targetMode = order[(currentIdx + 1) % order.length];
                            }
                        }
                        if (targetMode !== null) {
                            e.preventDefault();
                            this.viewMode = targetMode;
                        }
                    }
                    
                    // Only apply markdown shortcuts when editor is focused and a note is open
                    const isEditorFocused = document.activeElement?.id === 'note-editor';
                    if (isEditorFocused && this.currentNote) {
                        // Ctrl/Cmd + B for bold
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
                            e.preventDefault();
                            this.wrapSelection('**', '**', 'bold text');
                        }
                        
                        // Ctrl/Cmd + I for italic
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
                            e.preventDefault();
                            this.wrapSelection('*', '*', 'italic text');
                        }
                        
                        // Ctrl/Cmd + K for link
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                            e.preventDefault();
                            this.insertLink();
                        }
                        
                        // Ctrl/Cmd + Alt/Option + T for table
                        if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === 't') {
                            e.preventDefault();
                            this.insertTable();
                        }
                    }
                    
                    // Escape to exit Zen mode (works anywhere)
                    if (e.key === 'Escape' && this.zenMode) {
                        e.preventDefault();
                        this.toggleZenMode();
                    }
                });
            }
            
            // Note: setupScrollSync() is called when a note is loaded (see loadNote())
            
            // Listen for system theme changes
            if (window.matchMedia) {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
                    if (this.currentTheme === 'system') {
                        this.applyTheme('system');
                    }
                });
            }
            
            // Listen for fullscreen changes (to sync zen mode state)
            document.addEventListener('fullscreenchange', () => {
                if (!document.fullscreenElement && this.zenMode) {
                    // User exited fullscreen manually, exit zen mode too
                    this.zenMode = false;
                    this.viewMode = this.previousViewMode;
                }
            });
            
            // Toasts from ErrorHandler and code paths without Alpine `this`
            if (!window.__noteapp_toast_listener) {
                window.__noteapp_toast_listener = true;
                window.addEventListener('notediscovery:toast', (e) => {
                    const d = e.detail || {};
                    if (typeof d.message !== 'string' || !d.message) return;
                    this.toast(d.message, {
                        type: d.type || 'error',
                        durationMs: d.durationMs
                    });
                });
            }
        },
        
        // Load app configuration
        async loadConfig() {
            try {
                const response = await fetch('/api/config');
                const config = await response.json();
                this.appName = config.name;
                this.appVersion = config.version || '0.0.0';
                this.authEnabled = config.authentication?.enabled || false;
                this.demoMode = config.demoMode || false;
                this.alreadyDonated = config.alreadyDonated || false;
                // Server already clamps autosaveDelayMs to a sane range; we just sanity-check the type.
                if (Number.isFinite(config.autosaveDelayMs) && config.autosaveDelayMs > 0) {
                    this.autosaveDelayMs = config.autosaveDelayMs;
                }
                if (typeof config.defaultTheme === 'string' && config.defaultTheme) {
                    this.defaultTheme = config.defaultTheme;
                }
                if (Number.isFinite(config.uploadMaxNoteMb) && config.uploadMaxNoteMb > 0) {
                    this.uploadMaxNoteMb = config.uploadMaxNoteMb;
                }
            } catch (error) {
                console.error('Failed to load config:', error);
            }
        },
        
        // Load available themes from backend
        async loadThemes() {
            try {
                const response = await fetch('/api/themes');
                const data = await response.json();
                
                // Use theme names directly from backend (already include emojis)
                this.availableThemes = data.themes;
            } catch (error) {
                console.error('Failed to load themes:', error);
                // Fallback to default themes
                this.availableThemes = [
                    { id: 'light', name: '🌞 Light' },
                    { id: 'dark', name: '🌙 Dark' }
                ];
            }
        },
        
        // Initialize theme system
        async initTheme() {
            // A user's saved preference takes priority over the configured default.
            const savedTheme = localStorage.getItem('noteDiscoveryTheme') || this.defaultTheme;
            this.currentTheme = savedTheme;
            await this.applyTheme(savedTheme);
        },
        
        // Set and apply theme
        async setTheme(themeId) {
            this.currentTheme = themeId;
            localStorage.setItem('noteDiscoveryTheme', themeId);
            await this.applyTheme(themeId);
        },
        
        // Syntax highlighting toggle
        toggleSyntaxHighlight() {
            this.syntaxHighlightEnabled = !this.syntaxHighlightEnabled;
            localStorage.setItem('syntaxHighlightEnabled', this.syntaxHighlightEnabled);
            if (this.syntaxHighlightEnabled) {
                this.updateSyntaxHighlight();
            }
        },
        
        // Load all localStorage settings at once using centralized config
        loadLocalSettings() {
            for (const [prop, config] of Object.entries(LOCAL_SETTINGS)) {
                try {
                    const saved = localStorage.getItem(config.key);
                    
                    if (saved === null) {
                        // Use default value if not set
                        this[prop] = config.default;
                    } else if (config.type === 'boolean') {
                        this[prop] = saved === 'true';
                    } else if (config.type === 'number') {
                        const num = parseFloat(saved);
                        // Validate range if specified
                        if (!isNaN(num) && 
                            (config.min === undefined || num >= config.min) && 
                            (config.max === undefined || num <= config.max)) {
                            this[prop] = num;
                        } else {
                            this[prop] = config.default;
                        }
                    } else if (config.type === 'string') {
                        // Validate against allowed values if specified
                        if (!config.valid || config.valid.includes(saved)) {
                            this[prop] = saved;
                        } else {
                            this[prop] = config.default;
                        }
                    } else if (config.type === 'json') {
                        this[prop] = JSON.parse(saved);
                    }
                } catch (error) {
                    console.error(`Error loading setting ${prop}:`, error);
                    this[prop] = config.default;
                }
            }
            
            // Special case: favorites also needs to update the Set for O(1) lookups
            this.favoritesSet = new Set(this.favorites);
        },
        
        // Readable line length toggle (for preview max-width)
        toggleReadableLineLength() {
            this.readableLineLength = !this.readableLineLength;
            localStorage.setItem('readableLineLength', this.readableLineLength);
        },
        
        // Hide underscore folders toggle (sidebar tree and graph)
        toggleHideUnderscoreFolders() {
            this.hideUnderscoreFolders = !this.hideUnderscoreFolders;
            localStorage.setItem('hideUnderscoreFolders', this.hideUnderscoreFolders);
            if (this.showGraph) {
                this.initGraph();
            }
        },

        // Tab inserts tab toggle (Tab key inserts tab character instead of changing focus)
        toggleTabInsertsTab() {
            this.tabInsertsTab = !this.tabInsertsTab;
            localStorage.setItem('tabInsertsTab', this.tabInsertsTab);
        },

        // Hide / show only the sidebar PANEL (files, search, outline, etc.); the icon rail
        // stays put so users can still switch panels with one click after re-expanding.
        // Width is animated via CSS; sidebarWidth itself is intentionally NOT touched, so a
        // user's custom drag-resized width is restored automatically on expand.
        toggleSidebarPanel() {
            this.sidebarPanelCollapsed = !this.sidebarPanelCollapsed;
            localStorage.setItem('sidebarPanelCollapsed', this.sidebarPanelCollapsed);
        },

        // Switch the active sidebar panel (Files / Search / Tags / Outline / Backlinks
        // / Settings) with smart toggle behaviour for the icon rail:
        //
        //   collapsed       + click any icon X  → expand + switch to X
        //   expanded, on Y  + click icon X      → switch to X (no collapse change)
        //   expanded, on X  + click icon X      → collapse (symmetric "click active to close")
        //
        // That third rule matches the VS Code / Cursor / JetBrains / Obsidian convention where
        // re-clicking the active sidebar icon hides the panel. Without it, the only way to
        // collapse would be the dedicated toggle button, which is fine but leaves an asymmetry.
        //
        // On mobile (≤768px) the desktop collapse is CSS-overridden, so the panel is always
        // visible; we deliberately skip toggling in that case so a one-off mobile tap doesn't
        // silently clear the user's persisted desktop preference.
        openSidebarPanel(panelName) {
            const isDesktop = window.innerWidth > 768;
            if (isDesktop && this.activePanel === panelName && !this.sidebarPanelCollapsed) {
                this.toggleSidebarPanel();
                return;
            }
            this.activePanel = panelName;
            if (isDesktop && this.sidebarPanelCollapsed) {
                this.toggleSidebarPanel();
            }
        },

        // Handle Tab key in editor (inserts tab if setting enabled; Shift+Tab outdents matching lines)
        handleTabKey(event) {
            if (!this.tabInsertsTab) return;

            const textarea = event.target;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;

            if (event.shiftKey) {
                const result = applyEditorOutdent(this.noteContent, start, end);
                if (!result.changed) return;
                event.preventDefault();
                this.noteContent = result.text;
                this.$nextTick(() => {
                    textarea.selectionStart = result.selStart;
                    textarea.selectionEnd = result.selEnd;
                });
                this.autoSave();
                return;
            }

            event.preventDefault();
            this.noteContent = this.noteContent.substring(0, start) + '\t' + this.noteContent.substring(end);
            this.$nextTick(() => {
                textarea.selectionStart = textarea.selectionEnd = start + 1;
            });
            this.autoSave();
        },

        /**
         * Enter: continue blockquote / bullet / ordered list / task list; second Enter on empty item exits (see editor-markdown-continue.js).
         */
        handleEditorEnterKey(event) {
            if (typeof EditorMarkdownContinue === 'undefined') return;
            const textarea = event.target;
            if (!textarea || textarea.id !== 'note-editor') return;

            const result = EditorMarkdownContinue.tryEnter(
                this.noteContent,
                textarea.selectionStart,
                textarea.selectionEnd,
                event
            );
            if (!result.handled) return;

            event.preventDefault();
            this.noteContent = result.text;
            this.$nextTick(() => {
                textarea.selectionStart = textarea.selectionEnd = result.cursor;
            });
            this.autoSave();
            this.updateSyntaxHighlight();
        },

        // Sort mode configuration
        sortModes: ['a-z', 'z-a', 'newest', 'oldest', 'largest', 'smallest'],
        sortModeIcons: {
            'a-z': 'A↓',
            'z-a': 'Z↓',
            'newest': '🕐↓',
            'oldest': '🕐↑',
            'largest': '📄↓',
            'smallest': '📄↑'
        },

        // Cycle through sort modes
        cycleSortMode() {
            const currentIndex = this.sortModes.indexOf(this.sortMode);
            const nextIndex = (currentIndex + 1) % this.sortModes.length;
            this.sortMode = this.sortModes[nextIndex];
            localStorage.setItem('sortMode', this.sortMode);
            // Rebuild tree to apply new sort order
            this.buildFolderTree();
        },

        // Get current sort icon
        getSortIcon() {
            return this.sortModeIcons[this.sortMode] || 'A↓';
        },

        // Get sort comparator based on current mode (for notes)
        getSortComparator() {
            switch (this.sortMode) {
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
        },

        // Get sort comparator for folders (only A-Z/Z-A, others default to A-Z)
        getFolderSortComparator() {
            if (this.sortMode === 'z-a') {
                return (a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase());
            }
            // Default: A-Z for all other modes
            return (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        },

        // Update syntax highlight overlay (debounced, called on input)
        updateSyntaxHighlight() {
            if (!this.syntaxHighlightEnabled) return;
            
            clearTimeout(this.syntaxHighlightTimeout);
            this.syntaxHighlightTimeout = setTimeout(() => {
                const overlay = document.getElementById('syntax-overlay');
                if (overlay) {
                    overlay.innerHTML = this.highlightMarkdown(this.noteContent);
                }
            }, 50); // 50ms debounce
        },
        
        // Sync overlay scroll with textarea. Per-note scroll restoration is captured separately
        // inside the _editorScrollHandler / _previewScrollHandler in setupScrollSync(), where
        // the existing isScrolling guard ensures we only record user-driven scrolls (not the
        // programmatic mirrors between panes), and where we have access to the pane the user
        // actually scrolled — important because the textarea's scroll event never fires in
        // preview-only mode (the textarea is display:none).
        syncOverlayScroll() {
            const textarea = document.getElementById('note-editor');
            const overlay = document.getElementById('syntax-overlay');
            if (textarea && overlay) {
                overlay.scrollTop = textarea.scrollTop;
                overlay.scrollLeft = textarea.scrollLeft;
            }
            if (this.wikilinkAutocomplete.open) this.wlUpdatePosition();
        },
        
        // Highlight markdown syntax
        highlightMarkdown(text) {
            if (!text) return '';
            
            // Escape HTML first
            let html = this.escapeHtml(text);
            
            // Store code blocks and inline code with placeholders to protect from other patterns
            const codePlaceholders = [];
            
            // Code blocks FIRST - protect them before anything else
            html = html.replace(/(```[\s\S]*?```)/g, (match) => {
                codePlaceholders.push('<span class="md-codeblock">' + match + '</span>');
                return `\x00CODE${codePlaceholders.length - 1}\x00`;
            });
            
            // Frontmatter (must be at VERY start of document, not any line)
            if (html.startsWith('---\n')) {
                html = html.replace(/^(---\n[\s\S]*?\n---)/, (match) => {
                    codePlaceholders.push('<span class="md-frontmatter">' + match + '</span>');
                    return `\x00CODE${codePlaceholders.length - 1}\x00`;
                });
            }
            
            // Inline code - protect it
            html = html.replace(/`([^`\n]+)`/g, (match) => {
                codePlaceholders.push('<span class="md-code">' + match + '</span>');
                return `\x00CODE${codePlaceholders.length - 1}\x00`;
            });
            
            // Now apply other patterns (they won't match inside protected code)
            
            // Headings - capture the whitespace to preserve exact characters (tabs vs spaces)
            // This prevents cursor/selection misalignment
            html = html.replace(/^(#{1,6})(\s)(.*)$/gm, '<span class="md-heading">$1$2$3</span>');
            
            // Bold (must come before italic)
            html = html.replace(/\*\*([^*]+)\*\*/g, '<span class="md-bold">**$1**</span>');
            html = html.replace(/__([^_]+)__/g, '<span class="md-bold">__$1__</span>');
            
            // Italic
            html = html.replace(/(?<![*\\])\*([^*\n]+)\*(?!\*)/g, '<span class="md-italic">*$1*</span>');
            html = html.replace(/(?<![_\\])_([^_\n]+)_(?!_)/g, '<span class="md-italic">_$1_</span>');
            
            // Wikilinks [[...]]
            html = html.replace(/\[\[([^\]]+)\]\]/g, '<span class="md-wikilink">[[$1]]</span>');
            
            // Links [text](url)
            html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="md-link">[$1]</span><span class="md-link-url">($2)</span>');
            
            // Lists - use ([ \t]) to capture the space/tab and preserve exact characters
            // IMPORTANT: Don't add any characters (like \u200B) that aren't in the original,
            // as this breaks cursor/selection alignment between textarea and overlay
            html = html.replace(/^(\s*)([-*+])([ \t])(.*)$/gm, (match, indent, bullet, space, rest) => {
                return `${indent}<span class="md-list">${bullet}</span>${space}${rest}`;
            });
            html = html.replace(/^(\s*)(\d+\.)([ \t])(.*)$/gm, (match, indent, bullet, space, rest) => {
                return `${indent}<span class="md-list">${bullet}</span>${space}${rest}`;
            });
            
            // Blockquotes
            html = html.replace(/^(&gt;.*)$/gm, '<span class="md-blockquote">$1</span>');
            
            // Horizontal rules
            html = html.replace(/^([-*_]{3,})$/gm, '<span class="md-hr">$1</span>');
            
            // Restore protected code blocks
            html = html.replace(/\x00CODE(\d+)\x00/g, (match, index) => codePlaceholders[parseInt(index)]);
            
            // Add trailing space to match textarea's phantom line for cursor
            // This ensures the overlay and textarea have the same content height
            html += '\n ';
            
            return html;
        },
        
        // Apply theme to document
        async applyTheme(themeId) {
            // Load theme CSS from file. The head preload may already have inserted
            // #dynamic-theme for this id; skip the second download and the CSS write
            // in that case. Highlight.js is still updated below, because the preload
            // does not touch #highlight-theme.
            try {
                const existing = document.getElementById('dynamic-theme');
                const alreadyLoaded = existing
                    && existing.textContent
                    && document.documentElement.getAttribute('data-theme') === themeId;

                if (!alreadyLoaded) {
                    const response = await fetch(`/api/themes/${themeId}`);
                    const data = await response.json();

                    let styleEl = existing;
                    if (!styleEl) {
                        styleEl = document.createElement('style');
                        styleEl.id = 'dynamic-theme';
                        document.head.appendChild(styleEl);
                    }
                    styleEl.textContent = data.css;

                    document.documentElement.setAttribute('data-theme', themeId);
                }
                
                // Load appropriate Highlight.js theme for code syntax highlighting
                const highlightTheme = document.getElementById('highlight-theme');
                if (highlightTheme) {
                    if (themeId === 'light') {
                        highlightTheme.href = '/static/vendor/highlight.js/styles/github.min.css';
                    } else {
                        // Use dark theme for dark/custom themes
                        highlightTheme.href = '/static/vendor/highlight.js/styles/github-dark.min.css';
                    }
                }
                
                // Re-render Mermaid diagrams with new theme if there's a current note
                if (this.currentNote) {
                    // Small delay to allow theme CSS to load
                    setTimeout(() => {
                        // Clear existing Mermaid renders
                        const previewContent = document.querySelector('.markdown-preview');
                        if (previewContent) {
                            const mermaidContainers = previewContent.querySelectorAll('.mermaid-rendered');
                            mermaidContainers.forEach(container => {
                                // Replace with the original code block for re-rendering
                                const parent = container.parentElement;
                                if (parent && container.dataset.originalCode) {
                                    const pre = document.createElement('pre');
                                    const code = document.createElement('code');
                                    code.className = 'language-mermaid';
                                    code.textContent = container.dataset.originalCode;
                                    pre.appendChild(code);
                                    parent.replaceChild(pre, container);
                                }
                            });
                        }
                        // Re-render with new theme
                        this.renderMermaid();
                    }, 100);
                }
                
                // Refresh graph if visible (longer delay to ensure CSS is applied)
                if (this.showGraph) {
                    setTimeout(() => this.initGraph(), 300);
                }
                
                // Update PWA theme-color meta tag to match current theme
                const themeColorMeta = document.querySelector('meta[name="theme-color"]');
                if (themeColorMeta) {
                    // Get the accent color from CSS variables
                    const accentColor = getComputedStyle(document.documentElement)
                        .getPropertyValue('--accent-primary').trim() || '#7c3aed';
                    themeColorMeta.setAttribute('content', accentColor);
                }
            } catch (error) {
                console.error('Failed to load theme:', error);
            }
        },
        
        // ==================== INTERNATIONALIZATION ====================
        
        // Translation function - get translated string by key
        t(key, params = {}) {
            const keys = key.split('.');
            let value = this.translations;
            
            for (const k of keys) {
                value = value?.[k];
            }
            
            // Fallback to key if translation not found (silently - default translations are inline)
            if (typeof value !== 'string') {
                return key;
            }
            
            // Replace {{param}} placeholders
            return value.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? `{{${name}}}`);
        },
        
        /**
         * Non-blocking toast (replaces window.alert). Types map to theme CSS variables.
         * @param {string} message
         * @param {{ type?: 'error'|'warning'|'info'|'success', durationMs?: number }} [options]
         * @returns {number|undefined} toast id
         */
        toast(message, options = {}) {
            if (typeof message !== 'string' || !message) return;
            const type = ['error', 'warning', 'info', 'success'].includes(options.type)
                ? options.type
                : 'info';
            let durationMs = options.durationMs;
            if (durationMs == null || typeof durationMs !== 'number' || durationMs < 0) {
                durationMs = type === 'error' ? CONFIG.TOAST_DURATION_ERROR_MS
                    : type === 'warning' ? CONFIG.TOAST_DURATION_WARNING_MS
                        : type === 'success' ? CONFIG.TOAST_DURATION_SUCCESS_MS
                            : CONFIG.TOAST_DURATION_INFO_MS;
            }
            const id = ++this._toastIdSeq;
            const entry = { id, message, type, _tid: null };
            this.toasts.push(entry);
            while (this.toasts.length > CONFIG.TOAST_MAX_VISIBLE) {
                const first = this.toasts.shift();
                if (first && first._tid) clearTimeout(first._tid);
            }
            entry._tid = setTimeout(() => this.dismissToast(id), durationMs);
            return id;
        },
        
        dismissToast(id) {
            const idx = this.toasts.findIndex((t) => t.id === id);
            if (idx === -1) return;
            const entry = this.toasts[idx];
            if (entry._tid) {
                clearTimeout(entry._tid);
                entry._tid = null;
            }
            this.toasts.splice(idx, 1);
        },
        
        /**
         * Get localized error message from FilenameValidator result
         * @param {object} validation - The validation result from FilenameValidator
         * @param {string} type - 'note' or 'folder'
         * @returns {string} Localized error message
         */
        getValidationErrorMessage(validation, type = 'note') {
            switch (validation.error) {
                case 'empty':
                    return type === 'note' 
                        ? this.t('notes.empty_name') 
                        : this.t('folders.invalid_name');
                case 'forbidden_chars':
                    return this.t('validation.forbidden_chars', { 
                        chars: validation.forbiddenChars 
                    });
                case 'reserved_name':
                    return this.t('validation.reserved_name');
                case 'invalid_dot':
                    return this.t('validation.invalid_dot');
                case 'trailing_dot_space':
                    return this.t('validation.trailing_dot_space');
                default:
                    return type === 'note' 
                        ? this.t('notes.invalid_name') 
                        : this.t('folders.invalid_name');
            }
        },
        
        // Load available locales from backend
        async loadAvailableLocales() {
            try {
                const response = await fetch('/api/locales');
                const data = await response.json();
                this.availableLocales = data.locales || [];
            } catch (error) {
                console.error('Failed to load available locales:', error);
                this.availableLocales = [{ code: 'pt-BR', name: 'Português (Brasil)', flag: '🇧🇷' }];
            }
        },
        
        // Load translations for a specific locale
        async loadLocale(localeCode = null) {
            const targetLocale = localeCode || localStorage.getItem('locale') || 'pt-BR';
            
            try {
                const response = await fetch(`/api/locales/${targetLocale}`);
                if (response.ok) {
                    this.translations = await response.json();
                    this.currentLocale = targetLocale;
                    localStorage.setItem('locale', targetLocale);
                } else if (targetLocale !== 'pt-BR') {
                    // Fallback to pt-BR if requested locale not found
                    await this.loadLocale('pt-BR');
                }
            } catch (error) {
                console.error('Failed to load locale:', error);
                // If pt-BR also fails, translations will be empty and t() will return keys
                if (targetLocale !== 'pt-BR') {
                    await this.loadLocale('pt-BR');
                }
            }
        },
        
        // Change locale and reload translations
        async changeLocale(localeCode) {
            await this.loadLocale(localeCode);
        },
        
        // ==================== END INTERNATIONALIZATION ====================
        
        // Load all notes. Pass {silent: true} from error-recovery paths so the
        // 800ms loading overlay never appears on background re-syncs.
        async loadNotes({ silent = false } = {}) {
            this.notesLoading = true;
            clearTimeout(this._notesLoadingOverlayTimer);
            if (!silent) {
                this._notesLoadingOverlayTimer = setTimeout(() => {
                    if (this.notesLoading && this.notes.length === 0 && this.allFolders.length === 0) {
                        this.notesLoadingShowOverlay = true;
                    }
                }, 800);
            }
            try {
                const response = await fetch('/api/notes');
                const data = await response.json();
                this.notes = data.notes;
                this.allFolders = data.folders || [];
                this.buildNoteLookupMaps();
                this.buildFolderTree();
                await this.loadTags();
            } catch (error) {
                ErrorHandler.handle('load notes', error);
            } finally {
                clearTimeout(this._notesLoadingOverlayTimer);
                this.notesLoading = false;
                this.notesLoadingShowOverlay = false;
            }
        },
        
        // Build lookup maps for O(1) wikilink resolution
        buildNoteLookupMaps() {
            // Clear existing maps
            this._noteLookup.byPath.clear();
            this._noteLookup.byPathLower.clear();
            this._noteLookup.byName.clear();
            this._noteLookup.byNameLower.clear();
            this._mediaLookup.clear();
            this._noteNameCounts.clear();
            
            const setFirst = (map, key, value) => {
                if (!map.has(key)) map.set(key, value);
            };
            
            for (const note of this.notes) {
                const path = note.path;
                const pathLower = path.toLowerCase();
                const name = note.name;
                const nameLower = name.toLowerCase();
                
                // Handle media files separately - build media lookup map
                if (note.type !== 'note') {
                    // Map filename WITH extension (case-insensitive) to full path
                    // Use path to get filename with extension (note.name is stem without extension)
                    const filenameWithExt = path.split('/').pop().toLowerCase();
                    // First match wins if there are duplicates
                    if (!this._mediaLookup.has(filenameWithExt)) {
                        this._mediaLookup.set(filenameWithExt, path);
                    }
                    continue;
                }
                
                // Notes only from here
                const nameWithoutMd = name.replace(/\.md$/i, '');
                const nameWithoutMdLower = nameWithoutMd.toLowerCase();
                const urlPath = path.replace(/\.md$/i, '');

                // Count notes per stem so autocomplete can insert a bare name when
                // unique and a folder-relative path when ambiguous.
                this._noteNameCounts.set(nameWithoutMdLower, (this._noteNameCounts.get(nameWithoutMdLower) || 0) + 1);
                
                // Store all variations for fast lookup. The value is the note's URL
                // path, so a wikilink can be resolved to a href and not just tested
                // for existence. Name keys collide when two folders hold the same
                // note name, so first match wins — the same rule the media map
                // above uses.
                setFirst(this._noteLookup.byPath, path, urlPath);
                setFirst(this._noteLookup.byPath, urlPath, urlPath);
                setFirst(this._noteLookup.byPathLower, pathLower, urlPath);
                setFirst(this._noteLookup.byPathLower, pathLower.replace(/\.md$/i, ''), urlPath);
                setFirst(this._noteLookup.byName, name, urlPath);
                setFirst(this._noteLookup.byName, nameWithoutMd, urlPath);
                setFirst(this._noteLookup.byNameLower, nameLower, urlPath);
                setFirst(this._noteLookup.byNameLower, nameWithoutMdLower, urlPath);
            }
        },
        
        // Resolve a wikilink or markdown-link target to the target note's URL
        // path (path without .md), or null when nothing matches.
        //
        // The single rule set for every client-side resolution (preview
        // renderer, click navigation), mirroring the backend's
        // vault.LinkResolver in the same order:
        //   1. relative to the source note's folder (plain names only),
        //   2. path from the vault root (exact, then case-insensitive),
        //   3. note stem, so [[My Note]] works from anywhere.
        // It stays client-side because the live preview resolves links on
        // every keystroke, where a round trip would be visible.
        resolveWikiLink(linkTarget, sourceFolder = '') {
            const target = (linkTarget || '').trim();
            if (!target) return null;
            const targetLower = target.toLowerCase();
            const byPath = this._noteLookup.byPath;
            const byPathLower = this._noteLookup.byPathLower;

            // 1. Relative to the source note's folder
            if (sourceFolder && !target.includes('/')) {
                const rel = sourceFolder + '/' + target;
                const relLower = rel.toLowerCase();
                const relHit =
                    byPath.get(rel) ??
                    byPath.get(rel + '.md') ??
                    byPathLower.get(relLower) ??
                    byPathLower.get(relLower + '.md');
                if (relHit) return relHit;
            }

            // 2. Vault root  3. note stem
            return (
                byPath.get(target) ??
                byPath.get(target + '.md') ??
                byPathLower.get(targetLower) ??
                byPathLower.get(targetLower + '.md') ??
                this._noteLookup.byName.get(target) ??
                this._noteLookup.byNameLower.get(targetLower) ??
                null
            );
        },
        
        // Resolve media wikilink to full path (O(1) lookup)
        // Returns the full path if found, null otherwise
        resolveMediaWikilink(mediaName) {
            const nameLower = mediaName.toLowerCase();
            return this._mediaLookup.get(nameLower) || null;
        },

        // ---- Wikilink / media autocomplete -------------------------------------
        // Triggered while typing inside [[ (notes) or ![[ (media). Suggestions are
        // computed client-side from the already-loaded notes list; no backend calls.

        // Inspect the text before the caret and open/refresh the popup when the
        // caret sits inside an unfinished [[ / ![[ token.
        wlDetectToken() {
            const textarea = document.getElementById('note-editor');
            if (!textarea) { this.wlClose(); return; }
            if (document.activeElement !== textarea) { this.wlClose(); return; }
            if (textarea.selectionStart !== textarea.selectionEnd) { this.wlClose(); return; }

            const caret = textarea.selectionStart;
            const before = this.noteContent.substring(0, caret);
            const idx = before.lastIndexOf('[[');
            if (idx === -1) { this.wlClose(); return; }

            const query = before.substring(idx + 2);
            // A valid in-progress target has no bracket, pipe, or newline, and stays short.
            if (query.length > 100 || /[\[\]\n|]/.test(query)) { this.wlClose(); return; }

            this.wikilinkAutocomplete.mode = (idx > 0 && before[idx - 1] === '!') ? 'media' : 'note';
            this.wikilinkAutocomplete.tokenStart = idx + 2;
            this.wikilinkAutocomplete.query = query;
            this.wlComputeItems();

            if (this.wikilinkAutocomplete.items.length === 0) { this.wlClose(); return; }
            this.wikilinkAutocomplete.activeIndex = 0;
            this.wikilinkAutocomplete.open = true;
            this._wlPosRetries = 0;
            this.$nextTick(() => this.wlUpdatePosition());
        },

        // Build the (capped) suggestion list for the current query and mode.
        wlComputeItems() {
            const WL_LIMIT = 8;
            const q = this.wikilinkAutocomplete.query.trim().toLowerCase();
            const isMedia = this.wikilinkAutocomplete.mode === 'media';
            const results = [];

            for (const note of this.notes) {
                if (isMedia ? note.type === 'note' : note.type !== 'note') continue;

                const path = note.path;
                const folder = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';

                let label, insert;
                if (isMedia) {
                    label = path.split('/').pop();   // filename with extension
                    insert = label;
                } else {
                    const stem = note.name.replace(/\.md$/i, '');
                    label = stem;
                    // Bare name when unique, else folder-relative path (no extension).
                    insert = (this._noteNameCounts.get(stem.toLowerCase()) || 0) > 1
                        ? path.replace(/\.md$/i, '')
                        : stem;
                }

                const labelLower = label.toLowerCase();
                const pathLower = path.toLowerCase();
                if (q && !labelLower.includes(q) && !pathLower.includes(q)) continue;

                results.push({
                    label,
                    secondary: folder,
                    insert,
                    kind: note.type,
                    prefix: q ? labelLower.startsWith(q) : false,
                    modified: note.modified || '',
                });
            }

            // Prefix matches first, then most-recently-modified, then alphabetical.
            // `modified` is an ISO timestamp, so lexical compare orders by time.
            results.sort((a, b) =>
                (b.prefix - a.prefix) || b.modified.localeCompare(a.modified) || a.label.localeCompare(b.label));
            this.wikilinkAutocomplete.items = results.slice(0, WL_LIMIT);
        },

        // Keyboard handling while the popup is open. Runs before the editor's
        // Enter/Tab handlers (registered later on the same element), so
        // stopImmediatePropagation keeps list-continuation and indent from firing.
        wlOnKeydown(event) {
            if (!this.wikilinkAutocomplete.open) return;
            const wa = this.wikilinkAutocomplete;

            switch (event.key) {
                case 'ArrowDown':
                    event.preventDefault(); event.stopImmediatePropagation();
                    this.wlMove(1);
                    return;
                case 'ArrowUp':
                    event.preventDefault(); event.stopImmediatePropagation();
                    this.wlMove(-1);
                    return;
                case 'Enter':
                case 'Tab':
                    event.preventDefault(); event.stopImmediatePropagation();
                    if (wa.items[wa.activeIndex]) this.wlAccept(wa.items[wa.activeIndex]);
                    return;
                case 'Escape':
                    event.preventDefault(); event.stopImmediatePropagation();
                    this.wlClose();
                    return;
                case 'ArrowLeft':
                case 'ArrowRight':
                case 'Home':
                case 'End':
                    this.wlClose();
                    return;
            }
        },

        wlMove(delta) {
            const n = this.wikilinkAutocomplete.items.length;
            if (!n) return;
            this.wikilinkAutocomplete.activeIndex =
                (this.wikilinkAutocomplete.activeIndex + delta + n) % n;
        },

        // Replace the in-progress token with the chosen target and close it off
        // with ]] (reusing an existing trailing ]] if present).
        wlAccept(item) {
            if (!item) return;
            const textarea = document.getElementById('note-editor');
            if (!textarea) return;

            const caret = textarea.selectionStart;
            const before = this.noteContent.substring(0, this.wikilinkAutocomplete.tokenStart);
            const after = this.noteContent.substring(caret);
            const head = before + item.insert;

            const hasClosing = after.startsWith(']]');
            this.noteContent = hasClosing ? (head + after) : (head + ']]' + after);
            const newCaret = head.length + 2; // after the ]]

            this.wlClose();
            this.$nextTick(() => {
                textarea.focus();
                textarea.selectionStart = textarea.selectionEnd = newCaret;
                this.autoSave();
                this.updateSyntaxHighlight();
            });
        },

        wlClose() {
            this.wikilinkAutocomplete.open = false;
        },

        // Position the popup just below the caret, clamped to the viewport.
        // The suggestion count varies with the query (1-8 rows), so the popup's
        // real size is measured from the DOM instead of guessed: a fixed guess
        // made the flip-to-above math place the popup a fixed distance above the
        // caret, leaving a visible gap whenever the list was shorter than the
        // guess (the popup then floated well above the [[ being typed).
        wlUpdatePosition() {
            const textarea = document.getElementById('note-editor');
            if (!textarea) return;
            const popup = document.getElementById('wikilink-autocomplete');
            const coords = this.wlCaretCoords(textarea, textarea.selectionStart);

            // On the tick the popup opens it can still be display:none, in which
            // case the rect is all zeros: fall back to a conservative estimate so
            // it never flashes at the top of the window, then re-measure on the
            // next frame once it is rendered.
            const pRect = popup ? popup.getBoundingClientRect() : null;
            const measured = !!(pRect && pRect.height);
            const popupW = measured ? pRect.width : 240;
            const popupH = measured ? pRect.height : 200;

            let left = coords.left;
            if (left + popupW > window.innerWidth - 4) left = window.innerWidth - popupW - 4;
            if (left < 4) left = 4;

            // Below the caret line by default; flip above only when it really
            // does not fit below, and only as high as its own height requires.
            let top = coords.top;
            if (popupH > window.innerHeight - top - 4) {
                const above = coords.top - coords.height - popupH;
                if (above >= 4) top = above;
            }
            if (top < 4) top = 4;

            this.wikilinkAutocomplete.position = { top, left };

            if (!measured && this.wikilinkAutocomplete.open && (this._wlPosRetries || 0) < 3) {
                this._wlPosRetries = (this._wlPosRetries || 0) + 1;
                requestAnimationFrame(() => {
                    if (this.wikilinkAutocomplete.open) this.wlUpdatePosition();
                });
            }
            if (measured) this._wlPosRetries = 0;
        },

        // Caret pixel coordinates inside a textarea via a hidden mirror element.
        // Mirrors the textarea-caret-position technique (a plain textarea exposes
        // no native caret geometry). Returns viewport-relative top/left of the line
        // below the caret, plus the line height.
        wlCaretCoords(textarea, position) {
            const props = [
                'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
                'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
                'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
                'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'textDecoration',
                'letterSpacing', 'wordSpacing', 'tabSize', 'MozTabSize',
            ];
            const computed = window.getComputedStyle(textarea);
            const div = document.createElement('div');
            const style = div.style;
            style.position = 'absolute';
            style.visibility = 'hidden';
            style.whiteSpace = 'pre-wrap';
            style.wordWrap = 'break-word';
            props.forEach(p => { style[p] = computed[p]; });

            div.textContent = textarea.value.substring(0, position);
            const span = document.createElement('span');
            span.textContent = textarea.value.substring(position) || '.';
            div.appendChild(span);
            document.body.appendChild(div);

            const lineHeight = parseInt(computed.lineHeight, 10) || parseInt(computed.fontSize, 10) * 1.2;
            const top = span.offsetTop + parseInt(computed.borderTopWidth, 10);
            const left = span.offsetLeft + parseInt(computed.borderLeftWidth, 10);
            document.body.removeChild(div);

            const rect = textarea.getBoundingClientRect();
            return {
                top: rect.top + top - textarea.scrollTop + lineHeight,
                left: rect.left + left - textarea.scrollLeft,
                height: lineHeight,
            };
        },
        
        // Resolve a Markdown image path to a vault-relative path (forward slashes).
        // Relative paths use the note file's directory as base (same rules as CommonMark / browsers).
        // A leading "/" (not "//") means vault-root-relative.
        resolveMarkdownMediaPathForNote(noteVaultPath, rawSrc) {
            const pathPart = rawSrc.split('#')[0].split('?')[0];
            if (!pathPart) return '';
            if (pathPart.startsWith('/') && !pathPart.startsWith('//')) {
                return pathPart.replace(/^\/+/, '');
            }
            if (!noteVaultPath) {
                return pathPart;
            }
            const dir = noteVaultPath.includes('/')
                ? noteVaultPath.slice(0, noteVaultPath.lastIndexOf('/'))
                : '';
            const base = `https://vn.invalid/${dir ? `${dir}/` : ''}`;
            try {
                const u = new URL(pathPart, base);
                let p = u.pathname;
                if (p.startsWith('/')) p = p.slice(1);
                return p.split('/').filter(seg => seg !== '').map(seg => {
                    try {
                        return decodeURIComponent(seg);
                    } catch (e) {
                        return seg;
                    }
                }).join('/');
            } catch (e) {
                return pathPart;
            }
        },
        
        encodeVaultRelativePathForMediaApi(vaultRelativePath) {
            if (!vaultRelativePath) return '';
            return vaultRelativePath.split('/').map(segment => {
                try {
                    return encodeURIComponent(decodeURIComponent(segment));
                } catch (e) {
                    return encodeURIComponent(segment);
                }
            }).join('/');
        },
        
        // Load all tags
        async loadTags() {
            try {
                const response = await fetch('/api/tags');
                const data = await response.json();
                this.allTags = data.tags || {};
            } catch (error) {
                ErrorHandler.handle('load tags', error, false); // Optional: no toast
            }
        },
        
        // Debounced tag reload (prevents excessive API calls during typing)
        loadTagsDebounced() {
            // Clear existing timeout
            if (this.tagReloadTimeout) {
                clearTimeout(this.tagReloadTimeout);
            }
            
            // Set new timeout - reload tags 2 seconds after last save
            this.tagReloadTimeout = setTimeout(() => {
                this.loadTags();
            }, 2000);
        },
        
        // Toggle tag selection for filtering
        toggleTag(tag) {
            const index = this.selectedTags.indexOf(tag);
            if (index > -1) {
                this.selectedTags.splice(index, 1);
            } else {
                this.selectedTags.push(tag);
            }
            
            // Apply unified filtering
            this.applyFilters();
        },
        
        // Clear all tag filters
        clearTagFilters() {
            this.selectedTags = [];
            
            // Apply unified filtering
            this.applyFilters();
        },
        
        // Scroll to a heading in the editor or preview
        scrollToHeading(heading) {
            if (this.viewMode === 'preview' || this.viewMode === 'split') {
                // In preview/split mode, scroll the preview pane
                const preview = document.querySelector('.markdown-preview');
                if (preview) {
                    // Find the heading element by text content (more reliable than ID)
                    const headingElements = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
                    for (const el of headingElements) {
                        if (el.textContent.trim() === heading.text) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            // Add a brief highlight effect
                            el.style.transition = 'background-color 0.3s';
                            el.style.backgroundColor = 'var(--accent-light)';
                            setTimeout(() => {
                                el.style.backgroundColor = '';
                            }, 1000);
                            return;
                        }
                    }
                }
            }
            
            if (this.viewMode === 'edit' || this.viewMode === 'split') {
                // In edit/split mode, scroll the editor to the line
                const textarea = document.querySelector('.editor-textarea');
                if (textarea && heading.line) {
                    const lines = textarea.value.split('\n');
                    let charPos = 0;
                    
                    // Calculate character position of the heading line
                    for (let i = 0; i < heading.line - 1 && i < lines.length; i++) {
                        charPos += lines[i].length + 1; // +1 for newline
                    }
                    
                    // Set cursor position and scroll
                    textarea.focus();
                    textarea.setSelectionRange(charPos, charPos);
                    
                    // Calculate scroll position (approximate)
                    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24;
                    const scrollTop = (heading.line - 1) * lineHeight - textarea.clientHeight / 3;
                    textarea.scrollTop = Math.max(0, scrollTop);
                }
            }
        },

        // Navigate to a backlink (note that links to current note)
        navigateToBacklink(backlinkPath) {
            this.loadNote(backlinkPath);
        },
        
        // Unified filtering logic combining tags and text search
        async applyFilters() {
            const hasTextSearch = this.isSearchable();
            const hasTagFilter = this.selectedTags.length > 0;
            
            // Case 1: No filters at all → show full folder tree
            if (!hasTextSearch && !hasTagFilter) {
                this.isSearching = false;
                this.searchResults = [];
                this.expandedSearchResults = {};
                this.currentSearchHighlight = '';
                this.clearSearchHighlights();
                this.buildFolderTree();
                return;
            }
            
            // Case 2: Only tag filter → convert to flat list of matching notes
            if (hasTagFilter && !hasTextSearch) {
                this.isSearching = false;
                this.searchResults = this.notes.filter(note => 
                    note.type === 'note' && this.noteMatchesTags(note)
                );
                this.expandedSearchResults = {};
                this.currentSearchHighlight = '';
                this.clearSearchHighlights();
                return;
            }
            
            // Case 3: Text search (with or without tag filter)
            if (hasTextSearch) {
                this.isSearching = true;
                try {
                    const response = await fetch(`/api/search?q=${encodeURIComponent(this.searchQuery)}`);
                    const data = await response.json();
                    
                    // Apply tag filtering to search results if tags are selected
                    let results = data.results;
                    if (hasTagFilter) {
                        results = results.filter(result => {
                            const note = this.notes.find(n => n.path === result.path);
                            return note ? this.noteMatchesTags(note) : false;
                        });
                    }
                    
                    this.searchResults = results;

                    // Keep groups the user already expanded, but drop paths that
                    // disappeared from the new result set.
                    const expanded = {};
                    for (const result of results) {
                        if (this.expandedSearchResults[result.path]) {
                            expanded[result.path] = true;
                        }
                    }
                    this.expandedSearchResults = expanded;
                    
                    // Highlight the term in the note that is already open.
                    // Skip when this exact query is already showing: a note
                    // opened from a result (or a reload of
                    // ?search=&line=&col=) highlights the clicked occurrence
                    // itself, and running this pass again would reset it to
                    // the first match and scroll away from it.
                    if (this.currentNote && this.noteContent
                        && (this.currentSearchHighlight || '') !== (this.searchQuery || '')) {
                        this.currentSearchHighlight = this.searchQuery;
                        this.$nextTick(() => {
                            this.highlightSearchTerm(this.searchQuery, false);
                        });
                    }
                } catch (error) {
                    console.error('Search failed:', error);
                    this.searchResults = [];
                } finally {
                    this.isSearching = false;
                }
            }
        },
        
        // Check if a note matches selected tags (AND logic)
        noteMatchesTags(note) {
            if (this.selectedTags.length === 0) {
                return true; // No filter active
            }
            if (!note.tags || note.tags.length === 0) {
                return false; // Note has no tags but filter is active
            }
            // Check if note has ALL selected tags (AND logic)
            return this.selectedTags.every(tag => note.tags.includes(tag));
        },
        
        // Get all tags sorted by name
        get sortedTags() {
            return Object.entries(this.allTags).sort((a, b) => a[0].localeCompare(b[0]));
        },
        
        // Get tags for current note
        get currentNoteTags() {
            if (!this.currentNote) return [];
            const note = this.notes.find(n => n.path === this.currentNote);
            return note && note.tags ? note.tags : [];
        },
        
        // ==================== FAVORITES ====================
        
        // Save favorites to localStorage
        saveFavorites() {
            try {
                localStorage.setItem('noteFavorites', JSON.stringify(this.favorites));
            } catch (e) {
                console.warn('Could not save favorites to localStorage');
            }
        },
        
        // Check if a note is favorited (O(1) lookup)
        isFavorite(notePath) {
            return this.favoritesSet.has(notePath);
        },
        
        // Toggle favorite status for a note
        toggleFavorite(notePath = null) {
            const path = notePath || this.currentNote;
            if (!path) return;
            
            if (this.favoritesSet.has(path)) {
                // Remove from favorites
                this.favorites = this.favorites.filter(f => f !== path);
            } else {
                // Add to favorites
                this.favorites = [...this.favorites, path];
            }
            // Recreate Set from array for consistency
            this.favoritesSet = new Set(this.favorites);
            this.saveFavorites();
        },
        
        // Get favorite notes with full details (for display)
        get favoriteNotes() {
            return this.favorites
                .map(path => {
                    // Find note by exact path or case-insensitive match
                    let note = this.notes.find(n => n.path === path);
                    if (!note) {
                        note = this.notes.find(n => n.path.toLowerCase() === path.toLowerCase());
                    }
                    if (!note) return null;
                    return {
                        path: note.path, // Use actual path from notes (fixes case issues)
                        name: note.path.split('/').pop().replace('.md', ''),
                        folder: note.folder || ''
                    };
                })
                .filter(Boolean); // Remove nulls (deleted notes)
        },
        
        saveFavoritesExpanded() {
            try {
                localStorage.setItem('favoritesExpanded', this.favoritesExpanded.toString());
            } catch (e) {
                console.error('Error saving favorites expanded state:', e);
            }
        },
        
        // Get current note's last modified time as relative string
        get lastEditedText() {
            if (!this.currentNote) return '';
            const note = this.notes.find(n => n.path === this.currentNote);
            if (!note || !note.modified) return '';
            
            const modified = new Date(note.modified);
            const now = new Date();
            const diffMs = now - modified;
            const diffSecs = Math.floor(diffMs / 1000);
            const diffMins = Math.floor(diffSecs / 60);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);
            
            if (diffSecs < 60) return this.t('editor.just_now');
            if (diffMins < 60) return this.t('editor.minutes_ago', { count: diffMins });
            if (diffHours < 24) return this.t('editor.hours_ago', { count: diffHours });
            if (diffDays < 7) return this.t('editor.days_ago', { count: diffDays });
            
            // For older dates, show the date in selected locale
            return modified.toLocaleDateString(this.currentLocale, { month: 'short', day: 'numeric' });
        },
        
        // Build folder tree structure
        buildFolderTree() {
            const tree = {};
            
            // Add ALL folders from backend (including empty ones)
            this.allFolders.forEach(folderPath => {
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
            this.notes.forEach(note => {
                if (!note.folder) {
                    // Root level note
                    if (!tree['__root__']) {
                        tree['__root__'] = {
                            name: '',
                            path: '',
                            children: {},
                            notes: []
                        };
                    }
                    tree['__root__'].notes.push(note);
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
            
            // Sort all notes arrays alphabetically (create new sorted arrays for reactivity)
            const sortNotes = (obj) => {
                if (obj.notes && obj.notes.length > 0) {
                    // Create a new sorted array instead of mutating for Alpine reactivity
                    obj.notes = [...obj.notes].sort(this.getSortComparator());
                }
                if (obj.children && Object.keys(obj.children).length > 0) {
                    Object.values(obj.children).forEach(child => sortNotes(child));
                }
            };
            
            // Sort notes in root (create new array for reactivity)
            if (tree['__root__'] && tree['__root__'].notes) {
                tree['__root__'].notes = [...tree['__root__'].notes].sort(this.getSortComparator());
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
                if (folder.path !== undefined || folder === tree['__root__']) {
                    calculateNoteCounts(folder);
                }
            });
            
            // Invalidate homepage cache when tree is rebuilt
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            // Assign new tree (Alpine will detect the change)
            this.folderTree = tree;
        },
        
        // =====================================================================
        // OPTIMISTIC MUTATION HELPERS
        // Mirror server-side index updates locally so file ops feel instant on
        // big vaults. Mutations apply the change to this.notes/this.allFolders
        // immediately, fire the request, and on error fall back to
        // loadNotes({silent: true}) to resync from disk.
        // =====================================================================
        
        _isoNow() {
            return new Date().toISOString();
        },
        
        _folderFromPath(path) {
            const i = path.lastIndexOf('/');
            return i === -1 ? '' : path.substring(0, i);
        },
        
        _filenameFromPath(path) {
            return path.split('/').pop();
        },

        // Windows and macOS store these as one file. Rename already used this
        // comparison; create and import must too, or `b` overwrites `B`.
        notePathTaken(path) {
            if (!path) return false;
            const lower = path.toLowerCase();
            return this.notes.some(n => n.path.toLowerCase() === lower);
        },

        folderPathTaken(path) {
            if (!path) return false;
            const lower = path.toLowerCase();
            return this.allFolders.some(folder => folder.toLowerCase() === lower);
        },
        
        _inferTypeFromPath(path) {
            const m = /\.([^./]+)$/.exec(path);
            const ext = m ? m[1].toLowerCase() : '';
            if (ext === 'md' || ext === '') return 'note';
            if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
            if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
            if (['mp4', 'webm', 'mov', 'avi'].includes(ext)) return 'video';
            if (ext === 'pdf') return 'document';
            return 'note';
        },
        
        // Refresh sidebar tree + wikilink lookup maps after any optimistic update.
        _rebuildTreeAfterMutation() {
            this.buildNoteLookupMaps();
            this.buildFolderTree();
        },
        
        // Add a note/media file to the local list. No-op if already present.
        _optimisticAddNote(path, { content = '', type = null, size = null } = {}) {
            if (this.notes.some(n => n.path === path)) return;
            const inferredType = type || this._inferTypeFromPath(path);
            const filename = this._filenameFromPath(path);
            const name = inferredType === 'note' ? filename.replace(/\.md$/i, '') : filename;
            this.notes.push({
                path,
                name,
                folder: this._folderFromPath(path),
                type: inferredType,
                size: size != null ? size : (content ? new Blob([content]).size : 0),
                modified: this._isoNow(),
                tags: [],
            });
        },
        
        _optimisticRemoveNote(path) {
            this.notes = this.notes.filter(n => n.path !== path);
        },
        
        // Used by single-note rename and move (path changes, identity preserved).
        _optimisticRenameNote(oldPath, newPath) {
            const note = this.notes.find(n => n.path === oldPath);
            if (!note) return;
            note.path = newPath;
            note.folder = this._folderFromPath(newPath);
            const filename = this._filenameFromPath(newPath);
            note.name = note.type === 'note' ? filename.replace(/\.md$/i, '') : filename;
        },
        
        _optimisticAddFolder(folderPath) {
            if (!folderPath) return;
            if (!this.allFolders.includes(folderPath)) {
                this.allFolders.push(folderPath);
            }
        },
        
        // Cascade: remove the folder, its descendant folders, and every note inside.
        _optimisticRemoveFolderTree(folderPath) {
            const prefix = folderPath + '/';
            this.allFolders = this.allFolders.filter(f => f !== folderPath && !f.startsWith(prefix));
            this.notes = this.notes.filter(n => !n.path.startsWith(prefix));
        },
        
        // Cascade: rename the folder, its descendant folders, and rewrite paths
        // of every note inside.
        _optimisticRenameFolderTree(oldPath, newPath) {
            if (oldPath === newPath) return;
            const oldPrefix = oldPath + '/';
            const newPrefix = newPath + '/';
            this.allFolders = this.allFolders.map(f => {
                if (f === oldPath) return newPath;
                if (f.startsWith(oldPrefix)) return newPrefix + f.substring(oldPrefix.length);
                return f;
            });
            this.notes.forEach(n => {
                if (n.path.startsWith(oldPrefix)) {
                    n.path = newPrefix + n.path.substring(oldPrefix.length);
                    n.folder = this._folderFromPath(n.path);
                }
            });
        },
        
        // =====================================================================
        // DATA-ATTRIBUTE BASED HANDLERS
        // These read path/name/type from data-* attributes, avoiding JS escaping issues
        // =====================================================================
        
        // Escape strings for HTML attributes (simpler than JS escaping)
        escapeHtmlAttr(str) {
            if (!str) return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
        
        // Folder handlers - read from dataset
        handleFolderClick(el) {
            this.toggleFolder(el.dataset.path);
        },
        handleFolderDragOver(el, event) {
            event.preventDefault();
            this.dragOverFolder = el.dataset.path;
            el.classList.add('drag-over');
        },
        handleFolderDragLeave(el) {
            this.dragOverFolder = null;
            el.classList.remove('drag-over');
        },
        handleFolderDrop(el, event) {
            event.stopPropagation();
            el.classList.remove('drag-over');
            this.onFolderDrop(el.dataset.path);
        },
        handleNewItemClick(el, event) {
            event.stopPropagation();
            this.dropdownTargetFolder = el.dataset.path;
            this.toggleNewDropdown(event);
        },
        handleRenameFolderClick(el, event) {
            event.stopPropagation();
            this.renameFolder(el.dataset.path, el.dataset.name);
        },
        handleDeleteFolderClick(el, event) {
            event.stopPropagation();
            this.deleteFolder(el.dataset.path, el.dataset.name);
        },
        
        // Item (note/media) handlers - read from dataset
        handleItemClick(el) {
            this.openItem(el.dataset.path, el.dataset.type);
        },
        handleItemHover(el, isEnter) {
            const path = el.dataset.path;
            if (path !== this.currentNote && path !== this.currentMedia) {
                el.style.backgroundColor = isEnter ? 'var(--bg-hover)' : 'transparent';
            }
        },
        handleDeleteItemClick(el, event) {
            event.stopPropagation();
            if (el.dataset.type !== 'note') {
                this.deleteMedia(el.dataset.path);
            } else {
                this.deleteNote(el.dataset.path, el.dataset.name);
            }
        },
        
        // =====================================================================
        // FOLDER TREE RENDERING
        // =====================================================================
        
        // Render folder recursively (helper for deep nesting)
        // Uses data-* attributes to store path/name, avoiding JS string escaping issues
        renderFolderRecursive(folder, level = 0, isTopLevel = false) {
            if (!folder) return '';
            
            let html = '';
            const isExpanded = this.expandedFolders.has(folder.path);
            const esc = (s) => this.escapeHtmlAttr(s); // Shorthand for HTML escaping
            
            // Render this folder's header
            // Note: Using native event handlers with data-* attributes instead of Alpine directives
            // because x-html doesn't process Alpine directives in dynamically generated content
            html += `
                <div>
                    <div 
                        data-path="${esc(folder.path)}"
                        data-name="${esc(folder.name)}"
                        draggable="true"
                        ondragstart="window.$root.onItemDragStart(this.dataset.path, 'folder', event)"
                        ondragend="window.$root.onItemDragEnd()"
                        ondragover="window.$root.handleFolderDragOver(this, event)"
                        ondragenter="window.$root.handleFolderDragOver(this, event)"
                        ondragleave="window.$root.handleFolderDragLeave(this)"
                        ondrop="window.$root.handleFolderDrop(this, event)"
                        onclick="window.$root.handleFolderClick(this)"
                        class="folder-item hover-accent px-2 py-1 text-sm relative"
                        style="color: var(--text-primary); cursor: pointer;"
                    >
                        <div class="flex items-center gap-1">
                            <button 
                                class="flex-shrink-0 w-4 h-4 flex items-center justify-center"
                                style="color: var(--text-tertiary); cursor: pointer; transition: transform 0.2s; pointer-events: none; margin-left: -5px; ${isExpanded ? 'transform: rotate(90deg);' : ''}"
                            >
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M6 4l4 4-4 4V4z"/>
                                </svg>
                            </button>
                            <span class="flex items-center gap-1 flex-1" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; pointer-events: none;" title="${esc(folder.name)}">
                                <span>${esc(folder.name)}</span>
                                ${folder.notes.length === 0 && (!folder.children || Object.keys(folder.children).length === 0) ? `<span class="text-xs" style="color: var(--text-tertiary); font-weight: 400;">(${this.t('folders.empty')})</span>` : ''}
                            </span>
                        </div>
                        <div class="hover-buttons flex gap-1 transition-opacity absolute right-2 top-1/2 transform -translate-y-1/2" style="opacity: 0; pointer-events: none; background: linear-gradient(to right, transparent, var(--bg-hover) 20%, var(--bg-hover)); padding-left: 20px;" onclick="event.stopPropagation()">
                            <button 
                                data-path="${esc(folder.path)}"
                                onclick="window.$root.handleNewItemClick(this, event)"
                                class="px-1.5 py-0.5 text-xs rounded hover:brightness-110"
                                style="background-color: var(--bg-tertiary); color: var(--text-secondary);"
                                title="${esc(this.t('sidebar.new_note'))}"
                            >+</button>
                            <button 
                                data-path="${esc(folder.path)}"
                                data-name="${esc(folder.name)}"
                                onclick="window.$root.handleRenameFolderClick(this, event)"
                                class="px-1.5 py-0.5 text-xs rounded hover:brightness-110"
                                style="background-color: var(--bg-tertiary); color: var(--text-secondary);"
                                title="${esc(this.t('sidebar.rename_folder'))}"
                            >✏️</button>
                            <button 
                                data-path="${esc(folder.path)}"
                                data-name="${esc(folder.name)}"
                                onclick="window.$root.handleDeleteFolderClick(this, event)"
                                class="px-1 py-0.5 text-xs rounded hover:brightness-110"
                                style="color: var(--error);"
                                title="${esc(this.t('sidebar.delete_folder'))}"
                            >
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
            `;
            
            // If expanded, render folder contents (child folders + notes)
            if (isExpanded) {
                html += `<div class="folder-contents" style="padding-left: 10px;">`;
                
                // First, render child folders (if any)
                if (folder.children && Object.keys(folder.children).length > 0) {
                    const children = Object.entries(folder.children)
                        .filter(([k, v]) => !this.hideUnderscoreFolders || !v.name.startsWith('_'))
                        .sort((a, b) => this.getFolderSortComparator()(a[1], b[1]));

                    children.forEach(([childKey, childFolder]) => {
                        html += this.renderFolderRecursive(childFolder, 0, false);
                    });
                }
                
                // Then, render notes and images in this folder (after subfolders)
                if (folder.notes && folder.notes.length > 0) {
                    folder.notes.forEach(note => {
                        html += this.renderNoteItem(note);
                    });
                }
                
                html += `</div>`; // Close folder-contents
            }
            
            html += `</div>`; // Close folder wrapper
            return html;
        },
        
        // Render a single note/media item (used by both folders and root level)
        renderNoteItem(note) {
            const esc = (s) => this.escapeHtmlAttr(s);
            const isMediaFile = note.type !== 'note';
            const isCurrentNote = this.currentNote === note.path;
            const isCurrentMedia = this.currentMedia === note.path;
            const isCurrent = isMediaFile ? isCurrentMedia : isCurrentNote;
            
            const icon = this.getMediaIcon(note.type);
            const deleteTitle = !isMediaFile
                ? this.t('toolbar.delete_note')
                : this.t('toolbar.delete_image');
            
            return `
                <div 
                    data-path="${esc(note.path)}"
                    data-name="${esc(note.name)}"
                    data-type="${note.type}"
                    draggable="true"
                    ondragstart="window.$root.onItemDragStart(this.dataset.path, this.dataset.type || 'note', event)"
                    ondragend="window.$root.onItemDragEnd()"
                    onclick="window.$root.handleItemClick(this)"
                    class="note-item px-2 py-1 text-sm relative"
                    style="${isCurrent ? 'background-color: var(--accent-light); color: var(--accent-primary);' : 'color: var(--text-primary);'} ${isMediaFile ? 'opacity: 0.85;' : ''} cursor: pointer;"
                    onmouseover="window.$root.handleItemHover(this, true)"
                    onmouseout="window.$root.handleItemHover(this, false)"
                >
                    <span class="truncate" style="display: block; padding-right: 30px;" title="${esc(note.name)}">${icon}${icon ? ' ' : ''}${esc(note.name)}</span>
                    <button 
                        data-path="${esc(note.path)}"
                        data-name="${esc(note.name)}"
                        data-type="${note.type}"
                        onclick="window.$root.handleDeleteItemClick(this, event)"
                        class="note-delete-btn absolute right-2 top-1/2 transform -translate-y-1/2 px-1 py-0.5 text-xs rounded hover:brightness-110 transition-opacity"
                        style="opacity: 0; color: var(--error);"
                        title="${esc(deleteTitle)}"
                    >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>
                </div>
            `;
        },
        
        // Render root-level items (notes and media not in any folder)
        renderRootItems() {
            const root = this.folderTree['__root__'];
            if (!root || !root.notes || root.notes.length === 0) {
                return '';
            }
            return root.notes.map(note => this.renderNoteItem(note)).join('');
        },
        
        // Toggle folder expansion
        toggleFolder(folderPath) {
            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath);
            } else {
                this.expandedFolders.add(folderPath);
            }
            // Force Alpine reactivity by creating new Set reference
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Check if folder is expanded
        isFolderExpanded(folderPath) {
            return this.expandedFolders.has(folderPath);
        },
        
        // Expand all folders
        expandAllFolders() {
            this.allFolders.forEach(folder => {
                this.expandedFolders.add(folder);
            });
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Collapse all folders
        collapseAllFolders() {
            this.expandedFolders.clear();
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Expand folder tree to show a specific note
        expandFolderForNote(notePath) {
            const parts = notePath.split('/');
            
            // If note is in root, no folders to expand
            if (parts.length <= 1) return;
            
            // Remove the note name (last part)
            parts.pop();
            
            // Build and expand all parent folders
            let currentPath = '';
            parts.forEach((part, index) => {
                currentPath = index === 0 ? part : `${currentPath}/${part}`;
                this.expandedFolders.add(currentPath);
            });
            
            // Force Alpine reactivity
            this.expandedFolders = new Set(this.expandedFolders);
        },
        
        // Scroll note into view in the sidebar navigation
        scrollNoteIntoView(notePath) {
            // Find the note element in the sidebar
            // Use a slight delay to ensure DOM is fully rendered with Alpine bindings applied
            setTimeout(() => {
                const sidebar = document.querySelector('.flex-1.overflow-y-auto.custom-scrollbar');
                if (!sidebar) return;
                
                const noteElements = sidebar.querySelectorAll('.note-item');
                let targetElement = null;
                const noteName = notePath.split('/').pop().replace('.md', '');
                
                // Find the element that corresponds to this note
                noteElements.forEach(el => {
                    // Check if this is a note element (not folder) by checking if it has the note name
                    if (el.textContent.trim().startsWith(noteName) || el.textContent.includes(noteName)) {
                        // Check computed style to see if it's highlighted
                        const computedStyle = window.getComputedStyle(el);
                        const bgColor = computedStyle.backgroundColor;
                        
                        // Check if background has the accent color (not transparent or default)
                        if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent' && !bgColor.includes('255, 255, 255')) {
                            targetElement = el;
                        }
                    }
                });
                
                // If found, scroll it into view
                if (targetElement) {
                    targetElement.scrollIntoView({ 
                        behavior: 'smooth', 
                        block: 'center',
                        inline: 'nearest'
                    });
                }
            }, 200); // Increased delay to ensure Alpine has finished rendering
        },
        
        // Unified drag and drop handlers for notes, folders, and media
        onItemDragStart(itemPath, itemType, event) {
            // Set unified drag state
            this.draggedItem = { path: itemPath, type: itemType };
            
            // Make drag image semi-transparent
            if (event.target) {
                event.target.style.opacity = '0.5';
            }
            
            event.dataTransfer.effectAllowed = 'all';
        },
        
        onItemDragEnd() {
            this.draggedItem = null;
            this.dropTarget = null;
            this.dragOverFolder = null;
            // Reset opacity of all draggable items
            document.querySelectorAll('.note-item, .folder-header').forEach(el => el.style.opacity = '1');
            // Reset drag-over class
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        },
        
        
        // Handle dragover on editor to show cursor position
        onEditorDragOver(event) {
            // Two sources land here: sidebar items (draggedItem set) and OS files.
            const isFileDrag = event.dataTransfer?.types?.includes('Files');
            if (!this.draggedItem && !isFileDrag) return;
            
            event.preventDefault();
            this.dropTarget = 'editor';
            if (isFileDrag) this.externalDragActive = true;
            
            // Focus the textarea
            const textarea = event.target;
            if (textarea.tagName !== 'TEXTAREA') return;
            
            textarea.focus();
            
            // Calculate cursor position from mouse coordinates
            const pos = this.getTextareaCursorFromPoint(textarea, event.clientX, event.clientY);
            if (pos >= 0) {
                textarea.setSelectionRange(pos, pos);
            }
        },
        
        // Calculate textarea cursor position from mouse coordinates
        getTextareaCursorFromPoint(textarea, x, y) {
            const rect = textarea.getBoundingClientRect();
            const style = window.getComputedStyle(textarea);
            const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
            const paddingTop = parseFloat(style.paddingTop) || 0;
            const paddingLeft = parseFloat(style.paddingLeft) || 0;
            
            // Calculate which line we're on
            const relativeY = y - rect.top - paddingTop + textarea.scrollTop;
            const lineIndex = Math.max(0, Math.floor(relativeY / lineHeight));
            
            // Split content into lines
            const lines = textarea.value.split('\n');
            
            // Find the character position at the start of this line
            let charPos = 0;
            for (let i = 0; i < Math.min(lineIndex, lines.length); i++) {
                charPos += lines[i].length + 1; // +1 for newline
            }
            
            // If we're beyond the last line, position at end
            if (lineIndex >= lines.length) {
                return textarea.value.length;
            }
            
            // Approximate character position within the line based on X coordinate
            const relativeX = x - rect.left - paddingLeft;
            const charWidth = parseFloat(style.fontSize) * 0.6; // Approximate for monospace
            const charInLine = Math.max(0, Math.floor(relativeX / charWidth));
            const lineLength = lines[lineIndex]?.length || 0;
            
            return charPos + Math.min(charInLine, lineLength);
        },
        
        // Handle dragenter on editor
        onEditorDragEnter(event) {
            const isFileDrag = event.dataTransfer?.types?.includes('Files');
            if (!this.draggedItem && !isFileDrag) return;
            event.preventDefault();
            this.dropTarget = 'editor';
            if (isFileDrag) this.externalDragActive = true;
        },
        
        // Handle dragleave on editor
        onEditorDragLeave(event) {
            // Only clear dropTarget if we're actually leaving the editor
            // (not just moving between child elements)
            if (event.target.tagName === 'TEXTAREA') {
                this.dropTarget = null;
                this.externalDragActive = false;
            }
        },
        
        // Handle drop into editor to create internal link or upload media
        async onEditorDrop(event) {
            event.preventDefault();
            this.dropTarget = null;
            this.externalDragActive = false;
            
            // Check if files are being dropped (media from file system)
            if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                await this.handleMediaDrop(event);
                return;
            }
            
            // Otherwise, handle note/media link drop from sidebar
            if (!this.draggedItem) return;
            
            const notePath = this.draggedItem.path;
            const isMediaFile = this.draggedItem.type !== 'note';
            
            let link;
            if (isMediaFile) {
                // For media files (images, audio, video, PDF), use wiki-style embed link
                const filename = notePath.split('/').pop();
                link = `![[${filename}]]`;
            } else {
                // For notes, insert note link
                const noteName = notePath.split('/').pop().replace('.md', '');
                const encodedPath = notePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                link = `[${noteName}](${encodedPath})`;
            }
            
            // Insert at drop position
            const textarea = event.target;
            // Recalculate position from drop coordinates for accuracy
            let cursorPos = this.getTextareaCursorFromPoint(textarea, event.clientX, event.clientY);
            if (cursorPos < 0) cursorPos = textarea.selectionStart || 0;
            const textBefore = this.noteContent.substring(0, cursorPos);
            const textAfter = this.noteContent.substring(cursorPos);
            
            this.noteContent = textBefore + link + textAfter;
            
            // Move cursor after the link
            this.$nextTick(() => {
                textarea.selectionStart = textarea.selectionEnd = cursorPos + link.length;
                textarea.focus();
            });
            
            // Trigger autosave
            this.autoSave();
            
            this.draggedItem = null;
        },
        
        /**
         * Backend `get_attachment_dir` uses the parent folder of `note_path`.
         * With no note open, infer a synthetic path from `currentMedia` so uploads go to the same
         * `_attachments` folder as the file being viewed (or vault root when appropriate).
         * On the homepage the currently browsed folder wins, so a file uploaded from
         * `Projects/` lands in `Projects/_attachments/` instead of the vault root.
         */
        resolveUploadNotePath() {
            if (this.currentNote) return this.currentNote;
            if (this.currentMedia) {
                const parts = this.currentMedia.split('/').filter(Boolean);
                const ai = parts.indexOf('_attachments');
                if (ai === -1 || ai === 0) return '';
                return `${parts.slice(0, ai).join('/')}/_.md`;
            }
            if (this.selectedHomepageFolder) {
                // Browsing an _attachments folder must upload to its parent's
                // attachments, otherwise every upload creates another
                // _attachments level inside it.
                const parts = this.selectedHomepageFolder.split('/').filter(Boolean);
                const ai = parts.indexOf('_attachments');
                const base = ai === -1 ? parts : parts.slice(0, ai);
                if (base.length === 0) return '';
                return `${base.join('/')}/_.md`;
            }
            return '';
        },
        
        /**
         * 📤 global picker (sidebar / homepage buttons): upload files from anywhere,
         * including when no note is open. Media lands in the current folder's
         * `_attachments`; .md files are imported as new notes. When a note
         * is open its embeds are inserted at the cursor as usual.
         */
        async handleGlobalFiles(event) {
            const input = event.target;
            const files = Array.from(input.files || []);
            input.value = ''; // allow re-selecting the same file later
            
            if (files.length === 0) return;
            
            const mediaFiles = files.filter(file => this.isAttachableMediaFile(file));
            const markdownFiles = files.filter(file => /\.md$/i.test(file.name || ''));
            
            if (mediaFiles.length === 0 && markdownFiles.length === 0) {
                this.toast(this.t('media.no_valid_files', { formats: MEDIA_FORMATS_DISPLAY }), { type: 'warning' });
                return;
            }
            
            const notePath = this.resolveUploadNotePath();
            const textarea = document.getElementById('note-editor');
            const cursorPos = textarea ? (textarea.selectionStart || 0) : 0;
            
            let uploaded = 0;
            let failed = 0;
            for (const file of mediaFiles) {
                try {
                    const mediaPath = await this.uploadMedia(file, notePath);
                    if (!mediaPath) continue;
                    uploaded++;
                    // Only an open note can receive the embed; otherwise the
                    // file simply shows up in the sidebar tree.
                    if (this.currentNote) {
                        await this.insertMediaMarkdown(mediaPath, file.name, cursorPos);
                    }
                } catch (error) {
                    failed++;
                    ErrorHandler.handle(`upload ${file.name}`, error);
                }
            }
            
            for (const file of markdownFiles) {
                try {
                    await this.importMarkdownFile(file, cursorPos);
                } catch (error) {
                    failed++;
                    ErrorHandler.handle(`import markdown ${file.name}`, error);
                }
            }
            
            if (failed > 0) {
                this.toast(this.t('media.upload_failed'), { type: 'error' });
            }
            if (uploaded > 0) {
                this.toast(this.t('media.upload_success', { count: uploaded }), { type: 'success' });
            }
        },
        
        // A File can be uploaded when its MIME type is on the accepted list or
        // its extension is one the backend serves as media. MIME alone is
        // unreliable: several desktops report "" or an off-spec type
        // (application/x-pdf, application/octet-stream) for valid files, so the
        // extension — the same source of truth the backend uses — also qualifies.
        isAttachableMediaFile(file) {
            if (!file || !file.name) return false;
            const allowedTypes = [
                // Images
                'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
                // Audio
                'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a', 'audio/x-m4a',
                // Video
                'video/mp4', 'video/webm', 'video/quicktime',
                // Documents
                'application/pdf'
            ];
            if (allowedTypes.includes((file.type || '').toLowerCase())) return true;
            return ['image', 'audio', 'video', 'document'].includes(this.getMediaType(file.name));
        },

        // Handle media files dropped into editor
        async handleMediaDrop(event) {
            const files = Array.from(event.dataTransfer.files);
            
            const mediaFiles = files.filter(file => this.isAttachableMediaFile(file));
            // By extension: MIME for .md varies across browsers (text/markdown,
            // text/plain, or empty), so the name is the only reliable signal.
            const markdownFiles = files.filter(file => /\.md$/i.test(file.name || ''));
            
            if (mediaFiles.length === 0 && markdownFiles.length === 0) {
                this.toast(this.t('media.no_valid_files', { formats: MEDIA_FORMATS_DISPLAY }), { type: 'warning' });
                return;
            }
            
            const textarea = event.target;
            const notePath = this.resolveUploadNotePath();
            // Calculate cursor position from drop coordinates (only meaningful when a note is open)
            let cursorPos = 0;
            if (this.currentNote && textarea && textarea.tagName === 'TEXTAREA') {
                cursorPos = this.getTextareaCursorFromPoint(textarea, event.clientX, event.clientY);
                if (cursorPos < 0) cursorPos = textarea.selectionStart || 0;
            }
            
            for (const file of mediaFiles) {
                try {
                    const mediaPath = await this.uploadMedia(file, notePath);
                    if (mediaPath && this.currentNote) {
                        await this.insertMediaMarkdown(mediaPath, file.name, cursorPos);
                    }
                } catch (error) {
                    ErrorHandler.handle(`upload file ${file.name}`, error);
                }
            }
            // uploadMedia already injects the file into this.notes optimistically.
            
            // Needs an open note: the target folder is derived from it.
            if (markdownFiles.length > 0 && this.currentNote) {
                for (const file of markdownFiles) {
                    try {
                        await this.importMarkdownFile(file, cursorPos);
                    } catch (error) {
                        ErrorHandler.handle(`import markdown ${file.name}`, error);
                    }
                }
            }
        },
        
        /**
         * 📎 toolbar button: upload the files picked in the dialog and insert
         * their embeds at the cursor. Same acceptance rules as drop/paste
         * (isAttachableMediaFile); the backend saves them into the note's
         * _attachments folder with a collision-proof timestamp suffix.
         */
        async handleAttachFiles(event) {
            const input = event.target;
            const files = Array.from(input.files || []);
            input.value = ''; // allow re-selecting the same file later
            
            if (files.length === 0 || !this.currentNote) return;
            
            const mediaFiles = files.filter(file => this.isAttachableMediaFile(file));
            if (mediaFiles.length === 0) {
                this.toast(this.t('media.no_valid_files', { formats: MEDIA_FORMATS_DISPLAY }), { type: 'warning' });
                return;
            }
            
            const textarea = document.getElementById('note-editor');
            const cursorPos = textarea ? (textarea.selectionStart || 0) : 0;
            const notePath = this.currentNote;
            
            for (const file of mediaFiles) {
                try {
                    const mediaPath = await this.uploadMedia(file, notePath);
                    if (mediaPath) {
                        await this.insertMediaMarkdown(mediaPath, file.name, cursorPos);
                    }
                } catch (error) {
                    ErrorHandler.handle(`attach ${file.name}`, error);
                }
            }
        },
        
        /**
         * Import a .md file as a new note, then insert a `[Name](path)` link at
         * cursorPos (same shape as sidebar note drops). The note lands in the
         * open note's folder, or — with no note open — in the folder being
         * browsed on the homepage (vault root as a last resort). Filename
         * collisions get a yyyymmddHHmmss suffix. Size cap comes from
         * UPLOAD_MAX_NOTE_MB — file.text() would otherwise OOM the browser on a huge drop.
         */
        async importMarkdownFile(file, cursorPos) {
            const maxBytes = this.uploadMaxNoteMb * 1024 * 1024;
            if (file.size > maxBytes) {
                console.warn(`Rejected markdown drop: ${file.name} is ${(file.size / 1024 / 1024).toFixed(2)}MB, limit is ${this.uploadMaxNoteMb}MB (UPLOAD_MAX_NOTE_MB).`);
                this.toast(this.t('media.upload_failed'), { type: 'warning' });
                return;
            }
            
            const rawStem = (file.name || '').replace(/\.md$/i, '').trim();
            const validation = FilenameValidator.validateFilename(rawStem);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                return;
            }
            const stem = validation.sanitized;
            
            let currentFolder = '';
            if (this.currentNote) {
                currentFolder = this.currentNote.includes('/')
                    ? this.currentNote.substring(0, this.currentNote.lastIndexOf('/'))
                    : '';
            } else if (this.selectedHomepageFolder) {
                currentFolder = this.selectedHomepageFolder;
            }
            
            const joinPath = (folder, filename) => folder ? `${folder}/${filename}` : filename;
            let targetPath = joinPath(currentFolder, `${stem}.md`);
            if (this.notePathTaken(targetPath)) {
                const ts = this._autoTitleTimestamp();
                targetPath = joinPath(currentFolder, `${stem}-${ts}.md`);
            }
            
            const content = await file.text();
            
            this._optimisticAddNote(targetPath, { content });
            if (currentFolder) this.expandedFolders.add(currentFolder);
            this._rebuildTreeAfterMutation();
            
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(targetPath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                if (!response.ok) throw new Error('Server returned error');
                const data = await response.json();
                const created = this.notes.find(n => n.path === targetPath);
                if (created) created.tags = data.tags || [];
            } catch (error) {
                this._optimisticRemoveNote(targetPath);
                this._rebuildTreeAfterMutation();
                throw error;
            }
            
            const noteName = targetPath.split('/').pop().replace(/\.md$/i, '');
            const encodedPath = targetPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
            const link = `[${noteName}](${encodedPath})`;
            
            // No note open (upload from the homepage): the note was created,
            // there is simply nowhere to drop the link.
            if (!this.currentNote) return;
            
            const textBefore = this.noteContent.substring(0, cursorPos);
            const textAfter = this.noteContent.substring(cursorPos);
            this.noteContent = textBefore + link + '\n' + textAfter;
            this.autoSave();
        },
        
        // Upload a media file (image, audio, video, PDF)
        async uploadMedia(file, notePath) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('note_path', notePath || '');
            
            const response = await fetch('/api/upload-media', {
                method: 'POST',
                body: formData
            });
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Upload failed');
            }
            const data = await response.json();
            // Drop the new file into the local note list so the wikilink
            // resolver finds it without a full /api/notes refresh.
            if (data.path) {
                this._optimisticAddNote(data.path, { size: file.size });
                this._rebuildTreeAfterMutation();
            }
            return data.path;
        },
        
        // Insert media markdown at cursor position using wiki-style syntax
        // (media links don't break when notes are moved). The uploaded file is
        // already in this.notes thanks to uploadMedia()'s optimistic add.
        async insertMediaMarkdown(mediaPath, altText, cursorPos) {
            const filename = mediaPath.split('/').pop();
            const filenameWithoutExt = filename.replace(/\.[^/.]+$/, '');
            const altWithoutExt = altText.replace(/\.[^/.]+$/, '');
            const markdown = (altWithoutExt && altWithoutExt !== filenameWithoutExt && !altWithoutExt.startsWith('pasted-image'))
                ? `![[${filename}|${altWithoutExt}]]`
                : `![[${filename}]]`;
            
            const textBefore = this.noteContent.substring(0, cursorPos);
            const textAfter = this.noteContent.substring(cursorPos);
            this.noteContent = textBefore + markdown + '\n' + textAfter;
            this.autoSave();
        },
        
        // Handle paste event for clipboard media (images)
        async handlePaste(event) {
            if (!this.currentNote) return;
            
            const clipboard = event.clipboardData;
            if (!clipboard) return;
            
            // Pasted/copied files (screenshots, a PDF copied from the file
            // manager, …). Plain-text pastes carry no files and must keep
            // flowing to the editor untouched.
            const files = Array.from(clipboard.files || []).filter(f => f && f.size > 0);
            const mediaFiles = files.filter(f =>
                ['image', 'audio', 'video', 'document'].includes(this.getMediaType(f.name)) ||
                (f.type || '').startsWith('image/')
            );
            if (mediaFiles.length === 0) return;
            
            event.preventDefault();
            const textarea = event.target;
            const cursorPos = textarea.selectionStart || 0;
            
            for (const file of mediaFiles) {
                try {
                    // Screenshots/clipboard images carry a generated name — keep the
                    // established pasted-image.* convention for them; real files
                    // (e.g. a copied report.pdf) keep their original name.
                    const nameLooksGenerated = !file.name || /^(image|pasted|clipboard|screenshot)/i.test(file.name);
                    let filename = file.name;
                    let uploadFile = file;
                    if ((file.type || '').startsWith('image/') && nameLooksGenerated) {
                        const ext = (file.type.split('/')[1] || 'png').toLowerCase();
                        filename = `pasted-image.${ext}`;
                        uploadFile = new File([file], filename, { type: file.type });
                    }
                    
                    const mediaPath = await this.uploadMedia(uploadFile, this.currentNote);
                    if (mediaPath) {
                        await this.insertMediaMarkdown(mediaPath, filename, cursorPos);
                    }
                } catch (error) {
                    ErrorHandler.handle('paste media', error);
                }
            }
        },
        
        // Media type detection based on file extension
        getMediaType(filename) {
            if (!filename) return null;
            const ext = filename.split('.').pop().toLowerCase();
            const mediaTypes = {
                image: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
                audio: ['mp3', 'wav', 'ogg', 'm4a'],
                video: ['mp4', 'webm', 'mov', 'avi'],
                document: ['pdf'],
            };
            for (const [type, extensions] of Object.entries(mediaTypes)) {
                if (extensions.includes(ext)) return type;
            }
            return null;
        },
        
        // Get icon for media type
        getMediaIcon(type) {
            const icons = {
                image: '🖼️',
                audio: '🎵',
                video: '🎬',
                document: '📄',
            };
            return icons[type] || '';
        },
        
        // Open a note or media file (unified handler for sidebar/homepage clicks)
        openItem(path, type = 'note', searchHighlight = '', targetLine = null, targetColumn = null) {
            this.showGraph = false;
            // Check if it's a media file by type or extension
            const mediaType = type !== 'note' ? type : this.getMediaType(path);
            if (mediaType && mediaType !== 'note') {
                this.viewMedia(path, mediaType);
            } else {
                this.loadNote(path, true, searchHighlight, targetLine, targetColumn);
            }
        },
        
        // Tear down the media viewer. Every path that clears currentMedia goes through here.
        closeMediaViewer() {
            this.currentMedia = '';
            this.currentMediaType = 'image';
        },
        
        // View a media file (image, audio, video, PDF) in the main pane
        viewMedia(mediaPath, mediaType = null, updateHistory = true) {
            // Close mobile sidebar when a media file is selected, same as loadNote
            this.mobileSidebarOpen = false;
            this.showGraph = false; // Ensure graph is closed
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.currentMedia = mediaPath; // Reuse currentMedia for all media
            this.currentMediaType = mediaType || this.getMediaType(mediaPath) || 'image';
            this.viewMode = 'preview'; // Use preview mode to show media
            
            // Update browser tab title
            const fileName = mediaPath.split('/').pop();
            document.title = `${fileName} - ${this.appName}`;
            
            // Expand folder tree to show the media file
            this.expandFolderForNote(mediaPath);
            
            // Update browser URL
            if (updateHistory) {
                // Encode each path segment to handle special characters
                const encodedPath = mediaPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
                window.history.pushState(
                    { mediaPath: mediaPath },
                    '',
                    `/${encodedPath}`
                );
            }
        },
        
        // Backward compatibility alias
        viewImage(mediaPath, updateHistory = true) {
            this.viewMedia(mediaPath, 'image', updateHistory);
        },
        
        // Delete a media file (image, audio, video, PDF)
        async deleteMedia(mediaPath) {
            const filename = mediaPath.split('/').pop();
            const ok = await this.confirmModalAsk({
                message: this.t('media.confirm_delete', { name: filename }),
            });
            if (!ok) return;
            
            this._optimisticRemoveNote(mediaPath);
            this._rebuildTreeAfterMutation();
            if (this.currentMedia === mediaPath) this.currentMedia = '';
            
            try {
                const response = await fetch(`/api/notes/${encodeURIComponent(mediaPath)}`, {
                    method: 'DELETE'
                });
                if (!response.ok) throw new Error('Failed to delete media file');
            } catch (error) {
                ErrorHandler.handle('delete media', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        // Single click entry point for the preview pane.
        handlePreviewClick(event) {
            if (this.toggleTaskFromPreview(event)) return;
            this.handleInternalLink(event);
        },

        /**
         * The checkbox a click should toggle: the box itself, or the one belonging to
         * the task item whose text was clicked. Returns null when the click was meant
         * for something else — following a link, playing a video, selecting text.
         */
        _taskBoxForClick(event) {
            const target = event.target;
            if (!target || !target.closest) return null;

            if (target.tagName === 'INPUT' && target.type === 'checkbox') return target;

            // Anything with its own click behaviour, plus code blocks, which people
            // click to read and copy rather than to tick something off.
            if (target.closest('a, img, video, audio, iframe, pre, button, label, summary')) return null;

            // detail > 1 is the second half of a double-click, which is someone
            // selecting a word rather than aiming at the item.
            if (event.detail !== 1) return null;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) return null;

            const item = target.closest('li');
            if (!item) return null;

            // First box in document order belongs to this item unless it sits in a
            // nested one, which is the case when a plain bullet has task children.
            const box = item.querySelector('input[type="checkbox"][data-task-index]');
            return box && box.closest('li') === item ? box : null;
        },

        /**
         * Every task in the note to the opposite of the clicked one, so ticking one box
         * off a mixed list ticks the rest. A single assignment, so one Ctrl+Z undoes it.
         *
         * The change touches many lines at once, which the single-shot replace
         * endpoint cannot express, so it goes through the regular (debounced,
         * conflict-checked) whole-note save.
         */
        _toggleAllTasksFromPreview(box) {
            const index = parseInt(box.getAttribute('data-task-index'), 10);
            if (!Number.isInteger(index)) return false;

            const taskLines = this._scanTaskLines(this.noteContent);
            const clickedLine = taskLines[index];
            if (clickedLine === undefined) return false;

            const lines = this.noteContent.split('\n');
            const clicked = lines[clickedLine].match(TASK_ITEM_RE);
            if (!clicked) return false;

            // Intent comes from the source, not the DOM: clicking the box has already
            // flipped the input, clicking the text next to it has not.
            const nextState = clicked[2] === ' ' ? 'x' : ' ';
            let changed = 0;

            for (const lineIdx of taskLines) {
                const updated = lines[lineIdx].replace(TASK_ITEM_RE, (m, prefix) => prefix + nextState);
                if (updated !== lines[lineIdx]) {
                    lines[lineIdx] = updated;
                    changed++;
                }
            }
            if (!changed) return true;

            this.noteContent = lines.join('\n');
            this.autoSave();
            this.toast(
                this.t(nextState === 'x' ? 'editor.tasks_all_checked' : 'editor.tasks_all_unchecked',
                    { changed, total: taskLines.length })
            );
            return true;
        },

        /**
         * Persist a single toggled task line through /api/notes/replace: the
         * endpoint patches exactly that line against the on-disk content, so a
         * click never overwrites edits made elsewhere (another editor, a sync
         * tool) the way a whole-note save would. Falls back to the regular
         * save when the line is not unique in the note (the endpoint answers
         * 409) or the request fails.
         */
        async _persistTaskToggle(oldLine, newLine) {
            try {
                const response = await fetch('/api/notes/replace', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: this.currentNote, old_str: oldLine, new_str: newLine })
                });
                if (!response.ok) {
                    this.autoSave();
                    return;
                }
                const result = await response.json();
                // The patched line is now the disk state the next whole-note
                // save is compared against.
                this.noteBaseHash = result.hash || null;
                this.lastSaved = true;
            } catch (error) {
                console.error('Failed to replace task line:', error);
                this.autoSave();
            }
        },

        /** Tick/untick the clicked task item in the source. True when it was a task. */
        toggleTaskFromPreview(event) {
            const box = this._taskBoxForClick(event);
            if (!box) return false;

            // Ctrl (Cmd on a Mac) applies the change to every task in the note. Ctrl
            // leaves the text selection alone, unlike Shift, so the guards in
            // _taskBoxForClick hold for the box and the item text alike.
            if (event.ctrlKey || event.metaKey) return this._toggleAllTasksFromPreview(box);

            const index = parseInt(box.getAttribute('data-task-index'), 10);
            if (!Number.isInteger(index)) return false;

            // Rescanned per click: the note can change between render and click.
            const lineIdx = this._scanTaskLines(this.noteContent)[index];
            if (lineIdx === undefined) return false;

            const lines = this.noteContent.split('\n');
            const oldLine = lines[lineIdx];
            const toggled = oldLine.replace(
                TASK_ITEM_RE,
                (match, prefix, state) => prefix + (state === ' ' ? 'x' : ' ')
            );
            if (toggled === oldLine) return false;

            lines[lineIdx] = toggled;
            this.noteContent = lines.join('\n');
            if (!this.isUndoRedo) this.pushToHistory();
            this.lastSaved = false;
            this._persistTaskToggle(oldLine, toggled);
            return true;
        },

        // ---- Hover previews for internal links --------------------------------
        // A small card next to a link shows the target note (or the linked
        // heading's section) so the user can peek without opening it. Bound
        // once to the document so it also works after Alpine re-renders the
        // preview HTML on every keystroke.
        initLinkPreviews() {
            if (this._linkPreviewBound) return;
            this._linkPreviewBound = true;
            this._linkPreviewCache = new Map();

            const selector = '.markdown-preview a[href]';
            const linkFrom = (event) => {
                const target = event.target;
                return target && target.closest ? target.closest(selector) : null;
            };

            document.addEventListener('mouseover', (event) => {
                const link = linkFrom(event);
                if (!link) return;
                this._scheduleLinkPreview(link);
            });

            document.addEventListener('mouseout', (event) => {
                const link = linkFrom(event);
                if (!link) return;
                if (event.relatedTarget && link.contains(event.relatedTarget)) return;
                this._scheduleLinkPreviewHide();
            });

            // Scrolling the page moves the anchor, so the card would float in
            // the wrong place. Scrolling inside the card itself is fine.
            document.addEventListener('scroll', (event) => {
                if (event.target && event.target.closest && event.target.closest('#link-preview-card')) return;
                this._hideLinkPreview();
            }, true);

            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') this._hideLinkPreview();
            });

            document.addEventListener('click', (event) => {
                if (linkFrom(event)) this._hideLinkPreview();
            }, true);
        },

        _ensureLinkPreviewCard() {
            let card = document.getElementById('link-preview-card');
            if (card) return card;

            card = document.createElement('div');
            card.id = 'link-preview-card';
            card.className = 'link-preview-card';
            card.setAttribute('role', 'tooltip');
            card.addEventListener('mouseenter', () => {
                clearTimeout(this._linkPreviewHideTimer);
            });
            card.addEventListener('mouseleave', () => {
                this._scheduleLinkPreviewHide();
            });
            document.body.appendChild(card);
            return card;
        },

        // Resolve an <a> in the preview to the note it points at. Returns null
        // for external/media links and unresolved notes.
        _resolveLinkPreviewTarget(link) {
            const href = (link.getAttribute('href') || '').trim();
            if (!href) return null;

            const externalPrefixes = [
                'http://', 'https://', '//', 'mailto:', 'tel:', 'ssh:', 'ftp:',
                'sftp:', 'slack:', 'discord:', 'teams:', 'vscode:', 'zoom:',
                'whatsapp:', 'telegram:', 'signal:', 'spotify:', 'steam:',
                'magnet:', 'data:', '/api/'
            ];
            if (externalPrefixes.some((prefix) => href.startsWith(prefix))) return null;

            let decodedHref = href;
            try {
                decodedHref = decodeURIComponent(href);
            } catch (e) {
                // A literal '%' in a filename must not break the preview.
            }

            const hashIndex = decodedHref.indexOf('#');
            let rawPath = hashIndex !== -1 ? decodedHref.substring(0, hashIndex) : decodedHref;
            const anchor = hashIndex !== -1 ? decodedHref.substring(hashIndex + 1) : '';
            rawPath = rawPath.split('?')[0];
            const notePath = rawPath.replace(/^\/+/, '');

            // In-page anchor: preview the corresponding section of this note.
            if (!notePath) {
                if (!anchor || !this.currentNote) return null;
                const currentName = this.currentNote.split('/').pop().replace(/\.md$/i, '');
                return {
                    path: this.currentNote,
                    anchor,
                    label: currentName || this.currentNote,
                };
            }

            let targetNote = this.notes.find((note) =>
                note.path === notePath || note.path === notePath + '.md'
            );

            if (!targetNote) {
                const sourceFolder = this.currentNote && this.currentNote.includes('/')
                    ? this.currentNote.substring(0, this.currentNote.lastIndexOf('/'))
                    : '';
                const resolved = this.resolveWikiLink(notePath, sourceFolder);
                if (resolved) {
                    targetNote = this.notes.find((note) =>
                        note.path === resolved || note.path === resolved + '.md'
                    );
                }
            }

            // Media has its own viewer and no markdown text to preview.
            if (!targetNote || (targetNote.type && targetNote.type !== 'note')) return null;

            return {
                path: targetNote.path,
                anchor,
                label: (anchor && link.textContent.includes('#'))
                    ? (targetNote.name || targetNote.path)
                    : (link.textContent.trim() || targetNote.name || targetNote.path),
            };
        },

        _scheduleLinkPreview(link) {
            const target = this._resolveLinkPreviewTarget(link);
            if (!target) {
                this._scheduleLinkPreviewHide();
                return;
            }
            if (this._linkPreviewAnchor === link) {
                clearTimeout(this._linkPreviewHideTimer);
                return;
            }

            clearTimeout(this._linkPreviewTimer);
            clearTimeout(this._linkPreviewHideTimer);
            this._linkPreviewAnchor = link;
            this._linkPreviewTimer = setTimeout(() => {
                this._showLinkPreview(link, target);
            }, 220);
        },

        _scheduleLinkPreviewHide() {
            clearTimeout(this._linkPreviewTimer);
            clearTimeout(this._linkPreviewHideTimer);
            this._linkPreviewHideTimer = setTimeout(() => this._hideLinkPreview(), 180);
        },

        _hideLinkPreview() {
            clearTimeout(this._linkPreviewTimer);
            clearTimeout(this._linkPreviewHideTimer);
            this._linkPreviewAnchor = null;
            this._linkPreviewToken = (this._linkPreviewToken || 0) + 1;
            const card = document.getElementById('link-preview-card');
            if (card) card.classList.remove('is-visible');
        },

        _linkPreviewHeader(label, anchor) {
            const safeLabel = this.escapeHtml(label || '');
            const anchorHtml = anchor
                ? `<span class="link-preview-anchor">#${this.escapeHtml(anchor)}</span>`
                : '';
            return `<div class="link-preview-header"><span class="link-preview-title">${safeLabel}</span>${anchorHtml}</div>`;
        },

        async _showLinkPreview(link, target) {
            this._linkPreviewTimer = null;
            const token = (this._linkPreviewToken || 0) + 1;
            this._linkPreviewToken = token;
            const card = this._ensureLinkPreviewCard();

            card.innerHTML = this._linkPreviewHeader(target.label, target.anchor) +
                `<div class="link-preview-loading">${this.escapeHtml(this.t('common.loading'))}</div>`;
            this._positionLinkPreview(card, link);
            card.classList.add('is-visible');

            try {
                const data = await this._loadLinkPreviewData(target.path);
                if (token !== this._linkPreviewToken || this._linkPreviewAnchor !== link) return;

                card.innerHTML = this._linkPreviewHeader(target.label, target.anchor) +
                    `<div class="link-preview-body markdown-preview">${this._buildLinkPreviewHTML(data, target.anchor)}</div>`;
                this._positionLinkPreview(card, link);
            } catch (error) {
                if (token !== this._linkPreviewToken || this._linkPreviewAnchor !== link) return;
                card.innerHTML = this._linkPreviewHeader(target.label, target.anchor) +
                    `<div class="link-preview-error">${this.escapeHtml(this.t('common.error'))}</div>`;
                this._positionLinkPreview(card, link);
            }
        },

        async _loadLinkPreviewData(notePath) {
            // In-page anchors and self-links should reflect unsaved edits, not
            // the last version written to disk.
            if (notePath === this.currentNote) {
                return {
                    content: this.noteContent || '',
                    outline: this.outline || [],
                    at: Date.now(),
                };
            }

            if (!this._linkPreviewCache) this._linkPreviewCache = new Map();
            const cached = this._linkPreviewCache.get(notePath);
            if (cached && Date.now() - cached.at < 30000) return cached;

            const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`);
            if (!response.ok) throw new Error('Failed to load preview');
            const data = await response.json();
            const entry = {
                content: data.content || '',
                outline: Array.isArray(data.outline) ? data.outline : [],
                at: Date.now(),
            };
            this._linkPreviewCache.set(notePath, entry);
            return entry;
        },

        _linkPreviewSlug(text) {
            return (text || '')
                .toLowerCase()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-');
        },

        // Pick the text to show: the linked heading's section when there is an
        // anchor, otherwise the beginning of the note.
        _linkPreviewExcerpt(content, outline, anchor) {
            const lines = (content || '').split('\n');

            // Keep original line numbers so outline entries (which count from
            // the top of the file) still point at the right place. Only the
            // default start line moves past a leading YAML block.
            let contentStart = 0;
            if (lines.length > 0 && lines[0].trim() === '---') {
                const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
                if (end !== -1) contentStart = end + 1;
            }

            let startLine = contentStart + 1;
            let endLine = lines.length;

            if (anchor) {
                const slug = this._linkPreviewSlug(anchor);
                const items = Array.isArray(outline) ? outline : [];
                const heading = items.find((item) =>
                    item.slug === slug ||
                    this._linkPreviewSlug(item.text) === slug ||
                    (item.text || '').toLowerCase() === anchor.toLowerCase()
                );
                if (heading && heading.line > 0) {
                    startLine = heading.line;
                    const next = items.find((item) =>
                        item.line > heading.line && item.level <= heading.level
                    );
                    if (next) endLine = next.line - 1;
                }
            }

            let excerptLines = lines.slice(startLine - 1, endLine);
            if (excerptLines.join('').trim() === '') {
                excerptLines = lines.slice(contentStart, contentStart + 40);
            }

            const maxLines = 80;
            let excerpt = excerptLines.slice(0, maxLines).join('\n').trim();
            if (excerptLines.length > maxLines) excerpt += '\n\n…';

            const maxChars = 6000;
            if (excerpt.length > maxChars) excerpt = excerpt.slice(0, maxChars).trimEnd() + '…';
            return excerpt;
        },

        _buildLinkPreviewHTML(data, anchor) {
            const excerpt = this._linkPreviewExcerpt(data.content, data.outline, anchor);
            if (!excerpt) {
                return '<p class="link-preview-empty">—</p>';
            }

            let html = DOMPurify.sanitize(marked.parse(excerpt));
            const container = document.createElement('div');
            container.innerHTML = html;

            // A card is for reading, not for navigating or loading media.
            container.querySelectorAll('img, video, audio, iframe, input, button, .media-embed, .md-pdf-embed')
                .forEach((el) => el.remove());
            container.querySelectorAll('a').forEach((a) => {
                a.removeAttribute('href');
                a.removeAttribute('target');
                a.removeAttribute('rel');
            });

            return container.innerHTML;
        },

        _positionLinkPreview(card, link) {
            const margin = 10;
            const rect = link.getBoundingClientRect();
            const wasHidden = !card.classList.contains('is-visible');

            if (wasHidden) {
                card.style.visibility = 'hidden';
                card.classList.add('is-visible');
            }

            const cardRect = card.getBoundingClientRect();
            let left = rect.left;
            const maxLeft = window.innerWidth - cardRect.width - margin;
            if (left > maxLeft) left = maxLeft;
            if (left < margin) left = margin;

            let top = rect.bottom + 8;
            if (top + cardRect.height > window.innerHeight - margin) {
                top = rect.top - cardRect.height - 8;
            }
            if (top < margin) top = margin;

            card.style.left = `${Math.round(left)}px`;
            card.style.top = `${Math.round(top)}px`;

            if (wasHidden) card.style.visibility = '';
        },

        // Handle clicks on internal links in preview
        handleInternalLink(event) {
            // Check if clicked element is a link
            const link = event.target.closest('a');
            if (!link) return;
            
            const href = link.getAttribute('href');
            if (!href) return;
            
            // Check if it's an external link or API path (media files, etc.)
            // Safe external protocols: http, https, mailto, tel, ssh, ftp, sftp, and app deep links
            const externalProtocols = ['http://', 'https://', '//', 'mailto:', 'tel:', 'ssh:', 'ftp:', 'sftp:', 'slack:', 'discord:', 'teams:', 'vscode:', 'zoom:', 'whatsapp:', 'telegram:', 'signal:', 'spotify:', 'steam:', 'magnet:', '/api/'];
            if (externalProtocols.some(p => href.startsWith(p))) {
                return; // Let external links and API paths work normally
            }
            
            // Prevent default navigation for internal links
            event.preventDefault();
            
            // Parse href into note path and anchor (e.g., "note.md#section" -> notePath="note.md", anchor="section")
            const decodedHref = decodeURIComponent(href);
            const hashIndex = decodedHref.indexOf('#');
            const rawPath = hashIndex !== -1 ? decodedHref.substring(0, hashIndex) : decodedHref;
            const anchor = hashIndex !== -1 ? decodedHref.substring(hashIndex + 1) : null;

            // Root-relative hrefs like /folder/note are vault paths with a slash bolted
            // on, and vault paths carry none. Protocol-relative //host already returned
            // above as external, so nothing here can be a host.
            const notePath = rawPath.replace(/^\/+/, '');
            
            // If it's just an anchor link (#heading), scroll within current note
            if (!notePath && anchor) {
                this.scrollToAnchor(anchor);
                return;
            }
            
            // Skip if no path
            if (!notePath) return;
            
            // Exact match first (covers media files and direct vault paths).
            let targetNote = this.notes.find(n => 
                n.path === notePath || 
                n.path === notePath + '.md'
            );
            
            if (!targetNote) {
                // Otherwise use the single resolver shared with the preview
                // renderer (relative to the current note's folder, then vault
                // root, then note stem — mirrors vault.LinkResolver).
                const sourceFolder = this.currentNote && this.currentNote.includes('/')
                    ? this.currentNote.substring(0, this.currentNote.lastIndexOf('/'))
                    : '';
                const resolved = this.resolveWikiLink(notePath, sourceFolder);
                if (resolved !== null) {
                    targetNote = this.notes.find(n =>
                        n.path === resolved ||
                        n.path === resolved + '.md'
                    );
                }
            }
            
            if (targetNote) {
                // Media files (PDF, images, audio, video) must open in the media
                // viewer — loadNote() would fetch the raw binary through
                // /api/notes and render it as a garbage "note".
                if (targetNote.type && targetNote.type !== 'note') {
                    this.openItem(targetNote.path, targetNote.type);
                    return;
                }
                // Load the note, then scroll to anchor if present
                this.loadNote(targetNote.path).then(() => {
                    if (anchor) {
                        // Small delay to ensure content is rendered
                        setTimeout(() => this.scrollToAnchor(anchor), 100);
                    }
                });
            } else {
                this.confirmModalAsk({
                    message: this.t('notes.create_from_link', { path: notePath }),
                    danger: false,
                    title: this.t('sidebar.new_note'),
                    confirmLabel: this.t('common.create'),
                }).then((ok) => {
                    if (ok) this.createNote(null, notePath);
                });
            }
        },
        
        // Scroll to an anchor (heading) by slug - reuses outline data
        scrollToAnchor(anchor) {
            // Normalize the anchor (GitHub-style slug)
            const targetSlug = anchor
                .toLowerCase()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-');
            
            // Find matching heading in outline
            const heading = this.outline.find(h => h.slug === targetSlug);
            
            if (heading) {
                this.scrollToHeading(heading);
            } else {
                // Fallback: try to find heading by exact text match
                const headingByText = this.outline.find(h => 
                    h.text.toLowerCase().replace(/\s+/g, '-') === anchor.toLowerCase()
                );
                if (headingByText) {
                    this.scrollToHeading(headingByText);
                }
            }
        },
        
        
        cancelDrag() {
            // Cancel any active drag operation (triggered by ESC key)
            this.draggedItem = null;
            this.dropTarget = null;
            this.dragOverFolder = null;
            // Reset styles - only query elements with drag-over class (more efficient)
            document.querySelectorAll('.folder-item').forEach(el => el.style.opacity = '1');
            document.querySelectorAll('.note-item').forEach(el => el.style.opacity = '1');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        },
        
        async onFolderDrop(targetFolderPath) {
            // Ignore if we're dropping into the editor
            if (this.dropTarget === 'editor') {
                return;
            }
            
            // Capture dragged item info immediately (ondragend may clear it)
            if (!this.draggedItem) return;
            const { path: draggedPath, type: draggedType } = this.draggedItem;
            
            // Determine item category for endpoint selection
            const isFolder = draggedType === 'folder';
            const isNote = draggedType === 'note';
            const isMedia = !isFolder && !isNote; // image, audio, video, document
            
            // Handle folder drop
            if (isFolder) {
                // Prevent dropping folder into itself or its subfolders
                if (targetFolderPath === draggedPath || 
                    targetFolderPath.startsWith(draggedPath + '/')) {
                    this.toast(this.t('folders.cannot_move_into_self'), { type: 'warning' });
                    return;
                }
                
                const folderName = draggedPath.split('/').pop();
                const newPath = targetFolderPath ? `${targetFolderPath}/${folderName}` : folderName;
                
                if (newPath === draggedPath) return;
                
                const oldPrefix = draggedPath + '/';
                const newPrefix = newPath + '/';
                const wasExpanded = this.expandedFolders.has(draggedPath);
                
                this._optimisticRenameFolderTree(draggedPath, newPath);
                this._rebuildTreeAfterMutation();
                
                const favoritesInFolder = this.favorites.filter(f => f.startsWith(oldPrefix));
                if (favoritesInFolder.length > 0) {
                    const newFavorites = this.favorites.map(f =>
                        f.startsWith(oldPrefix) ? newPrefix + f.substring(oldPrefix.length) : f
                    );
                    this.favorites = newFavorites;
                    this.favoritesSet = new Set(newFavorites);
                    this.saveFavorites();
                }
                if (wasExpanded) {
                    this.expandedFolders.delete(draggedPath);
                    this.expandedFolders.add(newPath);
                    this.saveExpandedFolders();
                }
                if (this.currentNote && this.currentNote.startsWith(oldPrefix)) {
                    this.currentNote = newPrefix + this.currentNote.substring(oldPrefix.length);
                }
                
                try {
                    const response = await fetch('/api/folders/move', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ oldPath: draggedPath, newPath })
                    });
                    if (!response.ok) {
                        const errorData = await response.json().catch(() => ({}));
                        throw new Error(errorData.detail || this.t('move.failed_folder'));
                    }
                } catch (error) {
                    console.error('Failed to move folder:', error);
                    this.toast(error.message || this.t('move.failed_folder'), { type: 'error' });
                    await this.loadNotes({ silent: true });
                }
                return;
            }
            
            // Handle note or media drop into folder
            const item = this.notes.find(n => n.path === draggedPath);
            if (!item) return;
            
            const filename = draggedPath.split('/').pop();
            const newPath = targetFolderPath ? `${targetFolderPath}/${filename}` : filename;
            
            if (newPath === draggedPath) return;
            
            const wasFavorited = isNote && this.favoritesSet.has(draggedPath);
            const wasCurrentNote = this.currentNote === draggedPath;
            const wasCurrentMedia = this.currentMedia === draggedPath;
            
            this._optimisticRenameNote(draggedPath, newPath);
            this._rebuildTreeAfterMutation();
            
            if (wasFavorited) {
                this.favorites = this.favorites.map(f => f === draggedPath ? newPath : f);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            if (wasCurrentNote) this.currentNote = newPath;
            if (wasCurrentMedia) this.currentMedia = newPath;
            
            try {
                const endpoint = isMedia ? '/api/media/move' : '/api/notes/move';
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldPath: draggedPath, newPath })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const errorKey = isMedia ? 'move.failed_media' : 'move.failed_note';
                    throw new Error(errorData.detail || this.t(errorKey));
                }
            } catch (error) {
                console.error(`Failed to move ${isMedia ? 'media' : 'note'}:`, error);
                this.toast(error.message || this.t(isMedia ? 'move.failed_media' : 'move.failed_note'), { type: 'error' });
                await this.loadNotes({ silent: true });
            }
        },
        
        
        // Load a specific note. targetLine/targetColumn are the 1-based position
        // of the occurrence to focus when the note was opened from a search
        // result (a line can hold more than one occurrence of the term).
        async loadNote(notePath, updateHistory = true, searchQuery = '', targetLine = null, targetColumn = null) {
            try {
                // Close mobile sidebar when a note is selected
                this.mobileSidebarOpen = false;

                // include_backlinks=true: the backend only computes backlinks when
                // this flag is present (they require a full vault scan, so they're
                // opt-in per request). Without it the panel always shows empty.
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}?include_backlinks=true`);
                
                // Check if note exists
                if (!response.ok) {
                    if (response.status === 404) {
                        // Note not found - silently redirect to home
                        window.history.replaceState({ homepageFolder: this.selectedHomepageFolder || '' }, '', '/');
                        this.currentNote = '';
                        this.noteContent = '';
                        this.noteBaseHash = null;
                        this.closeMediaViewer();
                        document.title = this.appName;
                        return;
                    }
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();

                this.currentNote = notePath;
                this._lastRenderedContent = ''; // Clear render cache for new note
                this._lastRenderedNote = '';
                this._cachedRenderedHTML = '';
                this._initializedVideoSources = new Set(); // Clear video cache for new note
                this.noteContent = data.content;
                this.noteBaseHash = data.hash || null;
                // Note: scroll restoration happens later in the post-$nextTick block below
                // (where the existing scrollToTop call used to live), via _restoreNoteScroll().
                // Doing it there means a single, unified restore path instead of two racing
                // ones. See the post-$nextTick block for the full timing rationale.
                this.currentNoteName = notePath.split('/').pop().replace('.md', '');
                this.closeMediaViewer(); // Clear image viewer when loading a note
                
                // Update browser tab title
                document.title = `${this.currentNoteName} - ${this.appName}`;
                this.lastSaved = false;
                
                // Outline and frontmatter parsed server-side
                this.outline = data.outline || [];

                // Store backlinks from API response
                this.backlinks = data.backlinks || [];

                // Initialize undo/redo history for this note (with cursor at start)
                this.undoHistory = [{ content: data.content, cursorPos: 0 }];
                this.redoHistory = [];
                this.hasPendingHistoryChanges = false;
                
                // Update browser URL and history
                if (updateHistory) {
                    // Encode the path properly (spaces become %20, etc.)
                    const pathWithoutExtension = notePath.replace('.md', '');
                    // Encode each path segment to handle special characters
                    const encodedPath = pathWithoutExtension.split('/').map(segment => encodeURIComponent(segment)).join('/');
                    const params = new URLSearchParams();
                    if (searchQuery) {
                        params.set('search', searchQuery);
                    }
                    if (targetLine) {
                        params.set('line', String(targetLine));
                    }
                    if (targetColumn) {
                        params.set('col', String(targetColumn));
                    }
                    const queryString = params.toString();
                    const url = `/${encodedPath}${queryString ? `?${queryString}` : ''}`;
                    window.history.pushState(
                        { 
                            notePath: notePath, 
                            searchQuery: searchQuery,
                            targetLine: targetLine,
                            targetColumn: targetColumn,
                            homepageFolder: this.selectedHomepageFolder || '' // Save current folder state
                        },
                        '',
                        url
                    );
                }
                
                // Frontmatter parsed server-side
                this.noteMetadata = data.frontmatter || null;
                
                // Store search query for highlighting
                if (searchQuery) {
                    this.currentSearchHighlight = searchQuery;
                } else {
                    // Clear highlights if no search query
                    this.currentSearchHighlight = '';
                }
                
                // Expand folder tree to show the loaded note
                this.expandFolderForNote(notePath);
                
                // Use $nextTick twice to ensure Alpine.js has time to:
                // 1. First tick: expand folders and update DOM
                // 2. Second tick: highlight the note and setup everything else
                this.$nextTick(() => {
                    this.$nextTick(() => {
                        this.refreshDOMCache();
                        this.setupScrollSync();

                        // When the note was opened from a search result, the
                        // target line/match wins over the last scroll position.
                        // Otherwise the delayed restore below would drag the
                        // viewport back to wherever the user stopped reading.
                        const focusSearchTarget = !!(searchQuery || (targetLine && targetLine > 0));
                        if (!focusSearchTarget) {
                            // First pass: editor is ready (textarea reflows synchronously). Preview
                            // may still have scrollHeight=0 because the markdown render pipeline
                            // (marked + MathJax + Mermaid + syntax highlighting) is async.
                            this._restoreNoteScroll();
                            // Second pass on a later frame: by now the preview pane has typically
                            // rendered and laid out, so its scrollTop write actually sticks. The
                            // helper is idempotent — re-running for the editor is a no-op.
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    this._restoreNoteScroll();
                                });
                            });
                        }

                        // Apply or clear search highlighting
                        if (searchQuery) {
                            // Pass true to focus editor when loading from search result
                            this.highlightSearchTerm(searchQuery, true, targetLine, targetColumn);
                        } else if (targetLine) {
                            this.scrollEditorToLine(targetLine);
                            this.scrollPreviewToSourceLine(targetLine);
                            this.clearSearchHighlights();
                        } else {
                            this.clearSearchHighlights();
                        }
                        
                        // Scroll note into view in sidebar if needed
                        this.scrollNoteIntoView(notePath);
                    });
                });
                
            } catch (error) {
                ErrorHandler.handle('load note', error);
            }
        },
        
        // Load item (note or media) from URL path
        loadItemFromURL() {
            // Get path from URL (e.g., /folder/note or /folder/image.png)
            let path = window.location.pathname;
            
            // Strip .md extension if present (for MKdocs/Zensical integration)
            if (path.toLowerCase().endsWith('.md')) {
                path = path.slice(0, -3);
                // Update URL bar to show clean path without .md
                window.history.replaceState(null, '', path);
            }
            
            // Skip if root path or static assets
            if (path === '/' || path.startsWith('/static/') || path.startsWith('/api/')) {
                return;
            }
            
            // Remove leading slash and decode URL encoding (e.g., %20 -> space)
            const decodedPath = decodeURIComponent(path.substring(1));
            
            // Check if this is a media file (image, audio, video, PDF)
            const matchedItem = this.notes.find(n => n.path === decodedPath);
            
            if (matchedItem && matchedItem.type !== 'note') {
                // It's a media file, view it
                this.viewMedia(decodedPath, matchedItem.type, false); // false = don't update history
            } else {
                // It's a note, add .md extension and load it
                const notePath = decodedPath + '.md';
                
                // Parse query string for search parameter and optional line anchor
                const urlParams = new URLSearchParams(window.location.search);
                const searchParam = urlParams.get('search');
                const lineParam = parseInt(urlParams.get('line') || '', 10);
                const targetLine = Number.isFinite(lineParam) && lineParam > 0 ? lineParam : null;
                const colParam = parseInt(urlParams.get('col') || '', 10);
                const targetColumn = Number.isFinite(colParam) && colParam > 0 ? colParam : null;
                
                // Try to load the note directly - the backend will handle 404 if it doesn't exist
                // This is more robust than checking the frontend notes list
                this.loadNote(notePath, false, searchParam || '', targetLine, targetColumn);
                
                // If there's a search parameter, populate the search box and trigger search
                if (searchParam) {
                    this.searchQuery = searchParam;
                    // Trigger search to populate results list
                    this.searchNotes();
                }
            }
        },
        
        // Fold text for accent-insensitive, case-insensitive matching. Returns
        // the folded string plus a map from each folded code unit to the
        // original index, so highlights can slice the original text even when
        // NFD normalization changes its length.
        _foldForSearch(text) {
            // Fast path: ASCII lowercases 1:1, so the index map is the identity.
            let ascii = true;
            for (let i = 0; i < text.length; i++) {
                if (text.charCodeAt(i) > 127) {
                    ascii = false;
                    break;
                }
            }
            if (ascii) {
                const map = new Array(text.length + 1);
                for (let i = 0; i <= text.length; i++) map[i] = i;
                return { text: text.toLowerCase(), map };
            }

            const chars = [];
            const map = [];
            for (let i = 0; i < text.length; i++) {
                const folded = text[i]
                    .normalize('NFD')
                    .replace(SEARCH_COMBINING_MARKS, '')
                    .toLowerCase();
                for (let j = 0; j < folded.length; j++) {
                    chars.push(folded[j]);
                    map.push(i);
                }
            }
            map.push(text.length);
            return { text: chars.join(''), map };
        },

        // First folded index whose original position is >= origIndex.
        _foldedIndexForOriginal(map, origIndex) {
            let low = 0;
            let high = map.length - 1;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (map[mid] < origIndex) {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            return low;
        },

        // 0-based character offset where a 1-based source line starts.
        _lineStartOffset(content, line) {
            if (line <= 1) return 0;
            let offset = 0;
            for (let i = 1; i < line; i++) {
                const newline = content.indexOf('\n', offset);
                if (newline === -1) return content.length;
                offset = newline + 1;
            }
            return offset;
        },

        // Highlight search term in editor and preview
        highlightSearchTerm(query, focusEditor = false, targetLine = null, targetColumn = null) {
            if (!query || !query.trim()) {
                this.clearSearchHighlights();
                return;
            }
            
            const searchTerm = query.trim();
            
            // Highlight in editor (textarea)
            this.highlightInEditor(searchTerm, focusEditor, targetLine, targetColumn);
            
            // Highlight in preview (rendered HTML)
            this.highlightInPreview(searchTerm, targetLine, targetColumn);
        },

        // Re-apply the current search highlight after the preview re-rendered
        // (note loaded, or the user edited the note). Keeps whichever
        // occurrence was active and leaves the scroll position alone: the pass
        // that runs right after a search click has already scrolled to the
        // chosen occurrence, and snapping back to match 0 here is what made the
        // clicked occurrence lose its highlight.
        _reapplySearchHighlights() {
            const query = this.currentSearchHighlight;
            if (!query) return;
            const keepIndex = this.currentMatchIndex;
            this.highlightInEditor(query, false, null, null, { scroll: false });
            this.highlightInPreview(query, null, null, {
                keepActiveIndex: keepIndex,
                scroll: false,
            });
        },

        // Highlight search term in the editor textarea
        highlightInEditor(searchTerm, shouldFocus = false, targetLine = null, targetColumn = null, opts = {}) {
            const editor = this._domCache.editor || document.getElementById('editor');
            if (!editor) return;
            
            // A textarea cannot contain styled marks, so the editor side is
            // about scrolling to (and optionally selecting) the right match.
            const content = editor.value;
            const foldedContent = this._foldForSearch(content);
            const foldedTerm = this._foldForSearch(searchTerm).text;
            if (!foldedTerm) return;

            let index = -1;
            let foundOnTargetLine = false;
            if (targetLine && targetLine > 0) {
                const lineStart = this._lineStartOffset(content, targetLine);
                const lineEnd = this._lineStartOffset(content, targetLine + 1);
                const foldedStart = this._foldedIndexForOriginal(foldedContent.map, lineStart);

                // A line can hold several occurrences of the same term, so the
                // column the sidebar reported pins the exact one. Using only
                // the line used to select the first match on it.
                if (targetColumn && targetColumn > 0) {
                    const offset = this._sourceOffsetForLineColumn(content, targetLine, targetColumn);
                    const foldedIdx = this._foldedIndexForOriginal(foldedContent.map, offset);
                    if (foldedContent.text.startsWith(foldedTerm, foldedIdx)
                        && foldedContent.map[foldedIdx] < lineEnd) {
                        index = foldedIdx;
                        foundOnTargetLine = true;
                    }
                }

                if (index === -1) {
                    const candidate = foldedContent.text.indexOf(foldedTerm, foldedStart);
                    // Only accept the candidate when it actually starts on the
                    // requested line; otherwise the note changed since the search.
                    if (candidate !== -1 && foldedContent.map[candidate] < lineEnd) {
                        index = candidate;
                        foundOnTargetLine = true;
                    }
                }
            }
            // Fall back to the first occurrence when the requested line has no
            // match (e.g. the line number came from a different revision).
            if (index === -1) {
                index = foldedContent.text.indexOf(foldedTerm);
            }

            let targetScroll = null;
            if (opts.scroll !== false) {
                const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
                if (foundOnTargetLine) {
                    targetScroll = Math.max(0, (targetLine - 5) * lineHeight);
                } else if (index !== -1) {
                    const lineNumber = content.substring(0, foldedContent.map[index]).split('\n').length;
                    targetScroll = Math.max(0, (lineNumber - 5) * lineHeight);
                }
                if (targetScroll !== null) {
                    this._suspendScrollSync();
                    editor.scrollTop = targetScroll;
                }
            }

            if (index !== -1 && shouldFocus) {
                const start = foldedContent.map[index];
                const end = foldedContent.map[index + foldedTerm.length];

                // Place the caret before focusing: focus() reveals the current
                // caret, and the caret left at the end of the previous note
                // scrolled the editor to the bottom (scroll-sync then dragged
                // the preview down with it).
                editor.setSelectionRange(start, end);
                editor.focus();
                if (targetScroll !== null) {
                    this._suspendScrollSync();
                    editor.scrollTop = targetScroll;
                }
                
                // Blur immediately so the selection stays visible but editor isn't focused
                setTimeout(() => editor.blur(), 100);
            }
        },
        
        // Highlight search term in the preview pane
        highlightInPreview(searchTerm, targetLine = null, targetColumn = null, opts = {}) {
            const preview = document.querySelector('.markdown-preview');
            if (!preview) return;
            
            // Remove existing highlights
            this.clearSearchHighlights();

            const foldedTerm = this._foldForSearch(searchTerm).text;
            if (!foldedTerm) return;
            
            // Create a tree walker to find all text nodes
            const walker = document.createTreeWalker(
                preview,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            
            const textNodes = [];
            let node;
            while (node = walker.nextNode()) {
                // Skip anything inside <code>/<pre>. closest() (rather than a
                // parent check) also covers the copy buttons the renderer
                // injects into every <pre>, whose text is not note content.
                if (node.parentElement && node.parentElement.closest('code, pre')) {
                    continue;
                }
                textNodes.push(node);
            }
            
            let matchIndex = 0;
            
            // Highlight matches in text nodes
            textNodes.forEach(textNode => {
                const text = textNode.textContent;
                const foldedText = this._foldForSearch(text);
                
                const fragment = document.createDocumentFragment();
                let lastOriginal = 0;
                let searchFrom = 0;
                let matchesInNode = 0;
                let index;
                
                while ((index = foldedText.text.indexOf(foldedTerm, searchFrom)) !== -1) {
                    const start = foldedText.map[index];
                    const end = foldedText.map[index + foldedTerm.length];
                    
                    // Add text before match
                    if (start > lastOriginal) {
                        fragment.appendChild(
                            document.createTextNode(text.substring(lastOriginal, start))
                        );
                    }
                    
                    // Add highlighted match
                    const mark = document.createElement('mark');
                    mark.className = 'search-highlight';
                    mark.setAttribute('data-match-index', matchIndex);
                    mark.textContent = text.substring(start, end);
                    
                    // First match is active (styled via CSS)
                    if (matchIndex === 0) {
                        mark.classList.add('active-match');
                    }
                    
                    fragment.appendChild(mark);
                    matchIndex++;
                    matchesInNode++;
                    lastOriginal = end;
                    searchFrom = index + foldedTerm.length;
                }
                
                if (matchesInNode > 0) {
                    // Add remaining text
                    if (lastOriginal < text.length) {
                        fragment.appendChild(
                            document.createTextNode(text.substring(lastOriginal))
                        );
                    }
                    
                    // Replace text node with highlighted fragment
                    textNode.parentNode.replaceChild(fragment, textNode);
                }
            });
            
            // Update total matches and reset current index
            this.totalMatches = matchIndex;
            this.currentMatchIndex = matchIndex > 0 ? 0 : -1;

            const marks = preview.querySelectorAll('mark.search-highlight');

            // Re-apply pass (the note re-rendered while highlights were
            // already showing): keep the occurrence that was active, and leave
            // the viewport where it is unless asked to scroll.
            if (opts.keepActiveIndex != null) {
                if (marks.length === 0) {
                    this.currentMatchIndex = -1;
                    return;
                }
                const keep = opts.keepActiveIndex < 0
                    ? -1
                    : Math.min(opts.keepActiveIndex, marks.length - 1);
                marks.forEach((mark, i) => {
                    mark.classList.toggle('active-match', i === keep);
                });
                this.currentMatchIndex = keep;
                if (opts.scroll !== false && keep >= 0) this.scrollToMatch(keep);
                return;
            }
            
            // Prefer the exact occurrence the user clicked; otherwise scroll
            // to the first highlighted match.
            if (targetLine && targetLine > 0) {
                this._focusPreviewOccurrence(marks, targetLine, targetColumn, foldedTerm);
            } else if (this.totalMatches > 0 && opts.scroll !== false) {
                this.scrollToMatch(0);
            }
        },

        // Make the occurrence at line:column the active <mark> and scroll it
        // into view. When the source-side numbering cannot be trusted (the
        // term also appears in code, link targets, math, …) fall back to the
        // mark nearest the block anchor for that line.
        _focusPreviewOccurrence(marks, targetLine, targetColumn, foldedTerm) {
            if (marks.length === 0) {
                this.scrollPreviewToSourceLine(targetLine);
                this.currentMatchIndex = -1;
                return;
            }

            const offset = this._sourceOffsetForLineColumn(
                this.noteContent || '', targetLine, targetColumn
            );
            let index = this._previewMarkIndexForSourceOffset(offset, foldedTerm, marks.length);

            if (index === -1) {
                // The occurrence lives in frontmatter or in code: the preview
                // has no mark for it (the editor still selects it).
                marks.forEach((mark) => mark.classList.remove('active-match'));
                this.scrollPreviewToSourceLine(targetLine);
                this.currentMatchIndex = -1;
                return;
            }

            if (index < 0) {
                // Counts disagree: keep the old "nearest to the anchor" pick.
                this.scrollPreviewToSourceLine(targetLine);
                const container = this._domCache.previewContainer;
                if (!container) return;
                const anchor = container.scrollTop + 100;
                let best = 0;
                let bestDist = Infinity;
                marks.forEach((mark, i) => {
                    const dist = Math.abs(this._scrollTopOfPreviewElement(mark) - anchor);
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = i;
                    }
                });
                index = best;
            }

            marks.forEach((mark, i) => {
                mark.classList.toggle('active-match', i === index);
            });
            this.currentMatchIndex = index;
            this._scrollPreviewToElement(marks[index], 100, { suppressSync: true });
        },

        // Index of the <mark> that corresponds to a source offset, or
        //   -1 when that occurrence never becomes preview text, and
        //   -2 when the source-side count disagrees with the rendered marks.
        _previewMarkIndexForSourceOffset(offset, foldedTerm, markCount) {
            const content = this.noteContent || '';
            if (!content) return -2;

            const folded = this._foldForSearch(content);
            const regions = this._searchHiddenRegions(content);
            if (this._spanOverlapsRegions(regions, offset, offset + 1)) return -1;

            let before = 0;
            let total = 0;
            let from = 0;
            while (true) {
                const idx = folded.text.indexOf(foldedTerm, from);
                if (idx === -1) break;
                from = idx + foldedTerm.length;

                const start = folded.map[idx];
                const end = folded.map[idx + foldedTerm.length];
                if (this._spanOverlapsRegions(regions, start, end)) continue;

                total++;
                if (start < offset) before++;
            }

            // Only trust the numbering when both sides agree on the amount of
            // highlightable occurrences; a mismatch means one of the hidden
            // region rules above is off for this note.
            if (total !== markCount || before >= markCount) return -2;
            return before;
        },

        // 0-based character offset of a 1-based line:column (the column is in
        // runes, as reported by the search API). Clamped to the end of the
        // line so a stale column cannot spill into the next one.
        _sourceOffsetForLineColumn(content, line, column = 1) {
            let offset = this._lineStartOffset(content, line);
            let rune = 1;
            while (offset < content.length && rune < column) {
                const code = content.codePointAt(offset);
                if (code === 10) break; // '\n'
                offset += code > 0xFFFF ? 2 : 1;
                rune++;
            }
            return offset;
        },

        // Source spans that never show up as text in the preview. Mirrors
        // highlightInPreview's "skip code" rule plus the constructs the
        // renderer consumes instead of emitting as text: frontmatter, fenced
        // and inline code, HTML tags, link destinations, image alt text, the
        // target half of [[target|display]] and reference definitions.
        // Counting occurrences this way lets a clicked sidebar row be mapped
        // onto the exact <mark>.
        _searchHiddenRegions(content) {
            const regions = [];
            const add = (start, end) => {
                if (end > start) regions.push([start, end]);
            };

            // Line starts, so every rule can work with whole lines.
            const lineStarts = [0];
            for (let p = content.indexOf('\n'); p !== -1; p = content.indexOf('\n', p + 1)) {
                lineStarts.push(p + 1);
            }
            const lineEnd = (i) => (i + 1 < lineStarts.length ? lineStarts[i + 1] - 1 : content.length);

            // Frontmatter, fenced code and reference definitions.
            let fence = null;
            for (let i = 0; i < lineStarts.length; i++) {
                const line = content.slice(lineStarts[i], lineEnd(i));

                // The renderer strips YAML frontmatter: opening '---' line,
                // then everything up to the next line that trims to '---'.
                if (i === 0 && line.trim() === '---') {
                    let close = -1;
                    for (let k = 1; k < lineStarts.length; k++) {
                        if (content.slice(lineStarts[k], lineEnd(k)).trim() === '---') {
                            close = k;
                            break;
                        }
                    }
                    if (close !== -1) {
                        add(0, lineEnd(close));
                        i = close;
                        continue;
                    }
                }

                if (fence) {
                    if (fence.closeRe.test(line)) {
                        add(fence.start, lineEnd(i));
                        fence = null;
                    }
                    continue;
                }

                const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
                if (open) {
                    const ch = open[1][0];
                    fence = {
                        start: lineStarts[i],
                        closeRe: new RegExp(
                            '^\\s{0,3}' + (ch === '`' ? '`' : '~') + '{' + open[1].length + ',}\\s*$'
                        ),
                    };
                    continue;
                }

                if (/^\s{0,3}\[[^\]]+\]:/.test(line)) add(lineStarts[i], lineEnd(i));
            }
            if (fence) add(fence.start, content.length);

            // Inline constructs, scanned once over the whole document.
            // Overlapping the line-based regions above is harmless.
            const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/y;
            let i = 0;
            while (i < content.length) {
                const ch = content[i];

                if (ch === '`') {
                    let runLen = 1;
                    while (content[i + runLen] === '`') runLen++;
                    let j = i + runLen;
                    let closed = -1;
                    const limit = Math.min(content.length, i + 5000);
                    while (j < limit) {
                        if (content[j] === '`') {
                            let closeLen = 1;
                            while (content[j + closeLen] === '`') closeLen++;
                            if (closeLen === runLen) {
                                closed = j + closeLen;
                                break;
                            }
                            j += closeLen;
                            continue;
                        }
                        // An inline code span cannot cross a blank line.
                        if (content[j] === '\n' && content[j + 1] === '\n') break;
                        j++;
                    }
                    if (closed !== -1) {
                        add(i, closed);
                        i = closed;
                    } else {
                        i += runLen;
                    }
                    continue;
                }

                if (ch === '<') {
                    if (content.startsWith('<!--', i)) {
                        const end = content.indexOf('-->', i + 4);
                        if (end !== -1) {
                            add(i, end + 3);
                            i = end + 3;
                            continue;
                        }
                    }
                    TAG_RE.lastIndex = i;
                    const tag = TAG_RE.exec(content);
                    if (tag) {
                        add(i, i + tag[0].length);
                        i += tag[0].length;
                        continue;
                    }
                    if (content.startsWith('<!', i) || content.startsWith('<?', i)) {
                        const gt = content.indexOf('>', i);
                        if (gt !== -1) {
                            add(i, gt + 1);
                            i = gt + 1;
                            continue;
                        }
                    }
                    i++;
                    continue;
                }

                if (ch === '!' && content[i + 1] === '[') {
                    // ![alt](url) and ![[media]]: neither alt text nor the
                    // media name is rendered as note text.
                    let depth = 0;
                    let j = i + 1;
                    for (; j < content.length; j++) {
                        if (content[j] === '[') depth++;
                        else if (content[j] === ']') {
                            depth--;
                            if (depth === 0) break;
                        }
                    }
                    if (j < content.length) {
                        add(i, j + 1);
                        i = j + 1;
                    } else {
                        i++;
                    }
                    continue;
                }

                if (ch === '[' && content[i + 1] === '[') {
                    // [[target|display]]: only the display half is rendered.
                    const close = content.indexOf(']]', i + 2);
                    if (close !== -1) {
                        const pipe = content.indexOf('|', i + 2);
                        if (pipe !== -1 && pipe < close) add(i, pipe + 1);
                        i = close + 2;
                        continue;
                    }
                    i += 2;
                    continue;
                }

                if (ch === ']' && content[i + 1] === '(') {
                    // Link destination (with optional title), never text.
                    let depth = 0;
                    let j = i + 1;
                    for (; j < content.length; j++) {
                        if (content[j] === '(') depth++;
                        else if (content[j] === ')') {
                            depth--;
                            if (depth === 0) break;
                        }
                    }
                    if (j < content.length) {
                        add(i, j + 1);
                        i = j + 1;
                    } else {
                        i++;
                    }
                    continue;
                }

                i++;
            }

            return regions;
        },

        _spanOverlapsRegions(regions, start, end) {
            for (const [regionStart, regionEnd] of regions) {
                if (start < regionEnd && end > regionStart) return true;
            }
            return false;
        },

        // Scroll `el` (a preview descendant) to `offset` px below the top of
        // the preview pane. Rect-based so it does not depend on which ancestor
        // happens to be the offset parent. suppressSync is used by jumps that
        // also position the editor themselves: mirroring this write back would
        // replace the exact target with a proportional guess.
        _scrollPreviewToElement(el, offset = 100, opts = {}) {
            const container = this._domCache.previewContainer;
            if (!container || !el) return;
            const cRect = container.getBoundingClientRect();
            const eRect = el.getBoundingClientRect();
            if (opts.suppressSync) this._suspendScrollSync();
            container.scrollTop = Math.max(0, container.scrollTop + eRect.top - cRect.top - offset);
        },

        // Current scroll offset of a preview element inside the preview pane.
        _scrollTopOfPreviewElement(el) {
            const container = this._domCache.previewContainer;
            if (!container || !el) return 0;
            const cRect = container.getBoundingClientRect();
            const eRect = el.getBoundingClientRect();
            return container.scrollTop + eRect.top - cRect.top;
        },

        // Scroll the textarea to a 1-based source line.
        scrollEditorToLine(line) {
            const editor = this._domCache.editor || document.getElementById('editor');
            if (!editor || !line || line < 1) return;
            const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
            editor.scrollTop = Math.max(0, (line - 5) * lineHeight);
        },

        // Scroll the preview to the nearest block carrying a data-source-line
        // anchor (the markdown renderer stamps these during scroll-sync setup).
        // Anchors store 0-based line indexes because they drive scroll-sync
        // against the editor, while search results report 1-based lines.
        scrollPreviewToSourceLine(line) {
            const preview = document.querySelector('.markdown-preview');
            if (!preview || !line) return;

            const target = line - 1;
            const anchors = preview.querySelectorAll('[data-source-line]');
            let best = null;
            let bestLine = -1;
            for (const el of anchors) {
                const anchorLine = parseInt(el.getAttribute('data-source-line'), 10);
                if (!Number.isFinite(anchorLine)) continue;
                if (anchorLine === target) {
                    best = el;
                    bestLine = anchorLine;
                    break;
                }
                if (anchorLine <= target && anchorLine > bestLine) {
                    best = el;
                    bestLine = anchorLine;
                }
            }

            if (!best) {
                const firstMatch = preview.querySelector('mark.search-highlight');
                if (firstMatch) this._scrollPreviewToElement(firstMatch, 100, { suppressSync: true });
                return;
            }
            this._scrollPreviewToElement(best, 100, { suppressSync: true });
        },
        
        // Navigate to next search match
        nextMatch() {
            if (this.totalMatches === 0) return;
            
            this.currentMatchIndex = (this.currentMatchIndex + 1) % this.totalMatches;
            this.scrollToMatch(this.currentMatchIndex);
        },
        
        // Navigate to previous search match
        previousMatch() {
            if (this.totalMatches === 0) return;
            
            this.currentMatchIndex = (this.currentMatchIndex - 1 + this.totalMatches) % this.totalMatches;
            this.scrollToMatch(this.currentMatchIndex);
        },
        
        // Scroll to a specific match index
        scrollToMatch(index) {
            const preview = document.querySelector('.markdown-preview');
            if (!preview) return;
            
            const allMatches = preview.querySelectorAll('mark.search-highlight');
            if (index < 0 || index >= allMatches.length) return;
            
            // Update styling - make current match prominent (via CSS class)
            allMatches.forEach((mark, i) => {
                mark.classList.toggle('active-match', i === index);
            });
            
            // Scroll to the match
            const targetMatch = allMatches[index];
            if (targetMatch) this._scrollPreviewToElement(targetMatch);
        },
        
        // Clear search highlights
        clearSearchHighlights() {
            const preview = document.querySelector('.markdown-preview');
            if (!preview) return;
            
            const highlights = preview.querySelectorAll('mark.search-highlight');
            highlights.forEach(mark => {
                const text = document.createTextNode(mark.textContent);
                mark.parentNode.replaceChild(text, mark);
            });
            
            // Normalize text nodes to merge adjacent text nodes
            preview.normalize();
            
            // Reset match counters
            this.totalMatches = 0;
            this.currentMatchIndex = -1;
        },
        
        // =====================================================
        // DROPDOWN MENU SYSTEM
        // =====================================================
        
        // Shift+click always forces the chooser regardless of newButtonAction.
        toggleNewDropdown(event) {
            const wantsChooser =
                (event && event.shiftKey) ||
                !this.newButtonAction ||
                this.newButtonAction === 'chooser';
            
            if (wantsChooser) {
                this._openNewDropdownChooser(event);
                return;
            }
            
            switch (this.newButtonAction) {
                case 'note':     this.createNote();         break;
                case 'folder':   this.createFolder();       break;
                default:         this._openNewDropdownChooser(event);
            }
        },
        
        _openNewDropdownChooser(event) {
            this.showNewDropdown = true;
            
            if (event && event.target) {
                const rect = event.target.getBoundingClientRect();
                let top = rect.bottom + 4;
                let left = rect.left;
                
                const dropdownWidth = 200;
                const dropdownHeight = 150;
                if (left + dropdownWidth > window.innerWidth) {
                    left = rect.right - dropdownWidth;
                }
                if (top + dropdownHeight > window.innerHeight) {
                    top = rect.top - dropdownHeight - 4;
                }
                
                this.dropdownPosition = { top, left };
            }
        },
        
        closeDropdown() {
            this.showNewDropdown = false;
            this.dropdownTargetFolder = null; // Reset folder context
        },
        
        /**
         * Parent folder for new note/folder from the + menu when no explicit path is passed.
         * Same rules as the create-name modal: '' = vault root; otherwise a folder path (e.g. folder1/sub).
         */
        inferredNewItemTargetFolder() {
            if (this.dropdownTargetFolder !== null && this.dropdownTargetFolder !== undefined) {
                return this.dropdownTargetFolder;
            }
            return this.selectedHomepageFolder || '';
        },
        
        // =====================================================
        // UNIFIED CREATION FUNCTIONS (reusable from anywhere)
        // =====================================================
        
        // Switch to split view (if in preview-only mode) and focus editor for new notes
        focusEditorForNewNote() {
            // Only switch if in preview-only mode - don't disturb edit or split mode
            if (this.viewMode === 'preview') {
                this.viewMode = 'split';
                this.saveViewMode();
            }
            // Focus the editor after a short delay to ensure DOM is updated
            this.$nextTick(() => {
                const editor = document.getElementById('note-editor');
                if (editor) editor.focus();
            });
        },
        
        async createNote(folderPath = null, directPath = null) {
            if (directPath) {
                const notePath = directPath.endsWith('.md') ? directPath : `${directPath}.md`;
                if (this.notePathTaken(notePath)) {
                    this.toast(this.t('notes.already_exists', { name: notePath }), { type: 'warning' });
                    return;
                }
                await this._finalizeCreateNote(notePath);
                return;
            }
            const explicitTarget = folderPath !== null && folderPath !== undefined ? folderPath : undefined;
            this.openCreateNameModal('note', explicitTarget);
        },
        
        /**
         * @param {'note'|'folder'} kind
         * @param {string|undefined} explicitTargetFolder - if set, use as parent folder context ("" = root)
         */
        openCreateNameModal(kind, explicitTargetFolder = undefined) {
            const targetFolder =
                explicitTargetFolder !== undefined ? explicitTargetFolder : this.inferredNewItemTargetFolder();
            this.closeDropdown();
            this.mobileSidebarOpen = false;
            this.createNameModalKind = kind;
            this.createNameModalTargetFolder = targetFolder;
            this.createNameModalInput =
                (kind === 'note' && this.autoFillNoteTitle) ? this._autoTitleTimestamp() : '';
            this.showCreateNameModal = true;
            this.$nextTick(() => {
                const el = document.getElementById('create-name-modal-input');
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },
        
        // Zettelkasten-style yyyymmddHHMMSS in local time.
        _autoTitleTimestamp() {
            const d = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
                   `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        },
        
        closeCreateNameModal() {
            this.showCreateNameModal = false;
            this.createNameModalInput = '';
        },
        
        cancelCreateNameModal() {
            this.closeCreateNameModal();
        },
        
        createNameModalHelpText() {
            const tf = this.createNameModalTargetFolder;
            if (this.createNameModalKind === 'note') {
                return tf
                    ? this.t('notes.prompt_name_in_folder', { folder: tf })
                    : this.t('notes.prompt_name_with_path');
            }
            return tf
                ? this.t('folders.prompt_name_in_folder', { folder: tf })
                : this.t('folders.prompt_name_with_path');
        },
        
        createNameModalTitle() {
            return this.createNameModalKind === 'note'
                ? this.t('sidebar.new_note')
                : this.t('sidebar.new_folder');
        },
        
        createNameModalLabel() {
            return this.createNameModalKind === 'note'
                ? this.t('notes.prompt_name')
                : this.t('folders.prompt_name');
        },
        
        async submitCreateNameModal() {
            const rawName = (this.createNameModalInput || '').trim();
            if (!rawName) {
                this.closeCreateNameModal();
                return;
            }
            const targetFolder = this.createNameModalTargetFolder;
            const kind = this.createNameModalKind;
            
            if (kind === 'note') {
                const validation = targetFolder
                    ? FilenameValidator.validateFilename(rawName)
                    : FilenameValidator.validatePath(rawName);
                if (!validation.valid) {
                    this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                    return;
                }
                const validatedName = validation.sanitized;
                const notePath = targetFolder
                    ? `${targetFolder}/${validatedName}.md`
                    : (validatedName.endsWith('.md') ? validatedName : `${validatedName}.md`);
                if (this.notePathTaken(notePath)) {
                    this.toast(this.t('notes.already_exists', { name: notePath }), { type: 'warning' });
                    return;
                }
                const ok = await this._finalizeCreateNote(notePath);
                if (ok) this.closeCreateNameModal();
                return;
            }
            
            const validation = targetFolder
                ? FilenameValidator.validateFilename(rawName)
                : FilenameValidator.validatePath(rawName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'folder'), { type: 'warning' });
                return;
            }
            const validatedName = validation.sanitized;
            const folderPath = targetFolder ? `${targetFolder}/${validatedName}` : validatedName;
            const existingFolder = this.allFolders.find(folder => folder.toLowerCase() === folderPath.toLowerCase());
            if (existingFolder) {
                this.toast(this.t('folders.already_exists', { name: validatedName }), { type: 'warning' });
                return;
            }
            const ok = await this._finalizeCreateFolder(folderPath, targetFolder);
            if (ok) this.closeCreateNameModal();
        },
        
        async _finalizeCreateNote(notePath) {
            // Optimistic add — sidebar reflects the new note instantly. Server
            // confirms; on failure we resync silently.
            this._optimisticAddNote(notePath, { content: '' });
            const folderPart = notePath.includes('/') ? notePath.substring(0, notePath.lastIndexOf('/')) : '';
            if (folderPart) this.expandedFolders.add(folderPart);
            this._rebuildTreeAfterMutation();
            
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: '' })
                });
                if (!response.ok) throw new Error('Server returned error');
                await this.loadNote(notePath);
                this.focusEditorForNewNote();
                return true;
            } catch (error) {
                ErrorHandler.handle('create note', error);
                await this.loadNotes({ silent: true });
                return false;
            }
        },
        
        async _finalizeCreateFolder(folderPath, targetFolder) {
            this._optimisticAddFolder(folderPath);
            if (targetFolder) this.expandedFolders.add(targetFolder);
            this.expandedFolders.add(folderPath);
            this._rebuildTreeAfterMutation();
            
            try {
                const response = await fetch('/api/folders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: folderPath })
                });
                if (!response.ok) throw new Error('Server returned error');
                this.goToHomepageFolder(folderPath);
                return true;
            } catch (error) {
                ErrorHandler.handle('create folder', error);
                await this.loadNotes({ silent: true });
                return false;
            }
        },
        
        async createFolder(parentPath = null) {
            const explicitTarget = parentPath !== null && parentPath !== undefined ? parentPath : undefined;
            this.openCreateNameModal('folder', explicitTarget);
        },
        
        renameFolder(folderPath, currentName) {
            this.renameFolderPath = folderPath;
            this.renameFolderOldName = currentName;
            this.renameFolderInput = currentName;
            this.showRenameFolderModal = true;
            this.mobileSidebarOpen = false;
            this.$nextTick(() => {
                const el = document.getElementById('rename-folder-modal-input');
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },
        
        closeRenameFolderModal() {
            this.showRenameFolderModal = false;
            this.renameFolderPath = '';
            this.renameFolderOldName = '';
            this.renameFolderInput = '';
        },
        
        cancelRenameFolderModal() {
            this.closeRenameFolderModal();
        },
        
        /**
         * Theme-styled confirm dialog (replaces window.confirm).
         * @param {{ message: string, title?: string, danger?: boolean, confirmLabel?: string, cancelLabel?: string }} options
         * @returns {Promise<boolean>}
         */
        confirmModalAsk(options = {}) {
            const { message, title, danger = true, confirmLabel, cancelLabel } = options;
            return new Promise((resolve) => {
                this.confirmModalTitle = title || this.t('common.confirm_title');
                this.confirmModalMessage = message || '';
                this.confirmModalDanger = danger;
                this.confirmModalConfirmLabel = confirmLabel
                    || (danger ? this.t('common.delete') : this.t('common.ok'));
                this.confirmModalCancelLabel = cancelLabel || this.t('common.cancel');
                this._confirmModalResolve = resolve;
                this.showConfirmModal = true;
                this.mobileSidebarOpen = false;
            });
        },
        
        confirmModalConfirm() {
            this._confirmModalFinish(true);
        },
        
        confirmModalCancel() {
            this._confirmModalFinish(false);
        },
        
        _confirmModalFinish(ok) {
            if (!this._confirmModalResolve) return;
            this.showConfirmModal = false;
            const fn = this._confirmModalResolve;
            this._confirmModalResolve = null;
            fn(!!ok);
        },
        
        async submitRenameFolderModal() {
            const folderPath = this.renameFolderPath;
            const currentName = this.renameFolderOldName;
            const newName = (this.renameFolderInput || '').trim();
            if (!newName || newName === currentName) {
                this.closeRenameFolderModal();
                return;
            }
            
            const validation = FilenameValidator.validateFilename(newName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'folder'), { type: 'warning' });
                return;
            }
            
            const validatedName = validation.sanitized;
            const pathParts = folderPath.split('/');
            pathParts[pathParts.length - 1] = validatedName;
            const newPath = pathParts.join('/');
            if (newPath !== folderPath && this.folderPathTaken(newPath)) {
                this.toast(this.t('folders.already_exists', { name: validatedName }), { type: 'warning' });
                return;
            }
            
            const ok = await this._finalizeRenameFolder(folderPath, newPath);
            if (ok) this.closeRenameFolderModal();
        },
        
        async _finalizeRenameFolder(folderPath, newPath) {
            const folderPrefix = folderPath + '/';
            const newFolderPrefix = newPath + '/';
            
            // Optimistic cascade: rewrite folder + every nested folder + every
            // note path. Sidebar reflects the rename instantly.
            this._optimisticRenameFolderTree(folderPath, newPath);
            this._rebuildTreeAfterMutation();
            
            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath);
                this.expandedFolders.add(newPath);
            }
            const newFavorites = this.favorites.map(f =>
                f.startsWith(folderPrefix) ? newFolderPrefix + f.substring(folderPrefix.length) : f
            );
            if (JSON.stringify(newFavorites) !== JSON.stringify(this.favorites)) {
                this.favorites = newFavorites;
                this.favoritesSet = new Set(newFavorites);
                this.saveFavorites();
            }
            if (this.currentNote && this.currentNote.startsWith(folderPrefix)) {
                this.currentNote = newFolderPrefix + this.currentNote.substring(folderPrefix.length);
            }
            
            try {
                const response = await fetch('/api/folders/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldPath: folderPath, newPath: newPath })
                });
                if (!response.ok) throw new Error('Server returned error');
                return true;
            } catch (error) {
                ErrorHandler.handle('rename folder', error);
                await this.loadNotes({ silent: true });
                return false;
            }
        },
        
        // Delete folder (cascade: every nested folder + note)
        async deleteFolder(folderPath, folderName) {
            const ok = await this.confirmModalAsk({
                message: this.t('folders.confirm_delete', { name: folderName }),
            });
            if (!ok) return;
            
            const folderPrefix = folderPath + '/';
            
            this._optimisticRemoveFolderTree(folderPath);
            this._rebuildTreeAfterMutation();
            
            this.expandedFolders.delete(folderPath);
            const newFavorites = this.favorites.filter(f => !f.startsWith(folderPrefix));
            if (newFavorites.length !== this.favorites.length) {
                this.favorites = newFavorites;
                this.favoritesSet = new Set(newFavorites);
                this.saveFavorites();
            }
            if (this.currentNote && this.currentNote.startsWith(folderPrefix)) {
                this.currentNote = '';
                this.noteContent = '';
                document.title = this.appName;
            }
            
            try {
                const response = await fetch(`/api/folders/${encodeURIComponent(folderPath)}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!response.ok) throw new Error('Server returned error');
                this.loadTagsDebounced();
            } catch (error) {
                ErrorHandler.handle('delete folder', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        // Auto-save with debounce
        autoSave() {
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
            }
            
            this.lastSaved = false;
            
            // Push to undo history (but not during undo/redo operations)
            if (!this.isUndoRedo) {
                this.pushToHistory();
            }
            
            // Outline and metadata panels refresh from the save response
            // (server-side parsing), see saveNote().
            
            this.saveTimeout = setTimeout(() => {
                // Commit to undo history when autosave triggers (same debounce timing)
                if (this.hasPendingHistoryChanges) {
                    this.commitToHistory();
                }
                this.saveNote();
            }, this.autosaveDelayMs);
        },
        
        // Mark that we have pending changes (called on each keystroke)
        pushToHistory() {
            this.hasPendingHistoryChanges = true;
        },
        
        // Immediately commit pending changes to history (call before undo/redo)
        flushHistory() {
            if (this.hasPendingHistoryChanges) {
                this.commitToHistory();
            }
        },
        
        // Actually commit to undo history (internal)
        commitToHistory() {
            const editor = document.getElementById('note-editor');
            const cursorPos = editor ? editor.selectionStart : 0;
            
            // Only push if content actually changed from last history entry
            if (this.undoHistory.length > 0 && 
                this.undoHistory[this.undoHistory.length - 1].content === this.noteContent) {
                this.hasPendingHistoryChanges = false;
                return;
            }
            
            this.undoHistory.push({ content: this.noteContent, cursorPos });
            
            // Limit history size
            if (this.undoHistory.length > this.maxHistorySize) {
                this.undoHistory.shift();
            }
            
            // Clear redo history when new change is made
            this.redoHistory = [];
            this.hasPendingHistoryChanges = false;
        },
        
        // Undo last change
        undo() {
            if (!this.currentNote) return;
            
            // Flush any pending history changes first (so we don't lose unsaved edits)
            this.flushHistory();
            
            if (this.undoHistory.length <= 1) return;
            
            const editor = document.getElementById('note-editor');
            
            // Pop current state to redo history
            const currentState = this.undoHistory.pop();
            this.redoHistory.push(currentState);
            
            // Get previous state
            const previousState = this.undoHistory[this.undoHistory.length - 1];
            
            // Apply previous state
            this.isUndoRedo = true;
            this.noteContent = previousState.content;
            
            // Restore cursor position from the state we're going back to
            this.$nextTick(() => {
                this.saveNote();
                this.isUndoRedo = false;
                if (editor) {
                    setTimeout(() => {
                        const newPos = Math.min(previousState.cursorPos, this.noteContent.length);
                        editor.setSelectionRange(newPos, newPos);
                        editor.focus();
                    }, 0);
                }
            });
        },
        
        // Redo last undone change
        redo() {
            if (!this.currentNote) return;
            
            // Flush any pending history changes first
            this.flushHistory();
            
            if (this.redoHistory.length === 0) return;
            
            const editor = document.getElementById('note-editor');
            
            // Pop from redo history
            const nextState = this.redoHistory.pop();
            
            // Push to undo history
            this.undoHistory.push(nextState);
            
            // Apply next state
            this.isUndoRedo = true;
            this.noteContent = nextState.content;
            
            // Restore cursor position from the state we're going forward to
            this.$nextTick(() => {
                this.saveNote();
                this.isUndoRedo = false;
                if (editor) {
                    setTimeout(() => {
                        const newPos = Math.min(nextState.cursorPos, this.noteContent.length);
                        editor.setSelectionRange(newPos, newPos);
                        editor.focus();
                    }, 0);
                }
            });
        },
        
        // Markdown formatting helpers
        // Trim trailing whitespace from double-click word selections.
        // No-op on browsers that already exclude it (Firefox, Safari).
        trimSelectionTrailingSpace(event) {
            const editor = event && event.target;
            if (!editor) return;
            const start = editor.selectionStart;
            let end = editor.selectionEnd;
            if (start >= end) return;
            const text = editor.value;
            while (end > start && /\s/.test(text.charAt(end - 1))) end--;
            if (end !== editor.selectionEnd) {
                editor.setSelectionRange(start, end);
            }
        },

        wrapSelection(before, after, placeholder) {
            const editor = document.getElementById('note-editor');
            if (!editor) return;
            
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const selectedText = this.noteContent.substring(start, end);

            // Push edge whitespace OUTSIDE inline wrappers — "**house **" is
            // invalid per CommonMark. Block wrappers (with \n) keep it intact.
            const isInline = !before.includes('\n') && !after.includes('\n');
            let leading = '', trailing = '', core = selectedText;
            if (isInline && selectedText) {
                const m = selectedText.match(/^(\s*)([\s\S]*?)(\s*)$/);
                leading = m[1];
                core = m[2];
                trailing = m[3];
            }
            const textToWrap = core || placeholder;
            
            // Build the new text
            const newText = leading + before + textToWrap + after + trailing;
            
            // Update content
            this.noteContent = this.noteContent.substring(0, start) + newText + this.noteContent.substring(end);
            
            this.$nextTick(() => {
                const coreStart = start + leading.length + before.length;
                const coreEnd = coreStart + textToWrap.length;
                editor.setSelectionRange(coreStart, coreEnd);
                editor.focus();
            });
            
            // Trigger autosave
            this.autoSave();
        },
        
        insertLink() {
            const editor = document.getElementById('note-editor');
            if (!editor) return;
            
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const selectedText = this.noteContent.substring(start, end);
            
            // If text is selected, use it as link text; otherwise use placeholder
            const linkText = selectedText || 'link text';
            const linkUrl = 'url';
            
            // Build the markdown link
            const newText = `[${linkText}](${linkUrl})`;
            
            // Update content
            this.noteContent = this.noteContent.substring(0, start) + newText + this.noteContent.substring(end);
            
            // Set cursor position to select the URL part for easy editing
            this.$nextTick(() => {
                const urlStart = start + linkText.length + 3; // After "[linkText]("
                const urlEnd = urlStart + linkUrl.length;
                editor.setSelectionRange(urlStart, urlEnd);
                editor.focus();
            });
            
            // Trigger autosave
            this.autoSave();
        },
        
        // Insert a markdown table placeholder
        insertTable() {
            const editor = document.getElementById('note-editor');
            if (!editor) return;
            
            const cursorPos = editor.selectionStart;
            
            // Basic 3x3 table placeholder
            const table = `| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |
`;
            
            // Add newline before if not at start of line
            const textBefore = this.noteContent.substring(0, cursorPos);
            const needsNewlineBefore = textBefore.length > 0 && !textBefore.endsWith('\n');
            const prefix = needsNewlineBefore ? '\n\n' : '';
            
            // Insert the table
            this.noteContent = textBefore + prefix + table + this.noteContent.substring(cursorPos);
            
            // Position cursor at first header for easy editing
            this.$nextTick(() => {
                const newPos = cursorPos + prefix.length + 2; // After "| "
                editor.setSelectionRange(newPos, newPos + 8); // Select "Header 1"
                editor.focus();
            });
            
            // Trigger autosave
            this.autoSave();
        },
        
        // Format selected text or insert formatting at cursor
        formatText(type) {
            // Simple wrap cases - reuse wrapSelection()
            const wrapFormats = {
                'bold': ['**', '**', 'bold'],
                'italic': ['*', '*', 'italic'],
                'strikethrough': ['~~', '~~', 'strikethrough'],
                'code': ['`', '`', 'code']
            };
            
            if (wrapFormats[type]) {
                const [before, after, placeholder] = wrapFormats[type];
                this.wrapSelection(before, after, placeholder);
                return;
            }
            
            // Special cases that need custom handling
            switch (type) {
                case 'heading':
                    this.insertLinePrefix('## ', 'Heading');
                    break;
                case 'quote':
                    this.insertLinePrefix('> ', 'quote');
                    break;
                case 'bullet':
                    this.insertLinePrefix('- ', 'item');
                    break;
                case 'numbered':
                    this.insertLinePrefix('1. ', 'item');
                    break;
                case 'checkbox':
                    this.insertLinePrefix('- [ ] ', 'task');
                    break;
                case 'link':
                    this.insertLink();
                    break;
                case 'image':
                    this.wrapSelection('![', '](image-url)', 'alt text');
                    break;
                case 'codeblock':
                    this.wrapSelection('```\n', '\n```', 'code');
                    break;
                case 'table':
                    this.insertTable();
                    break;
            }
        },
        
        // Insert a line prefix (for headings, lists, quotes)
        insertLinePrefix(prefix, placeholder) {
            const editor = document.getElementById('note-editor');
            if (!editor) return;
            
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const selectedText = this.noteContent.substring(start, end);
            const beforeText = this.noteContent.substring(0, start);
            const afterText = this.noteContent.substring(end);
            
            // Check if at start of line
            const atLineStart = beforeText.endsWith('\n') || beforeText === '';
            const newline = atLineStart ? '' : '\n';
            
            let replacement;
            if (selectedText) {
                // Prefix each line of selection
                replacement = newline + selectedText.split('\n').map((line, i) => {
                    // For numbered lists, increment the number
                    if (prefix === '1. ') return `${i + 1}. ${line}`;
                    return prefix + line;
                }).join('\n');
            } else {
                replacement = newline + prefix + placeholder;
            }
            
            this.noteContent = beforeText + replacement + afterText;
            
            this.$nextTick(() => {
                if (selectedText) {
                    editor.setSelectionRange(start + newline.length, start + replacement.length);
                } else {
                    const placeholderStart = start + newline.length + prefix.length;
                    editor.setSelectionRange(placeholderStart, placeholderStart + placeholder.length);
                }
                editor.focus();
            });
            
            this.autoSave();
        },
        
        // Save current note
        async saveNote() {
            if (!this.currentNote) return;
            // The "changed elsewhere" prompt is open: nothing is written until the user chooses.
            if (this._saveConflictOpen) return;
            // One save at a time. A second request sent before the first returns would
            // carry a stale base_hash and trip the conflict check against our own write.
            if (this.isSaving) {
                this._saveQueued = true;
                return;
            }

            this.isSaving = true;
            const notePath = this.currentNote;

            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // base_hash lets the server refuse (409) a write over a file that
                    // changed on disk since we read it.
                    body: JSON.stringify({ content: this.noteContent, base_hash: this.noteBaseHash })
                });

                if (response.status === 409) {
                    const detail = await response.json();
                    if (notePath !== this.currentNote) {
                        // The user already moved to another note: its base hash is not ours to touch.
                        const name = notePath.split('/').pop().replace('.md', '');
                        this.toast(this.t('notes.save_conflict_unsaved', { name }), { type: 'warning' });
                        return;
                    }
                    // Nothing is in flight while the user decides.
                    this.isSaving = false;
                    if (await this._askSaveConflict(notePath)) {
                        // Overwrite: take the disk version as the base, re-send ours.
                        this.noteBaseHash = detail.hash || null;
                        this._saveQueued = true;
                    } else {
                        // Reload: drop the pending autosave and show the version on disk.
                        if (this.saveTimeout) {
                            clearTimeout(this.saveTimeout);
                            this.saveTimeout = null;
                        }
                        this._saveQueued = false;
                        await this.loadNote(notePath, false);
                    }
                    return;
                }

                if (response.ok) {
                    const result = await response.json();
                    // A hover preview for this note would otherwise show the
                    // version from before this save for up to its cache TTL.
                    if (this._linkPreviewCache) this._linkPreviewCache.delete(notePath);
                    if (notePath === this.currentNote) {
                        this.noteBaseHash = result.hash || null;
                        // Refresh TOC and metadata panels from the server-parsed save response
                        this.outline = result.outline || [];
                        this.noteMetadata = result.frontmatter || null;
                    }
                    this.lastSaved = true;
                    
                    // Update only the modified timestamp for the current note (no full reload needed)
                    const note = this.notes.find(n => n.path === this.currentNote);
                    if (note) {
                        note.modified = new Date().toISOString();
                        note.size = new Blob([this.noteContent]).size;
                        
                        note.tags = result.tags || [];
                    }
                    
                    // Reload tags to update sidebar counts (debounced to prevent spam)
                    this.loadTagsDebounced();
                    
                    // Rebuild folder tree if tag filters are active
                    if (this.selectedTags.length > 0) {
                        this.buildFolderTree();
                    }
                    
                    // Hide "saved" indicator
                    setTimeout(() => {
                        this.lastSaved = false;
                    }, CONFIG.SAVE_INDICATOR_DURATION);
                } else {
                    ErrorHandler.handle('save note', new Error('Server returned error'));
                }
            } catch (error) {
                ErrorHandler.handle('save note', error);
            } finally {
                this.isSaving = false;
                if (this._saveQueued) {
                    this._saveQueued = false;
                    this.saveNote();
                }
            }
        },

        // Ask what to do when the server refused a save because the file changed on disk.
        // Resolves true to overwrite. Escape, a click outside or "Reload" keep the disk version.
        async _askSaveConflict(notePath) {
            this._saveConflictOpen = true;
            try {
                const name = notePath.split('/').pop().replace('.md', '');
                return await this.confirmModalAsk({
                    title: this.t('notes.save_conflict_title'),
                    message: this.t('notes.save_conflict_message', { name }),
                    danger: true,
                    confirmLabel: this.t('notes.save_conflict_overwrite'),
                    cancelLabel: this.t('notes.save_conflict_reload')
                });
            } finally {
                this._saveConflictOpen = false;
            }
        },

        // Rename current note
        async renameNote() {
            if (!this.currentNote) return;
            
            const oldPath = this.currentNote;
            const newName = this.currentNoteName.trim();
            
            if (!newName) {
                this.toast(this.t('notes.empty_name'), { type: 'warning' });
                return;
            }
            
            // Validate the new name (single segment, no path separators)
            const validation = FilenameValidator.validateFilename(newName);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                // Reset the name in the UI
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
                return;
            }
            
            const validatedName = validation.sanitized;
            const folder = oldPath.split('/').slice(0, -1).join('/');
            const newPath = folder ? `${folder}/${validatedName}.md` : `${validatedName}.md`;
            
            if (oldPath === newPath) return;
            
            // Check if a note with the new name already exists
            const existingNote = this.notePathTaken(newPath) ? { path: newPath } : null;
            if (existingNote) {
                this.toast(this.t('notes.already_exists', { name: validatedName }), { type: 'warning' });
                // Reset the name in the UI
                this.currentNoteName = oldPath.split('/').pop().replace('.md', '');
                return;
            }
            
            // Optimistic rename: rewrite local path now + favorites + current
            // note pointer. The file itself moves through /api/notes/move.
            this._optimisticRenameNote(oldPath, newPath);
            this._rebuildTreeAfterMutation();
            
            if (this.favoritesSet.has(oldPath)) {
                this.favorites = this.favorites.map(f => f === oldPath ? newPath : f);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            this.currentNote = newPath;

            // A pending autosave targets currentNote, which is already the new
            // path. Let it fire and it would create the destination before the
            // move, and the move would refuse to overwrite that file.
            this.flushHistory();
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
            
            try {
                const response = await fetch('/api/notes/move', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ oldPath, newPath })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.detail || 'Server returned error');
                }
                // The moved file has the last saved copy. Write the editor
                // buffer too, so a rename before autosave does not drop keystrokes.
                const saveResponse = await fetch(`/api/notes/${encodeVaultPath(newPath)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: this.noteContent, base_hash: this.noteBaseHash })
                });
                if (saveResponse.status === 409) {
                    // Changed elsewhere before the rename: the regular save asks what to do.
                    this.saveNote();
                } else if (!saveResponse.ok) {
                    throw new Error('Server returned error');
                } else if (newPath === this.currentNote) {
                    // Our own write: it is the base for the next save.
                    const saved = await saveResponse.json();
                    this.noteBaseHash = saved.hash || null;
                }
            } catch (error) {
                ErrorHandler.handle('rename note', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        // Delete current note
        async deleteCurrentNote() {
            if (!this.currentNote) return;
            
            // Just call deleteNote with current note details
            await this.deleteNote(this.currentNote, this.currentNoteName);
        },
        
        // Delete any note from sidebar
        async deleteNote(notePath, noteName) {
            const ok = await this.confirmModalAsk({
                message: this.t('notes.confirm_delete', { name: noteName }),
            });
            if (!ok) return;
            
            // Optimistic: remove locally + clear current note + drop favorite
            // before the network round-trip. Sidebar refreshes in <1ms on any
            // vault size. On error we resync silently from disk.
            this._optimisticRemoveNote(notePath);
            this._rebuildTreeAfterMutation();
            
            if (this.favoritesSet.has(notePath)) {
                this.favorites = this.favorites.filter(f => f !== notePath);
                this.favoritesSet = new Set(this.favorites);
                this.saveFavorites();
            }
            
            if (this.currentNote === notePath) {
                this.currentNote = '';
                this.noteContent = '';
                this.currentNoteName = '';
                this._lastRenderedContent = '';
                this._lastRenderedNote = '';
                this._cachedRenderedHTML = '';
                document.title = this.appName;
                window.history.replaceState({}, '', '/');
            }
            
            try {
                const response = await fetch(`/api/notes/${encodeVaultPath(notePath)}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Server returned error');
                this.loadTagsDebounced();
            } catch (error) {
                ErrorHandler.handle('delete note', error);
                await this.loadNotes({ silent: true });
            }
        },
        
        // Search notes
        // Whether the query is worth sending. A single character matches most of
        // a vault and can't use the search index, so it reads every note to
        // answer something nobody wants — the sidebar shows its hint instead.
        isSearchable() {
            return this.searchQuery.trim().length >= CONFIG.SEARCH_MIN_QUERY_LENGTH;
        },

        debouncedSearchNotes() {
            if (this.searchDebounceTimeout) {
                clearTimeout(this.searchDebounceTimeout);
            }

            const hasTextSearch = this.isSearchable();
            if (!hasTextSearch) {
                this.isSearching = false;
                this.searchNotes();
                return;
            }

            this.isSearching = true;
            this.searchResults = [];

            this.searchDebounceTimeout = setTimeout(() => {
                this.searchNotes();
            }, CONFIG.SEARCH_DEBOUNCE_DELAY);
        },

        // Search notes by text (calls unified filter logic)
        async searchNotes() {
            await this.applyFilters();
        },

        // Collapsible search result groups. Keeping the state in a plain object
        // (path -> bool) lets the sidebar show only note headers until the user
        // asks for the individual occurrences.
        toggleSearchResult(path) {
            this.expandedSearchResults = {
                ...this.expandedSearchResults,
                [path]: !this.expandedSearchResults[path],
            };
        },

        isSearchResultExpanded(path) {
            return !!this.expandedSearchResults[path];
        },

        expandAllSearchResults() {
            const expanded = {};
            for (const result of this.searchResults) {
                expanded[result.path] = true;
            }
            this.expandedSearchResults = expanded;
        },

        collapseAllSearchResults() {
            this.expandedSearchResults = {};
        },

        // Open a note at the exact occurrence the user clicked.
        openSearchMatch(path, match, query) {
            const line = match && match.line_number ? match.line_number : null;
            // The column pins the occurrence when one line holds several of
            // them; without it the first match on the line would be picked.
            const column = match && match.column ? match.column : null;
            this.openItem(path, 'note', query, line, column);
        },
        
        // Trigger MathJax typesetting after DOM update.
        // MathJax's combined build (~1 MB) is fetched on the first note that
        // actually contains math — mirrors the lazy loadMermaid() pattern.
        typesetMath() {
            if (typeof MathJax === 'undefined') {
                if (!this._mathLoadPromise) {
                    if (!this._noteHasMath()) return; // most notes have no math
                    this._mathLoadPromise = new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        // Fonts and TeX extensions resolve relative to this URL.
                        s.src = '/static/vendor/mathjax/tex-mml-chtml.js';
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    });
                    this._mathLoadPromise.catch(() => {
                        this._mathLoadPromise = null; // let the next note retry
                    });
                }
                this._mathLoadPromise.then(() => {
                    if (typeof MathJax !== 'undefined') this.typesetMath();
                }).catch(() => {});
                return;
            }
            if (MathJax.typesetPromise) {
                // Use a small delay to ensure DOM is updated
                setTimeout(() => {
                    const previewContent = document.querySelector('.markdown-preview');
                    if (previewContent) {
                        MathJax.typesetPromise([previewContent]).catch((err) => {
                            console.error('MathJax typesetting failed:', err);
                        });
                    }
                }, 10);
            }
        },

        // Whether the note source plausibly contains TeX math delimiters.
        // False positives (e.g. "$5 or $10" spanning a line) only cost an
        // unnecessary library load; false negatives just skip typesetting a
        // note whose delimiters would not have matched the config anyway.
        _noteHasMath() {
            return /\$\$|\\\(|\\\[|\$[^$\n]+\$/.test(this.noteContent || '');
        },
        
        /**
         * Mermaid's core is ~650 KB across two dozen chunks, so it is fetched on first
         * use rather than at page load: most notes contain no diagrams. Diagram types
         * then load on demand from ./chunks/ next to the module.
         */
        loadMermaid() {
            if (!window.mermaidReady) {
                window.mermaidReady = import('/static/vendor/mermaid/mermaid.esm.min.mjs')
                    .then((module) => (window.mermaid = module.default))
                    .catch((error) => {
                        console.error('Mermaid failed to load:', error);
                        window.mermaidReady = null; // let the next diagram retry
                        return null;
                    });
            }
            return window.mermaidReady;
        },
        
        // Render Mermaid diagrams
        async renderMermaid() {
            // Use requestAnimationFrame for better performance than setTimeout
            requestAnimationFrame(async () => {
                const previewContent = document.querySelector('.markdown-preview');
                if (!previewContent) return;
                
                // Find all code blocks with language 'mermaid'
                const mermaidBlocks = previewContent.querySelectorAll('pre code.language-mermaid');
                
                // Early return if no diagrams to render, before paying for the library
                if (mermaidBlocks.length === 0) return;
                
                if (!(await this.loadMermaid())) return;
                
                // Get the appropriate theme based on current app theme
                const themeType = this.getThemeType();
                const mermaidTheme = themeType === 'light' ? 'default' : 'dark';
                
                // Only reinitialize if theme changed (performance optimization)
                if (this.lastMermaidTheme !== mermaidTheme) {
                    window.mermaid.initialize({ 
                        startOnLoad: false,
                        theme: mermaidTheme,
                        securityLevel: 'strict', // Use strict for better security
                        fontFamily: 'inherit',
                        // v11 changed useMaxWidth defaults - restore responsive behavior
                        flowchart: { useMaxWidth: true },
                        sequence: { useMaxWidth: true },
                        gantt: { useMaxWidth: true },
                        journey: { useMaxWidth: true },
                        timeline: { useMaxWidth: true },
                        class: { useMaxWidth: true },
                        state: { useMaxWidth: true },
                        er: { useMaxWidth: true },
                        pie: { useMaxWidth: true },
                        quadrantChart: { useMaxWidth: true },
                        requirement: { useMaxWidth: true },
                        mindmap: { useMaxWidth: true },
                        gitGraph: { useMaxWidth: true }
                    });
                    this.lastMermaidTheme = mermaidTheme;
                }
                
                for (let i = 0; i < mermaidBlocks.length; i++) {
                    const block = mermaidBlocks[i];
                    const pre = block.parentElement;
                    
                    // Skip if already rendered (performance optimization)
                    if (pre.querySelector('.mermaid-rendered')) continue;
                    
                    try {
                        const code = block.textContent;
                        const id = `mermaid-diagram-${Date.now()}-${i}`;
                        
                        // Render the diagram
                        const { svg } = await window.mermaid.render(id, code);
                        
                        // Create a container for the rendered diagram
                        const container = document.createElement('div');
                        container.className = 'mermaid-rendered';
                        container.style.cssText = 'background-color: transparent; padding: 20px 0; width: 100%; text-align: center; overflow-x: auto;';
                        container.innerHTML = svg;
                        // Store original code for theme re-rendering
                        container.dataset.originalCode = code;
                        // Preserve scroll-sync anchor if the code block was tagged
                        // by _annotateSourceAnchors. Without this the rendered
                        // diagram becomes invisible to _getScrollAnchors and any
                        // fence landmarks that got replaced disappear.
                        const anchorLine = pre.getAttribute('data-source-line');
                        if (anchorLine) container.setAttribute('data-source-line', anchorLine);
                        
                        // Replace the code block with the rendered diagram
                        pre.parentElement.replaceChild(container, pre);
                    } catch (error) {
                        console.error('Mermaid rendering error:', error);
                        // Add error indicator to the code block
                        const errorMsg = document.createElement('div');
                        errorMsg.style.cssText = 'color: var(--error); padding: 10px; border-left: 3px solid var(--error); margin-top: 10px;';
                        errorMsg.textContent = `⚠️ Mermaid diagram error: ${error.message}`;
                        pre.parentElement.insertBefore(errorMsg, pre.nextSibling);
                    }
                }
            });
        },
        
        // Get current theme type (light or dark)
        // Returns: 'light' or 'dark'
        // Used by features that need to adapt to theme brightness (e.g., Mermaid diagrams, Chart.js)
        getThemeType() {
            // Handle system theme
            if (this.currentTheme === 'system') {
                const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                return isDark ? 'dark' : 'light';
            }
            
            // Try to get theme type from loaded theme metadata
            const currentThemeData = this.availableThemes.find(t => t.id === this.currentTheme);
            if (currentThemeData && currentThemeData.type) {
                // Use metadata from theme file (light or dark)
                return currentThemeData.type; // Already 'light' or 'dark'
            }
            
            // Backward compatibility: fallback to hardcoded map if metadata not available
            const fallbackMap = {
                'light': 'light',
                'vs-blue': 'light'
            };
            
            return fallbackMap[this.currentTheme] || 'dark';
        },
        
        
        // Computed property for rendered markdown
        get renderedMarkdown() {
            if (!this.noteContent) return '<p style="color: var(--text-tertiary);">Nothing to preview yet...</p>';
            
            // Performance: Return cached HTML if content hasn't changed
            if (this.noteContent === this._lastRenderedContent &&
                this.currentNote === this._lastRenderedNote &&
                this._cachedRenderedHTML) {
                return this._cachedRenderedHTML;
            }
            
            // Strip YAML frontmatter from content before rendering
            let contentToRender = this.noteContent;
            if (contentToRender.trim().startsWith('---')) {
                const lines = contentToRender.split('\n');
                if (lines[0].trim() === '---') {
                    // Find closing ---
                    let endIdx = -1;
                    for (let i = 1; i < lines.length; i++) {
                        if (lines[i].trim() === '---') {
                            endIdx = i;
                            break;
                        }
                    }
                    if (endIdx !== -1) {
                        // Remove frontmatter (including the closing ---) and any empty lines after it
                        contentToRender = lines.slice(endIdx + 1).join('\n').trim();
                    }
                }
            }
            
            // Convert Obsidian-style wikilinks: [[note]] or [[note|display text]]
            // Must be done before marked.parse() to avoid conflicts with markdown syntax
            // BUT we need to protect code blocks first to avoid converting [[text]] inside code
            const self = this; // Reference for closure

            // Parses an Obsidian-style inline image size spec from an alt-like string.
            // Returns { alt, width, height } — width/height are null when not specified.
            //
            //   parseImageSizeSpec("caption")            -> {alt:"caption",  w:null, h:null}
            //   parseImageSizeSpec("caption|100")        -> {alt:"caption",  w:100,  h:null}
            //   parseImageSizeSpec("caption|100x200")    -> {alt:"caption",  w:100,  h:200}
            //   parseImageSizeSpec("100", {allowSolo})   -> {alt:"",         w:100,  h:null}   (wikilink only)
            //   parseImageSizeSpec("100x200",{allowSolo})-> {alt:"",         w:100,  h:200}    (wikilink only)
            //
            // A dimension of 0 is treated as "unset" (Obsidian convention: |0x200 = height only).
            // allowSolo=true accepts a bare `<digits>` string as a size; used for wikilinks
            // where `![[img|100]]` unambiguously means "size 100" (no alt to confuse). For
            // standard markdown `![100](x)` we default allowSolo=false so "100" stays as alt.
            const parseImageSizeSpec = (text, opts = {}) => {
                const allowSolo = opts.allowSolo === true;
                if (!text) return { alt: '', width: null, height: null };
                const trimmed = text.trim();
                if (allowSolo) {
                    const solo = trimmed.match(/^(\d+)(?:[xX](\d+))?$/);
                    if (solo) {
                        const w = parseInt(solo[1], 10);
                        const h = solo[2] !== undefined ? parseInt(solo[2], 10) : null;
                        return {
                            alt: '',
                            width: w > 0 ? w : null,
                            height: (h !== null && h > 0) ? h : null,
                        };
                    }
                }
                const idx = trimmed.lastIndexOf('|');
                if (idx === -1) return { alt: trimmed, width: null, height: null };
                const size = trimmed.slice(idx + 1).trim();
                const m = size.match(/^(\d+)(?:[xX](\d+))?$/);
                if (!m) return { alt: trimmed, width: null, height: null };
                const w = parseInt(m[1], 10);
                const h = m[2] !== undefined ? parseInt(m[2], 10) : null;
                return {
                    alt: trimmed.slice(0, idx).trim(),
                    width: w > 0 ? w : null,
                    height: (h !== null && h > 0) ? h : null,
                };
            };

            // Step 0: GFM/GLFM callouts. Runs BEFORE code-block extraction so
            // fences nested in a callout blockquote lose their `> ` prefix on
            // the closer — otherwise CommonMark won't see a valid fence closer
            // once restored inside <div class="callout-body"> and the block
            // runs unclosed. Fence-aware so `> [!TIP]` literal inside a
            // top-level code block is not misread as a callout.
            {
                const CALLOUT_RE = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;
                const CALLOUT_ICONS = { note: 'ℹ️', tip: '💡', important: '❗', warning: '⚠️', caution: '🛑' };
                const CALLOUT_TITLES = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
                // Fence opener at 0-3 spaces indent (CommonMark). Captured
                // group holds the fence chars so the closer must match char + length.
                const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
                const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

                const srcLines = contentToRender.split('\n');
                const outLines = [];
                let li = 0;
                let fenceChar = null; // '`' or '~' when inside a top-level fence
                let fenceLen = 0;
                while (li < srcLines.length) {
                    const line = srcLines[li];

                    // Inside a top-level fence: pass through opaquely.
                    if (fenceChar) {
                        outLines.push(line);
                        const closeRe = new RegExp('^\\s{0,3}' + (fenceChar === '`' ? '`' : '~') + '{' + fenceLen + ',}\\s*$');
                        if (closeRe.test(line)) { fenceChar = null; fenceLen = 0; }
                        li++;
                        continue;
                    }

                    const fenceOpen = line.match(FENCE_OPEN_RE);
                    if (fenceOpen) {
                        fenceChar = fenceOpen[1][0];
                        fenceLen = fenceOpen[1].length;
                        outLines.push(line);
                        li++;
                        continue;
                    }

                    const m = line.match(CALLOUT_RE);
                    if (!m) {
                        outLines.push(line);
                        li++;
                        continue;
                    }
                    const type = m[1].toLowerCase();
                    const title = escapeAttr((m[2] || '').trim() || CALLOUT_TITLES[type]);
                    const icon = CALLOUT_ICONS[type];
                    const bodyLines = [];
                    li++;
                    // Fence lines inside the callout also start with `>`, so
                    // they get absorbed and stripped, leaving a clean fence.
                    while (li < srcLines.length && srcLines[li].startsWith('>')) {
                        bodyLines.push(srcLines[li].replace(/^>\s?/, ''));
                        li++;
                    }
                    outLines.push(
                        '',
                        `<div class="callout callout-${type}">`,
                        `<div class="callout-title"><span class="callout-icon" aria-hidden="true">${icon}</span><span class="callout-title-text">${title}</span></div>`,
                        `<div class="callout-body">`,
                        '',
                        bodyLines.join('\n'),
                        '',
                        `</div>`,
                        `</div>`,
                        ''
                    );
                }
                contentToRender = outLines.join('\n');
            }

            // Step 1: Temporarily replace code blocks and inline code with placeholders
            const codeBlocks = [];
            // Protect fenced code blocks (```...```)
            contentToRender = contentToRender.replace(/```[\s\S]*?```/g, (match) => {
                codeBlocks.push(match);
                return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
            });
            // Protect inline code (`...`)
            contentToRender = contentToRender.replace(/`[^`]+`/g, (match) => {
                codeBlocks.push(match);
                return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
            });
            
            // Step 2: Convert media wikilinks FIRST: ![[file.png]] or ![[file.png|alt text]]
            // Must be before note wikilinks to prevent [[file.png]] from being matched first
            //
            // Also supports Obsidian-style inline sizing:
            //   ![[img.jpg|100]]            -> width 100
            //   ![[img.jpg|100x200]]        -> width 100, height 200
            //   ![[img.jpg|caption|100]]    -> alt "caption", width 100
            // The `allowSolo:true` mode treats a bare `|<digits>` group as a size
            // (Obsidian's wikilink convention). Standard markdown images require a
            // pipe inside the alt text and are handled by the DOM walker below.
            contentToRender = contentToRender.replace(
                /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
                (match, mediaName, altText) => {
                    const filename = mediaName.trim();
                    const rawAlt = altText ? altText.trim() : '';
                    const spec = parseImageSizeSpec(rawAlt, { allowSolo: true });
                    // If no explicit alt, fall back to the filename stem.
                    const alt = spec.alt || filename.replace(/\.[^/.]+$/, '');
                    // Emit width/height as BOTH HTML attributes (semantics, a11y)
                    // AND inline style. Tailwind's Preflight `img { height: auto }`
                    // wins over stylesheet rules that use attribute selectors, so
                    // inline style is the reliable way to pin the size.
                    const stylePieces = [];
                    if (spec.width) stylePieces.push(`width:${spec.width}px`);
                    if (spec.height) stylePieces.push(`height:${spec.height}px`);
                    const sizeAttrs = (spec.width ? ` width="${spec.width}"` : '') +
                                      (spec.height ? ` height="${spec.height}"` : '') +
                                      (stylePieces.length ? ` style="${stylePieces.join(';')}"` : '');
                    
                    // Resolve media path using O(1) lookup
                    const mediaPath = self.resolveMediaWikilink(filename);
                    
                    if (mediaPath) {
                        // URL-encode path segments for the API
                        const encodedPath = mediaPath.split('/').map(segment => {
                            try {
                                return encodeURIComponent(decodeURIComponent(segment));
                            } catch (e) {
                                return encodeURIComponent(segment);
                            }
                        }).join('/');
                        
                        const safeAlt = alt.replace(/"/g, '&quot;');
                        const mediaSrc = `/api/media/${encodedPath}`;
                        const mediaType = self.getMediaType(filename);
                        
                        // Return appropriate HTML based on media type.
                        // Size attributes only apply to images; non-image media
                        // ignores the size (still strips it from the caption).
                        switch (mediaType) {
                            case 'audio':
                                return `<div class="media-embed media-audio"><audio controls preload="none" src="${mediaSrc}" title="${safeAlt}"></audio><span class="media-caption">${safeAlt}</span></div>`;
                            case 'video':
                                return `<div class="media-embed media-video"><video controls preload="none" poster="" src="${mediaSrc}" title="${safeAlt}"></video></div>`;
                            case 'document':
                                // DOMPurify strips <iframe>, so emit a sentinel <span>
                                // that survives sanitization; the DOM walker below
                                // upgrades it to a media-pdf wrapper + iframe. Issue #239.
                                return `<span class="md-pdf-embed" data-src="${mediaSrc}" data-alt="${safeAlt}"></span>`;
                            default: // image
                                return `<img src="${mediaSrc}" alt="${safeAlt}" title="${safeAlt}"${sizeAttrs}>`;
                        }
                    }
                    
                    // Media not found - return broken indicator
                    const safeFilename = filename.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const mediaType = self.getMediaType(filename);
                    const icon = mediaType === 'audio' ? '🎵' : mediaType === 'video' ? '🎬' : mediaType === 'document' ? '📄' : '🖼️';
                    return `<span class="wikilink-broken" title="Media not found">${icon} ${safeFilename}</span>`;
                }
            );
            
            // Step 2b: Convert note wikilinks: [[note]] or [[note|display text]]
            contentToRender = contentToRender.replace(
                /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
                (match, target, displayText) => {
                    const linkTarget = target.trim();
                    const linkText = displayText ? displayText.trim() : linkTarget;
                    
                    // Resolve through the single resolver shared with click
                    // navigation (mirrors vault.LinkResolver). The raw target is
                    // kept when it resolves to nothing: that is what the
                    // create-from-link prompt offers as the path of the new note.
                    const hashIndex = linkTarget.indexOf('#');
                    const basePath = hashIndex !== -1 ? linkTarget.substring(0, hashIndex) : linkTarget;
                    const anchor = hashIndex !== -1 ? linkTarget.substring(hashIndex) : '';
                    const sourceFolder = self.currentNote && self.currentNote.includes('/')
                        ? self.currentNote.substring(0, self.currentNote.lastIndexOf('/'))
                        : '';
                    const resolvedPath = basePath === '' ? null : self.resolveWikiLink(basePath, sourceFolder);
                    const noteExists = basePath === '' || resolvedPath !== null;
                    
                    // The href has to be absolute (a resolved note path), while an
                    // unresolved target stays as written.
                    const hrefTarget = resolvedPath !== null ? '/' + resolvedPath + anchor : linkTarget;
                    
                    // Escape special chars: href needs quote escaping, text needs HTML escaping
                    const safeHref = hrefTarget.replace(/"/g, '%22');
                    const safeText = linkText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    
                    // Return link with data attribute for styling broken links
                    const brokenClass = noteExists ? '' : ' class="wikilink-broken"';
                    return `<a href="${safeHref}"${brokenClass} data-wikilink="true">${safeText}</a>`;
                }
            );
            
            // (Callouts handled in Step 0, before code-block extraction.)

            contentToRender = contentToRender.replace(
                /^(\s*[-*+]\s+\[[xX ]\]\s+)(\d+)\.(\s)/gm,
                '$1$2\\.$3'
            );
            contentToRender = contentToRender.replace(
                /^(\s*[-*+]\s+\[[xX ]\]\s+)([#>*+\-])(\s)/gm,
                '$1\\$2$3'
            );

            // Step 3: Restore code blocks
            contentToRender = contentToRender.replace(/\x00CODEBLOCK(\d+)\x00/g, (match, index) => {
                return codeBlocks[parseInt(index)];
            });
            
            // Protect LaTeX \(...\) and \[...\] delimiters from marked.js escaping
            marked.use({
                extensions: [{
                    name: 'protectLatexMath',
                    level: 'inline',
                    start(src) { return src.match(/\\[\(\[]/)?.index; },
                    tokenizer(src) {
                        // Match \(...\) or \[...\]
                        const match = src.match(/^(\\[\(\[])([\s\S]*?)(\\[\)\]])/);
                        if (match) {
                            return {
                                type: 'html',
                                raw: match[0],
                                text: match[0]
                            };
                        }
                    }
                }]
            });

            // Configure marked with syntax highlighting
            marked.setOptions({
                breaks: true,
                gfm: true,
                highlight: function(code, lang) {
                    if (lang && hljs.getLanguage(lang)) {
                        try {
                            return hljs.highlight(code, { language: lang }).value;
                        } catch (err) {
                            console.error('Highlight error:', err);
                        }
                    }
                    return hljs.highlightAuto(code).value;
                }
            });
            
            // Parse markdown
            let html = marked.parse(contentToRender);
            
            // Sanitize HTML to prevent XSS attacks
            // DOMPurify defaults allow most HTML/SVG tags but strip scripts, iframes, and event handlers
            // MathJax and Mermaid run AFTER this, so their elements don't need whitelisting
            html = DOMPurify.sanitize(html);
            
            // Post-process: Add target="_blank" to external links and title attributes to images
            // Parse as DOM to safely manipulate
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            
            // Find all links
            const links = tempDiv.querySelectorAll('a');
            links.forEach(link => {
                const href = link.getAttribute('href');
                if (href && typeof href === 'string') {
                    // Check if it's an external link
                    const isExternal = href.indexOf('http://') === 0 || 
                                      href.indexOf('https://') === 0 || 
                                      href.indexOf('//') === 0;
                    
                    if (isExternal) {
                        link.setAttribute('target', '_blank');
                        link.setAttribute('rel', 'noopener noreferrer');
                    }
                }
            });
            
            // Find all images and transform paths for display
            // Also convert non-image media (audio, video, PDF) to appropriate elements
            const images = tempDiv.querySelectorAll('img');
            images.forEach(img => {
                // Extract Obsidian-style size spec from standard-markdown alt.
                // Wikilink images already had their size applied above and their
                // alt cleaned, so calling this again is a no-op for them.
                // See wikilink handler comment above about why we set inline style
                // in addition to the width/height attributes.
                const rawAlt = img.getAttribute('alt') || '';
                const spec = parseImageSizeSpec(rawAlt);
                if (spec.width && !img.hasAttribute('width')) {
                    img.setAttribute('width', String(spec.width));
                    img.style.width = spec.width + 'px';
                }
                if (spec.height && !img.hasAttribute('height')) {
                    img.setAttribute('height', String(spec.height));
                    img.style.height = spec.height + 'px';
                }
                if (spec.alt !== rawAlt) {
                    img.setAttribute('alt', spec.alt);
                }

                let src = img.getAttribute('src');
                if (src) {
                    const isExternal = src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//');
                    const isLocal = !isExternal && !src.startsWith('data:');
                    
                    // Transform relative paths to /api/media/ for serving
                    if (isLocal && !src.startsWith('/api/media/')) {
                        const vaultRelative = self.currentNote
                            ? self.resolveMarkdownMediaPathForNote(self.currentNote, src)
                            : src.split('#')[0].split('?')[0];
                        const encodedPath = self.encodeVaultRelativePathForMediaApi(vaultRelative);
                        src = `/api/media/${encodedPath}`;
                        img.setAttribute('src', src);
                    }
                    
                    // Check if this is non-image media and convert to appropriate element
                    const mediaType = self.getMediaType(src);
                    const altText = img.getAttribute('alt') || src.split('/').pop().replace(/\.[^/.]+$/, '');
                    const safeAlt = altText.replace(/"/g, '&quot;');
                    
                    // Only convert LOCAL media to embedded elements (security)
                    // External non-image media gets styled links instead
                    if (isLocal || src.startsWith('/api/media/')) {
                        if (mediaType === 'audio') {
                            const wrapper = document.createElement('div');
                            wrapper.className = 'media-embed media-audio';
                            wrapper.innerHTML = `<audio controls preload="none" src="${src}" title="${safeAlt}"></audio><span class="media-caption">${safeAlt}</span>`;
                            img.replaceWith(wrapper);
                            return;
                        } else if (mediaType === 'video') {
                            const wrapper = document.createElement('div');
                            wrapper.className = 'media-embed media-video';
                            wrapper.innerHTML = `<video controls preload="none" poster="" src="${src}" title="${safeAlt}"></video>`;
                            img.replaceWith(wrapper);
                            return;
                        } else if (mediaType === 'document') {
                            // Local PDFs: show iframe preview
                            const wrapper = document.createElement('div');
                            wrapper.className = 'media-embed media-pdf';
                            wrapper.innerHTML = `<iframe src="${src}" title="${safeAlt}"></iframe>`;
                            img.replaceWith(wrapper);
                            return;
                        }
                    } else if (isExternal && mediaType === 'document') {
                        // External PDFs: styled link (opens in new tab)
                        const link = document.createElement('a');
                        link.href = src;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.className = 'pdf-link';
                        link.title = `Open ${safeAlt}`;
                        link.innerHTML = `<span class="pdf-link-content">📄 ${safeAlt}</span><span class="pdf-link-note">Opens in new tab</span>`;
                        img.replaceWith(link);
                        return;
                    }
                    // External audio/video: leave as broken image for security
                }
                
                // For regular images, set title attribute
                const altText = img.getAttribute('alt');
                if (altText) {
                    img.setAttribute('title', altText);
                }
            });

            // Upgrade PDF sentinels emitted by the wiki-embed pre-processor.
            // Must run AFTER DOMPurify because iframes are stripped by the sanitizer.
            tempDiv.querySelectorAll('span.md-pdf-embed').forEach(span => {
                const src = span.dataset.src || '';
                const alt = span.dataset.alt || '';
                if (!src) return;
                const safeAlt = alt.replace(/"/g, '&quot;');
                const wrapper = document.createElement('div');
                wrapper.className = 'media-embed media-pdf';
                wrapper.innerHTML = `<iframe src="${src}" title="${safeAlt}"></iframe>`;
                span.replaceWith(wrapper);
            });

            // marked renders these disabled, and a disabled input fires no click event.
            // The index is how a click finds its line, so only trust it when both sides
            // counted the same items; otherwise leave the boxes read-only.
            const taskBoxes = tempDiv.querySelectorAll('input[type="checkbox"]');
            if (taskBoxes.length && taskBoxes.length === this._scanTaskLines(this.noteContent).length) {
                taskBoxes.forEach((box, i) => {
                    box.removeAttribute('disabled');
                    box.setAttribute('data-task-index', String(i));
                });
            }

            // Landmark scroll-sync anchors. Stamps `data-source-line` on the DOM
            // elements corresponding to block-level constructs whose source line
            // can be determined from the raw editor content (headings, images,
            // tables, code fences, hr, block math). Used by setupScrollSync() to
            // interpolate the editor<->preview mapping accurately across images
            // and other tall blocks. Runs after all other DOM rewrites so the
            // final element identity is what gets tagged.
            try {
                const landmarks = this._scanSourceLandmarks(this.noteContent);
                this._annotateSourceAnchors(tempDiv, landmarks);
            } catch (e) {
                // Any anchor-building failure must not break rendering. Anchors
                // are an enhancement, not required for content display.
                console.warn('scroll-anchor annotation failed:', e);
            }

            html = tempDiv.innerHTML;
            
            // Debounced MathJax rendering (avoid re-running on every keystroke)
            if (this._mathDebounceTimeout) clearTimeout(this._mathDebounceTimeout);
            this._mathDebounceTimeout = setTimeout(() => this.typesetMath(), 300);
            
            // Debounced Mermaid rendering
            if (this._mermaidDebounceTimeout) clearTimeout(this._mermaidDebounceTimeout);
            this._mermaidDebounceTimeout = setTimeout(() => this.renderMermaid(), 300);
            
            // Apply syntax highlighting and add copy buttons to code blocks
            setTimeout(() => {
                // Use cached reference if available, otherwise query
                const previewEl = this._domCache.previewContent || document.querySelector('.markdown-preview');
                if (previewEl) {
                    // Exclude code blocks that are rendered by other tools (e.g., Mermaid diagrams)
                    // Note: MathJax uses $$...$$ delimiters (not code blocks) so no exclusion needed
                    previewEl.querySelectorAll('pre code:not(.language-mermaid)').forEach((block) => {
                        // Apply syntax highlighting
                        if (!block.classList.contains('hljs')) {
                            hljs.highlightElement(block);
                        }
                        
                        // Add copy button if not already present
                        const pre = block.parentElement;
                        if (pre && !pre.querySelector('.copy-code-button')) {
                            this.addCopyButtonToCodeBlock(pre);
                        }
                    });
                    
                    // Enable video metadata loading (for first frame preview)
                    // Track by source URL to prevent duplicate requests on re-renders
                    if (!this._initializedVideoSources) this._initializedVideoSources = new Set();
                    previewEl.querySelectorAll('video[preload="none"]').forEach((video) => {
                        const src = video.getAttribute('src');
                        if (src && !this._initializedVideoSources.has(src)) {
                            this._initializedVideoSources.add(src);
                            video.preload = 'metadata';
                        }
                    });
                }
            }, 0);
            
            // Cache the result for performance
            this._lastRenderedContent = this.noteContent;
            this._lastRenderedNote = this.currentNote;
            this._cachedRenderedHTML = html;
            
            return html;
        },
        
        // Refresh DOM element cache
        refreshDOMCache() {
            this._domCache.editor = document.querySelector('.editor-textarea');
            this._domCache.previewContent = document.querySelector('.markdown-preview');
            this._domCache.previewContainer = this._domCache.previewContent ? this._domCache.previewContent.parentElement : null;
        },
        
        // Add copy button to code block
        addCopyButtonToCodeBlock(preElement) {
            // Extract language from code element class (e.g., "language-toml" -> "TOML")
            const codeElement = preElement.querySelector('code');
            let language = '';
            if (codeElement && codeElement.className) {
                const match = codeElement.className.match(/language-(\w+)/);
                if (match) {
                    const langMap = {
                        'js': 'JavaScript', 'ts': 'TypeScript', 'py': 'Python',
                        'rb': 'Ruby', 'cs': 'C#', 'cpp': 'C++', 'sh': 'Shell',
                        'bash': 'Bash', 'zsh': 'Zsh', 'yml': 'YAML', 'md': 'Markdown'
                    };
                    const rawLang = match[1].toLowerCase();
                    language = langMap[rawLang] || match[1].toUpperCase();
                }
            }
            
            // Create copy button with language label
            const button = document.createElement('button');
            button.className = 'copy-code-button';
            const displayText = language || this.t('common.copy_to_clipboard').split(' ')[0]; // Use first word as fallback
            button.innerHTML = `<span>${displayText}</span>`;
            button.dataset.originalText = displayText; // Store for restore after copy
            button.title = this.t('common.copy_to_clipboard');
            
            // Style the button
            button.style.position = 'absolute';
            button.style.top = '8px';
            button.style.right = '8px';
            button.style.padding = '4px 10px';
            button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
            button.style.border = 'none';
            button.style.borderRadius = '4px';
            button.style.cursor = 'pointer';
            button.style.opacity = '0';
            button.style.transition = 'opacity 0.2s, background-color 0.2s';
            button.style.color = 'white';
            button.style.display = 'flex';
            button.style.alignItems = 'center';
            button.style.justifyContent = 'center';
            button.style.zIndex = '10';
            button.style.fontSize = '11px';
            button.style.fontWeight = '600';
            button.style.fontFamily = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
            button.style.textTransform = 'uppercase';
            button.style.letterSpacing = '0.5px';
            
            // Style the pre element to be relative
            preElement.style.position = 'relative';
            
            // Show button on hover
            preElement.addEventListener('mouseenter', () => {
                button.style.opacity = '1';
            });
            
            preElement.addEventListener('mouseleave', () => {
                button.style.opacity = '0';
            });
            
            // Copy to clipboard on click
            button.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const codeElement = preElement.querySelector('code');
                if (!codeElement) return;
                
                const code = codeElement.textContent;
                
                const originalText = button.dataset.originalText;
                const copiedText = this.t('common.copied');
                const copyTitle = this.t('common.copy_to_clipboard');
                
                try {
                    await navigator.clipboard.writeText(code);
                    
                    // Visual feedback - show localized "Copied!"
                    button.innerHTML = `<span>${copiedText}</span>`;
                    button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                    button.title = copiedText;
                    
                    // Reset after 2 seconds
                    setTimeout(() => {
                        button.innerHTML = `<span>${originalText}</span>`;
                        button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        button.title = copyTitle;
                    }, 2000);
                } catch (err) {
                    console.error('Failed to copy code:', err);
                    
                    // Fallback for older browsers
                    const textArea = document.createElement('textarea');
                    textArea.value = code;
                    textArea.style.position = 'fixed';
                    textArea.style.left = '-999999px';
                    document.body.appendChild(textArea);
                    textArea.select();
                    
                    try {
                        document.execCommand('copy');
                        button.innerHTML = `<span>${copiedText}</span>`;
                        button.style.backgroundColor = 'rgba(34, 197, 94, 0.8)';
                        setTimeout(() => {
                            button.innerHTML = `<span>${originalText}</span>`;
                            button.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
                        }, 2000);
                    } catch (fallbackErr) {
                        console.error('Fallback copy failed:', fallbackErr);
                    }
                    
                    document.body.removeChild(textArea);
                }
            });
            
            // Add button to pre element
            preElement.appendChild(button);
        },
        
        /**
         * Source line of every task item, in document order. Frontmatter and fenced
         * code are skipped since neither renders a checkbox. Callers pair these with the
         * rendered boxes only when the counts match, which is safe as long as this can
         * over-count but never under-count: a miss here could cancel out a spare and
         * pass that check with everything shifted by one.
         */
        _scanTaskLines(source) {
            if (typeof source !== 'string' || !source) return [];
            const lines = source.split('\n');
            const taskLines = [];
            let startIdx = 0;

            if (lines[0] && lines[0].trim() === '---') {
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i].trim() === '---') {
                        startIdx = i + 1;
                        break;
                    }
                }
            }

            // Indented fences count here: one nested in a list item still hides tasks.
            const FENCE = /^\s*(`{3,}|~{3,})/;
            let openFence = null;

            for (let i = startIdx; i < lines.length; i++) {
                const fence = lines[i].match(FENCE);
                if (openFence) {
                    if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
                        openFence = null;
                    }
                    continue;
                }
                if (fence) {
                    openFence = fence[1];
                    continue;
                }
                if (TASK_ITEM_RE.test(lines[i])) taskLines.push(i);
            }

            return taskLines;
        },

        /**
         * Scan raw editor source for block-level landmarks whose source position can be
         * determined without marked.js (which sees a pre-processed string with mangled
         * line counts). Lines are 0-indexed to match the scroll handler. Landmarks: fence
         * openers, headings, standalone images, table first row, hrules, block math.
         * Frontmatter and fence contents are skipped.
         */
        _scanSourceLandmarks(source) {
            if (typeof source !== 'string' || !source) return [];
            const lines = source.split('\n');
            const landmarks = [];
            let startIdx = 0;

            // Skip YAML frontmatter (mirrors the stripping logic in renderedMarkdown)
            if (lines[0] && lines[0].trim() === '---') {
                for (let i = 1; i < lines.length; i++) {
                    if (lines[i].trim() === '---') {
                        startIdx = i + 1;
                        break;
                    }
                }
            }

            let inFence = false;
            let fenceChar = null;
            let fenceLen = 0;
            let inTable = false;
            let inBlockMath = false;

            // All landmark regexes match ONLY at column 0. CommonMark technically
            // allows 0-3 spaces of leading indent for these block starts, but the
            // moment we accept any indent we start capturing list-nested landmarks
            // (e.g. a fence inside a `- item` continuation), which do NOT render
            // as top-level DOM children. That would produce wrong-anchor bugs
            // that are worse than missed anchors. Requiring column 0 keeps the
            // scanner's landmark stream in strict correspondence with top-level
            // DOM children, at the cost of missing rare indented top-level
            // blocks. The safety-net count check in _annotateSourceAnchors
            // catches any residual mismatch.
            const FENCE_OPEN = /^(`{3,}|~{3,})/;
            const HEADING = /^(#{1,6})\s/;
            // Horizontal rule: 3+ dashes/asterisks/underscores optionally separated by spaces.
            // Note: setext heading underlines (`text\n---`) match this pattern too, so
            // we only accept it as a true HR when the previous line is blank — which is
            // CommonMark's disambiguator between a setext underline and a thematic break.
            const HR = /^([-*_])(\s*\1){2,}\s*$/;
            // Setext heading underline: a run of `=` (h1) or `-` (h2) and nothing else.
            const SETEXT_UNDERLINE = /^(=+|-+)\s*$/;
            const IMG_MD = /^!\[[^\]]*\]\([^)]*\)\s*$/;
            const IMG_WIKI = /^!\[\[[^\]]+\]\]\s*$/;
            const TABLE_ROW = /^\|.+\|\s*$/;
            const BLOCK_MATH_OPEN = /^\\\[\s*$/;
            const BLOCK_MATH_CLOSE = /^\\\]\s*$/;

            for (let i = startIdx; i < lines.length; i++) {
                const line = lines[i];
                const lineNum = i; // 0-indexed to match editor.scrollTop / lineHeight

                // Inside a fence: pass through until close.
                if (inFence) {
                    const closeRe = new RegExp(
                        '^\\s{0,3}' + (fenceChar === '`' ? '`' : '~') + '{' + fenceLen + ',}\\s*$'
                    );
                    if (closeRe.test(line)) {
                        inFence = false;
                        fenceChar = null;
                        fenceLen = 0;
                    }
                    inTable = false;
                    continue;
                }

                // Inside a block-math region: pass through until close.
                if (inBlockMath) {
                    if (BLOCK_MATH_CLOSE.test(line)) inBlockMath = false;
                    inTable = false;
                    continue;
                }

                const fenceOpen = line.match(FENCE_OPEN);
                if (fenceOpen) {
                    inFence = true;
                    fenceChar = fenceOpen[1][0];
                    fenceLen = fenceOpen[1].length;
                    landmarks.push({ line: lineNum, kind: 'pre' });
                    inTable = false;
                    continue;
                }

                if (BLOCK_MATH_OPEN.test(line)) {
                    inBlockMath = true;
                    landmarks.push({ line: lineNum, kind: 'math' });
                    inTable = false;
                    continue;
                }

                const headingMatch = line.match(HEADING);
                if (headingMatch) {
                    // Per-level kind ('h1'..'h6') so that a stray setext-produced
                    // <h2> in the DOM can never pop an ATX '# heading' landmark
                    // meant for an <h1>. Levels align 1:1 with tag names.
                    landmarks.push({ line: lineNum, kind: 'h' + headingMatch[1].length });
                    inTable = false;
                    continue;
                }

                // Setext heading (`text` followed by `===` or `---`). The rendered
                // heading corresponds to the TEXT line, so that is what the anchor
                // must point at. Checked before HR because `---` is ambiguous and
                // CommonMark resolves it as a setext underline whenever it follows a
                // paragraph. Skipping it entirely leaves the DOM with a heading the
                // scanner never counted, which fails the per-kind count check and
                // discards every anchor of that heading level in the note.
                if (!inTable && i > startIdx && SETEXT_UNDERLINE.test(line)) {
                    const prev = lines[i - 1];
                    const prevIsParagraph = prev.trim() !== ''
                        && !HEADING.test(prev)
                        && !FENCE_OPEN.test(prev)
                        && !TABLE_ROW.test(prev)
                        && !IMG_MD.test(prev)
                        && !IMG_WIKI.test(prev)
                        && !BLOCK_MATH_CLOSE.test(prev)
                        && !SETEXT_UNDERLINE.test(prev);
                    if (prevIsParagraph) {
                        landmarks.push({ line: i - 1, kind: line[0] === '=' ? 'h1' : 'h2' });
                        continue;
                    }
                }

                if (HR.test(line)) {
                    // Only a true horizontal rule if preceded by a blank line (or
                    // start-of-scan). Otherwise it's a setext heading underline
                    // and the DOM will produce an <h1>/<h2>, not an <hr>.
                    const prevBlank = i === startIdx || lines[i - 1].trim() === '';
                    if (prevBlank) {
                        landmarks.push({ line: lineNum, kind: 'hr' });
                    }
                    inTable = false;
                    continue;
                }

                if (IMG_MD.test(line) || IMG_WIKI.test(line)) {
                    landmarks.push({ line: lineNum, kind: 'img' });
                    inTable = false;
                    continue;
                }

                if (TABLE_ROW.test(line)) {
                    // Only anchor the first row of a table run
                    if (!inTable) {
                        landmarks.push({ line: lineNum, kind: 'table' });
                        inTable = true;
                    }
                    continue;
                }

                // Anything else breaks a table run
                if (line.trim() === '' || !TABLE_ROW.test(line)) {
                    inTable = false;
                }
            }

            return landmarks;
        },

        /**
         * Attach `data-source-line` to top-level preview blocks whose tag matches the next
         * landmark of the same kind. Per-kind FIFO queues keep a mismatch in one kind from
         * derailing another kind's alignment.
         */
        _annotateSourceAnchors(root, landmarks) {
            if (!root || !landmarks || landmarks.length === 0) return;

            const queues = {
                h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
                pre: [], img: [], table: [], hr: [], math: [],
            };
            for (const lm of landmarks) {
                if (queues[lm.kind]) queues[lm.kind].push(lm);
            }

            // Categorize every top-level DOM child once. Using childNodes.length
            // (not children.length) for the <p><img></p> check so that a mixed
            // paragraph like <p>text <img></p> — which has children.length===1
            // but a text node before the img — does NOT get counted as an img
            // landmark. That would inflate the img DOM count and either misalign
            // real image anchors or trigger the safety-net drop below.
            // A single-media <p> covers all the shapes marked/our pipeline can
            // emit for `![](...)` and `![[...]]`:
            //   - <p><img></p>                       plain image
            //   - <p><video></p> / <p><audio></p>    local A/V (post-transform)
            //   - <p><div.media-embed></p>           local PDF / external PDF link
            //   - <p><a.pdf-link></p>                external PDF (as styled link)
            // childNodes.length === 1 (NOT children.length) rejects mixed inline
            // paragraphs like `<p>text <img></p>`, which have a text node before
            // the media element and must not be counted as image landmarks.
            const isMediaOnlyParagraph = (el) => {
                if (el.childNodes.length !== 1) return false;
                const child = el.firstElementChild;
                if (!child) return false;
                const t = child.tagName;
                if (t === 'IMG' || t === 'VIDEO' || t === 'AUDIO') return true;
                if (t === 'DIV' && child.classList && child.classList.contains('media-embed')) return true;
                if (t === 'A' && child.classList && child.classList.contains('pdf-link')) return true;
                return false;
            };

            const domKinds = [];
            for (const el of Array.from(root.children)) {
                let kind = null;
                const tag = el.tagName;
                if (/^H[1-6]$/.test(tag)) kind = 'h' + tag[1];
                else if (tag === 'PRE') kind = 'pre';
                else if (tag === 'HR') kind = 'hr';
                else if (tag === 'TABLE') kind = 'table';
                else if (tag === 'IMG') kind = 'img';
                else if (tag === 'P' && isMediaOnlyParagraph(el)) kind = 'img';
                else if (tag === 'DIV' && el.classList && el.classList.contains('media-embed')) kind = 'img';
                domKinds.push({ el, kind });
            }
            const domCounts = {};
            for (const dk of domKinds) {
                if (dk.kind) domCounts[dk.kind] = (domCounts[dk.kind] || 0) + 1;
            }

            // Safety net. For each kind, proceed only if the scanner's landmark
            // count exactly matches the DOM's top-level child count. Any drift
            // — e.g. a "|pipe|" line that scanner tagged as a table but marked
            // did not render as one, or an inline <img> paragraph that got
            // mis-kinded above — disables the whole kind. Missing anchors are
            // graceful (sync interpolates through the surviving anchors); wrong
            // anchors would be worse than no anchors, so this is the right
            // trade-off.
            for (const kind of Object.keys(queues)) {
                if ((domCounts[kind] || 0) !== queues[kind].length) {
                    queues[kind] = [];
                }
            }

            for (const dk of domKinds) {
                if (dk.kind && queues[dk.kind] && queues[dk.kind].length) {
                    const lm = queues[dk.kind].shift();
                    dk.el.setAttribute('data-source-line', String(lm.line));
                }
            }
        },

        /**
         * Measure pixel Y positions of source lines as rendered in the textarea, using the
         * "mirror div" technique: a hidden div styled identically to the textarea, with
         * marker spans at the target lines. Wrapping matches pixel-for-pixel only as long
         * as every wrap-affecting property is copied. Returns { line -> pixelY } for the
         * requested lines; missing lines get no entry.
         */
        _measureEditorLinePositions(source, editor, targetLines) {
            if (!editor || typeof source !== 'string' || !targetLines || targetLines.length === 0) {
                return {};
            }

            const cs = window.getComputedStyle(editor);
            const div = document.createElement('div');

            // Every CSS property that affects textarea line wrapping and
            // vertical stacking. Border/padding are re-set below so they
            // don't double-apply on top of our explicit width override.
            const props = [
                'direction',
                'fontFamily', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch',
                'fontSize', 'fontSizeAdjust', 'lineHeight',
                'letterSpacing', 'wordSpacing',
                'tabSize', 'MozTabSize',
                'textIndent', 'textAlign', 'textTransform', 'textDecoration',
            ];
            for (const prop of props) {
                div.style[prop] = cs[prop];
            }

            // Force mirror's content area to be the exact wrapping width of
            // the textarea's content area. editor.clientWidth includes padding
            // but excludes borders and scrollbar; subtracting horizontal
            // padding gives the true wrapping width.
            //
            // Padding is KEPT on the mirror (matching textarea's) because a
            // textarea's padding lives inside its scrollable content — line 0
            // sits at Y = paddingTop within scroll coordinates, not Y = 0.
            // Zeroing the mirror's padding would produce Y values shifted up
            // by paddingTop and every anchor would land that many pixels off.
            // Border is zeroed because it lives OUTSIDE the scrollable area.
            const paddingLeft = parseFloat(cs.paddingLeft) || 0;
            const paddingRight = parseFloat(cs.paddingRight) || 0;
            const contentWidth = Math.max(0, editor.clientWidth - paddingLeft - paddingRight);
            div.style.boxSizing = 'content-box';
            div.style.width = contentWidth + 'px';
            div.style.paddingTop = cs.paddingTop;
            div.style.paddingRight = cs.paddingRight;
            div.style.paddingBottom = cs.paddingBottom;
            div.style.paddingLeft = cs.paddingLeft;
            div.style.borderWidth = '0';
            // Grow to content, off-screen, no scrolling.
            div.style.height = 'auto';
            div.style.overflow = 'hidden';
            div.style.position = 'absolute';
            div.style.top = '0';
            div.style.left = '-99999px';
            div.style.visibility = 'hidden';
            // Match textarea's line-wrapping behavior.
            div.style.whiteSpace = 'pre-wrap';
            div.style.wordWrap = 'break-word';
            div.style.overflowWrap = 'break-word';

            // Populate: text nodes for regular lines, marker spans at target
            // lines. Using textContent (not innerHTML) is safe against markup
            // in the source being interpreted as HTML.
            const lines = source.split('\n');
            const needed = new Set(targetLines);
            for (let i = 0; i < lines.length; i++) {
                if (needed.has(i)) {
                    const marker = document.createElement('span');
                    marker.setAttribute('data-line', String(i));
                    // Zero-width space so empty-line markers still have a
                    // measurable position (a truly empty <span> collapses).
                    marker.textContent = lines[i].length ? lines[i] : '\u200B';
                    div.appendChild(marker);
                } else {
                    div.appendChild(document.createTextNode(lines[i]));
                }
                if (i < lines.length - 1) {
                    div.appendChild(document.createTextNode('\n'));
                }
            }

            document.body.appendChild(div);
            const divRect = div.getBoundingClientRect();
            const positions = {};
            for (const marker of div.querySelectorAll('span[data-line]')) {
                const line = parseInt(marker.dataset.line, 10);
                if (Number.isFinite(line)) {
                    positions[line] = marker.getBoundingClientRect().top - divRect.top;
                }
            }
            document.body.removeChild(div);
            return positions;
        },

        /**
         * Return sorted anchors: [{ line, previewTop, editorY }, ...]. previewTop is
         * measured live each call since top values shift on resize/MathJax/image-load;
         * editorY comes from the mirror div (cached by content + width + font metrics)
         * and is what makes sync robust to non-uniform prose wrapping.
         */
        _getScrollAnchors() {
            const container = this._domCache.previewContainer;
            const previewRoot = this._domCache.previewContent;
            const editor = this._domCache.editor;
            if (!container || !previewRoot) return null;

            const els = previewRoot.querySelectorAll('[data-source-line]');
            if (els.length === 0) return [];

            // Collect landmark source lines we need editor Y for.
            const lines = [];
            for (const el of els) {
                const line = parseInt(el.getAttribute('data-source-line'), 10);
                if (Number.isFinite(line)) lines.push(line);
            }

            // Editor line-position cache. Invalidates when any of:
            // - note content changes
            // - editor width changes (split resize, window resize)
            // - font metrics change (theme switch)
            // Fresh measurement is O(N) DOM work; cached lookup is O(1).
            let editorPositions = {};
            if (editor && lines.length > 0 && editor.scrollHeight > 0) {
                const cs = window.getComputedStyle(editor);
                const cacheKey = [
                    editor.clientWidth,
                    cs.fontSize,
                    cs.fontFamily,
                    cs.lineHeight,
                    cs.letterSpacing,
                ].join('|');
                const content = this.noteContent || '';
                if (this._editorPosCache
                    && this._editorPosCache.content === content
                    && this._editorPosCache.key === cacheKey) {
                    editorPositions = this._editorPosCache.positions;
                } else {
                    editorPositions = this._measureEditorLinePositions(content, editor, lines);
                    this._editorPosCache = { content, key: cacheKey, positions: editorPositions };
                }
            }

            const cRect = container.getBoundingClientRect();
            const containerScroll = container.scrollTop;
            const anchors = [];
            for (const el of els) {
                const line = parseInt(el.getAttribute('data-source-line'), 10);
                if (!Number.isFinite(line)) continue;
                const previewTop = el.getBoundingClientRect().top - cRect.top + containerScroll;
                const editorY = editorPositions[line];
                anchors.push({
                    line,
                    previewTop,
                    editorY: Number.isFinite(editorY) ? editorY : null,
                });
            }
            anchors.sort((a, b) => a.line - b.line);
            return anchors;
        },

        /**
         * Build the anchor list bracketed by virtual doc-start/doc-end entries, each
         * { editorPct, previewTop }. Both axes are pixel-derived so non-uniform editor
         * wrapping stays correct; landmarks missing a measured editorY fall back to
         * sourceLine/(totalLines-1). With no landmarks it collapses to percentage sync.
         */
        _buildAnchorRange(anchors, editor, previewContainer, totalSourceLines) {
            const maxPreviewTop = Math.max(0, previewContainer.scrollHeight - previewContainer.clientHeight);
            const editorMeasurable = editor && editor.scrollHeight > 0;
            const editorScrollable = editorMeasurable
                ? Math.max(0, editor.scrollHeight - editor.clientHeight)
                : 0;
            const denom = Math.max(1, totalSourceLines - 1);

            const list = [{ editorPct: 0, previewTop: 0 }];
            if (anchors && anchors.length) {
                for (const a of anchors) {
                    if (!a || !Number.isFinite(a.previewTop) || a.previewTop < 0) continue;
                    // A landmark inside the final viewport of either pane can never be
                    // brought to that pane's top, so it has no usable anchor position.
                    // These must be dropped rather than clamped: a clamped entry sits
                    // at the end of the range, swallows every later anchor via the
                    // monotonicity check, and blocks the doc-end anchor below - which
                    // left the preview stopping short of the bottom.
                    if (a.previewTop >= maxPreviewTop) continue;
                    let editorPct;
                    if (editorMeasurable && Number.isFinite(a.editorY) && a.editorY >= 0 && editorScrollable > 0) {
                        // Real measurement path.
                        if (a.editorY >= editorScrollable) continue;
                        editorPct = a.editorY / editorScrollable;
                    } else {
                        // Fallback: uniform-wrap approximation. Used when the
                        // editor is hidden (preview-only mode) or when mirror
                        // measurement returned no entry for this line.
                        editorPct = Math.max(0, Math.min(1, a.line / denom));
                        if (editorPct >= 1) continue;
                    }
                    const last = list[list.length - 1];
                    // Enforce strict monotonicity on both axes so the bracket
                    // search below is correct. Anchors that would violate
                    // (usually two landmarks on the same wrapped line, or
                    // very close together) are skipped.
                    if (editorPct > last.editorPct && a.previewTop >= last.previewTop) {
                        list.push({ editorPct, previewTop: a.previewTop });
                    }
                }
            }
            // Every surviving entry is strictly inside both scroll ranges, so the
            // doc-end anchor always applies. It guarantees that scrolling either pane
            // to its end scrolls the other to its end.
            list.push({ editorPct: 1, previewTop: maxPreviewTop });
            return { list, maxPreviewTop };
        },

        /**
         * Map the editor's current scroll percentage to a preview scrollTop
         * by interpolating between the bracketing landmark pair (with virtual
         * doc-start and doc-end anchors provided by _buildAnchorRange).
         */
        _editorPctToPreviewScrollTop(editorPct, anchors, editor, previewContainer, totalSourceLines) {
            const { list, maxPreviewTop } = this._buildAnchorRange(anchors, editor, previewContainer, totalSourceLines);

            let before = list[0];
            let after = list[list.length - 1];
            for (let i = 1; i < list.length; i++) {
                if (list[i].editorPct >= editorPct) {
                    before = list[i - 1];
                    after = list[i];
                    break;
                }
            }
            const pctSpan = after.editorPct - before.editorPct;
            const pxSpan = after.previewTop - before.previewTop;
            const localPct = pctSpan > 0 ? (editorPct - before.editorPct) / pctSpan : 0;
            const clamped = Math.max(0, Math.min(1, localPct));
            const target = before.previewTop + clamped * pxSpan;
            return Math.max(0, Math.min(maxPreviewTop, target));
        },

        /**
         * Reverse mapping: preview scrollTop → editor scroll percentage.
         */
        _previewScrollTopToEditorPct(previewScrollTop, anchors, editor, previewContainer, totalSourceLines) {
            const { list } = this._buildAnchorRange(anchors, editor, previewContainer, totalSourceLines);

            let before = list[0];
            let after = list[list.length - 1];
            for (let i = 1; i < list.length; i++) {
                if (list[i].previewTop >= previewScrollTop) {
                    before = list[i - 1];
                    after = list[i];
                    break;
                }
            }
            const pxSpan = after.previewTop - before.previewTop;
            const pctSpan = after.editorPct - before.editorPct;
            const localPct = pxSpan > 0 ? (previewScrollTop - before.previewTop) / pxSpan : 0;
            const clamped = Math.max(0, Math.min(1, localPct));
            return before.editorPct + clamped * pctSpan;
        },

        // Setup scroll synchronization
        // Ignore scroll events for a short window after a programmatic write.
        // The guard is time-based (not the isScrolling flag) because a single
        // jump writes to both panes: the second write would re-arm the flag
        // only to have the first event consume it, and the second event would
        // then mirror its pane back to a proportional position.
        _suspendScrollSync(ms = CONFIG.SCROLL_SYNC_DELAY) {
            this._scrollSyncSuppressUntil = performance.now() + ms;
        },

        _scrollSyncSuppressed() {
            return performance.now() < this._scrollSyncSuppressUntil;
        },

        setupScrollSync() {
            // Use cached references (refresh if not available)
            if (!this._domCache.editor || !this._domCache.previewContainer) {
                this.refreshDOMCache();
            }
            
            const editor = this._domCache.editor;
            const preview = this._domCache.previewContainer;
            
            if (!editor || !preview) {
                // If elements don't exist yet, retry with limit
                if (!this._setupScrollSyncRetries) this._setupScrollSyncRetries = 0;
                if (this._setupScrollSyncRetries < CONFIG.SCROLL_SYNC_MAX_RETRIES) {
                    this._setupScrollSyncRetries++;
                    setTimeout(() => this.setupScrollSync(), CONFIG.SCROLL_SYNC_RETRY_INTERVAL);
                } else {
                    console.warn(`setupScrollSync: Failed to find editor/preview elements after ${CONFIG.SCROLL_SYNC_MAX_RETRIES} retries`);
                }
                return;
            }
            
            // Reset retry counter on success
            this._setupScrollSyncRetries = 0;
            
            // Remove old listeners if they exist
            if (this._editorScrollHandler) {
                editor.removeEventListener('scroll', this._editorScrollHandler);
            }
            if (this._previewScrollHandler) {
                preview.removeEventListener('scroll', this._previewScrollHandler);
            }

            // Drop any frame queued by the previous note, so its write can't land
            // against the new note's content.
            if (this._editorSyncFrame) {
                cancelAnimationFrame(this._editorSyncFrame);
                this._editorSyncFrame = null;
            }
            if (this._previewSyncFrame) {
                cancelAnimationFrame(this._previewSyncFrame);
                this._previewSyncFrame = null;
            }
            
            // Create new scroll handlers
            this._editorScrollHandler = () => {
                if (this.isScrolling) {
                    this.isScrolling = false;
                    return;
                }

                if (this._scrollSyncSuppressed()) {
                    this.isScrolling = false;
                    return;
                }

                // Coalesce bursts into one sync per frame: _getScrollAnchors()
                // reads a rect per landmark, so running it per scroll event is
                // O(landmarks) layout work at event rate. The frame callback
                // re-reads scrollTop, so it always acts on the latest position.
                if (this._editorSyncFrame) return;
                this._editorSyncFrame = requestAnimationFrame(() => {
                    this._editorSyncFrame = null;

                    // Skip while this pane has no layout width: during a
                    // view-mode switch the not-yet-hidden pane briefly
                    // collapses to width 0, which makes the textarea wrap
                    // character-by-character and produce a degenerate
                    // percentage (editorPct=1). Storing that is what made the
                    // editor "jump to the end" on the next restore.
                    if (editor.clientWidth <= 0) return;
                    if (this._viewModeSwitching) return;

                    // Landmark-anchored sync using EDITOR PERCENTAGE (not line
                    // index — see _buildAnchorRange for the wrap-safety reason).
                    // Preview lands at the pixel position interpolated between
                    // the bracketing landmark pair. Falls back to percentage
                    // within a span when a note has no landmarks.
                    const editorScrollable = editor.scrollHeight - editor.clientHeight;
                    if (editorScrollable <= 0) return;

                    const editorPct = editor.scrollTop / editorScrollable;
                    const totalLines = (this.noteContent || '').split('\n').length;
                    const anchors = this._getScrollAnchors();

                    // Store as percentage so cross-view-mode restore works even
                    // when the editor is hidden (display:none, scrollHeight=0).
                    if (this.currentNote) {
                        this.noteScrollPositions[this.currentNote] = { editorPct };
                    }

                    if (preview.scrollHeight - preview.clientHeight > 0) {
                        const target = this._editorPctToPreviewScrollTop(
                            editorPct, anchors, editor, preview, totalLines
                        );
                        // Only arm the reentrancy guard when the write will actually
                        // move the pane. Assigning an unchanged scrollTop fires no
                        // scroll event, which would leave the guard set and make it
                        // swallow the user's next real scroll.
                        if (Math.abs(preview.scrollTop - target) >= 1) {
                            this.isScrolling = true;
                            preview.scrollTop = target;
                        }
                    }
                });
            };
            
            this._previewScrollHandler = () => {
                if (this.isScrolling) {
                    this.isScrolling = false;
                    return;
                }

                if (this._scrollSyncSuppressed()) {
                    this.isScrolling = false;
                    return;
                }

                // Frame-coalesced for the same reason as the editor handler above.
                if (this._previewSyncFrame) return;
                this._previewSyncFrame = requestAnimationFrame(() => {
                    this._previewSyncFrame = null;

                    // Same degenerate-width guard as the editor handler: a
                    // zero-width preview wraps every character onto its own
                    // line and would store a bogus editorPct.
                    if (preview.clientWidth <= 0) return;
                    if (this._viewModeSwitching) return;

                    const previewScrollable = preview.scrollHeight - preview.clientHeight;
                    if (previewScrollable <= 0) return;

                    const anchors = this._getScrollAnchors();
                    const totalLines = (this.noteContent || '').split('\n').length;
                    const editorPct = this._previewScrollTopToEditorPct(
                        preview.scrollTop, anchors, editor, preview, totalLines
                    );

                    // Capture preview-driven scrolls too — this is the only path
                    // that fires in preview-only mode, where the textarea is
                    // display:none and never scrolls.
                    if (this.currentNote) {
                        this.noteScrollPositions[this.currentNote] = { editorPct };
                    }

                    const editorScrollable = editor.scrollHeight - editor.clientHeight;
                    if (editorScrollable > 0) {
                        const target = editorPct * editorScrollable;
                        if (Math.abs(editor.scrollTop - target) >= 1) {
                            this.isScrolling = true;
                            editor.scrollTop = target;
                        }
                    }
                });
            };
            
            // Attach new listeners
            editor.addEventListener('scroll', this._editorScrollHandler);
            preview.addEventListener('scroll', this._previewScrollHandler);
        },
        
        // Check if a string is a URL
        isUrl(str) {
            if (typeof str !== 'string') return false;
            return /^https?:\/\/\S+$/i.test(str.trim());
        },
        
        // Escape HTML to prevent XSS
        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },
        
        // Format metadata value for display
        formatMetadataValue(key, value) {
            if (value === null || value === undefined) return '';
            
            // Arrays are handled separately in the template
            if (Array.isArray(value)) return value;
            
            // Format dates nicely
            if (key === 'date' || key === 'created' || key === 'modified' || key === 'updated') {
                let date;
                // Parse date-only strings (YYYY-MM-DD) as local dates to avoid timezone issues
                if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
                    const [year, month, day] = value.split('-').map(Number);
                    date = new Date(year, month - 1, day);  // month is 0-indexed
                } else {
                    date = new Date(value);
                }
                if (!isNaN(date.getTime())) {
                    return date.toLocaleDateString(this.currentLocale, { 
                        year: 'numeric', 
                        month: 'short', 
                        day: 'numeric' 
                    });
                }
            }
            
            // Booleans
            if (typeof value === 'boolean') {
                return value ? this.t('common.yes') : this.t('common.no');
            }
            
            return String(value);
        },
        
        // Format metadata value as HTML (for URL support)
        formatMetadataValueHtml(key, value) {
            const formatted = this.formatMetadataValue(key, value);
            
            // Check if it's a URL
            if (this.isUrl(formatted)) {
                const escaped = this.escapeHtml(formatted);
                // Truncate long URLs for display
                const displayUrl = formatted.length > 40 
                    ? formatted.substring(0, 37) + '...' 
                    : formatted;
                return `<a href="${escaped}" target="_blank" rel="noopener noreferrer" class="metadata-link">${this.escapeHtml(displayUrl)}</a>`;
            }
            
            return this.escapeHtml(formatted);
        },
        
        // Get priority metadata fields (shown in collapsed view)
        getPriorityMetadataFields() {
            if (!this.noteMetadata) return [];
            
            // Fields to show in collapsed view, in order of priority
            const priority = ['date', 'created', 'author', 'status', 'priority', 'type', 'category'];
            const fields = [];
            
            for (const key of priority) {
                if (this.noteMetadata[key] !== undefined && !Array.isArray(this.noteMetadata[key])) {
                    const formatted = this.formatMetadataValue(key, this.noteMetadata[key]);
                    const isUrl = this.isUrl(formatted);
                    fields.push({ 
                        key, 
                        value: formatted,
                        valueHtml: isUrl ? this.formatMetadataValueHtml(key, this.noteMetadata[key]) : this.escapeHtml(formatted),
                        isUrl
                    });
                }
            }
            
            return fields.slice(0, 3); // Show max 3 fields in collapsed view
        },
        
        // Get all metadata fields except tags (for expanded view)
        getAllMetadataFields() {
            if (!this.noteMetadata) return [];
            
            return Object.entries(this.noteMetadata)
                .filter(([key]) => key !== 'tags') // Tags shown separately
                .map(([key, value]) => {
                    const isArray = Array.isArray(value);
                    const formatted = this.formatMetadataValue(key, value);
                    const isUrl = !isArray && this.isUrl(formatted);
                    return {
                        key,
                        value: formatted,
                        valueHtml: isUrl ? this.formatMetadataValueHtml(key, value) : this.escapeHtml(formatted),
                        isArray,
                        isUrl
                    };
                });
        },
        
        // Check if note has any displayable metadata
        getHasMetadata() {
            const has = this.noteMetadata && Object.keys(this.noteMetadata).length > 0;
            return has;
        },
        
        // Get tags from metadata
        getMetadataTags() {
            if (!this.noteMetadata || !this.noteMetadata.tags) return [];
            return Array.isArray(this.noteMetadata.tags) ? this.noteMetadata.tags : [this.noteMetadata.tags];
        },
        
        // Save sidebar width to localStorage
        saveSidebarWidth() {
            localStorage.setItem('sidebarWidth', this.sidebarWidth.toString());
        },
        
        // Save view mode to localStorage
        saveViewMode() {
            try {
                localStorage.setItem('viewMode', this.viewMode);
            } catch (error) {
                console.error('Error saving view mode:', error);
            }
        },
        
        saveTagsExpanded() {
            try {
                localStorage.setItem('tagsExpanded', this.tagsExpanded.toString());
            } catch (error) {
                console.error('Error saving tags expanded state:', error);
            }
        },
        
        // Start resizing sidebar
        startResize(event) {
            this.isResizing = true;
            event.preventDefault();
            
            const resize = (e) => {
                if (!this.isResizing) return;
                
                // Calculate new width based on mouse position
                const newWidth = e.clientX;
                
                // Clamp between min and max
                if (newWidth >= 200 && newWidth <= 600) {
                    this.sidebarWidth = newWidth;
                }
            };
            
            const stopResize = () => {
                if (this.isResizing) {
                    this.isResizing = false;
                    this.saveSidebarWidth();
                    document.removeEventListener('mousemove', resize);
                    document.removeEventListener('mouseup', stopResize);
                }
            };
            
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResize);
        },
        
        // Start resizing split panes (editor/preview)
        startSplitResize(event) {
            this.isResizingSplit = true;
            event.preventDefault();
            
            const container = event.target.parentElement;
            
            const resize = (e) => {
                if (!this.isResizingSplit) return;
                
                const containerRect = container.getBoundingClientRect();
                const mouseX = e.clientX - containerRect.left;
                const percentage = (mouseX / containerRect.width) * 100;
                
                // Clamp between 20% and 80%
                if (percentage >= 20 && percentage <= 80) {
                    this.editorWidth = percentage;
                }
            };
            
            const stopResize = () => {
                if (this.isResizingSplit) {
                    this.isResizingSplit = false;
                    this.saveEditorWidth();
                    document.removeEventListener('mousemove', resize);
                    document.removeEventListener('mouseup', stopResize);
                }
            };
            
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResize);
        },
        
        // Setup mobile view mode handler (auto-switch from split to edit on mobile)
        setupMobileViewMode() {
            const MOBILE_BREAKPOINT = 768; // Match CSS breakpoint
            let previousWidth = window.innerWidth;
            
            const handleResize = () => {
                const currentWidth = window.innerWidth;
                const wasMobile = previousWidth <= MOBILE_BREAKPOINT;
                const isMobile = currentWidth <= MOBILE_BREAKPOINT;
                
                // If switching from desktop to mobile and in split mode
                if (!wasMobile && isMobile && this.viewMode === 'split') {
                    this.viewMode = 'edit';
                }
                
                previousWidth = currentWidth;
            };
            
            // Listen for window resize
            window.addEventListener('resize', handleResize);
            
            // Check initial state
            if (window.innerWidth <= MOBILE_BREAKPOINT && this.viewMode === 'split') {
                this.viewMode = 'edit';
            }
        },
        
        // Save editor width to localStorage
        saveEditorWidth() {
            localStorage.setItem('editorWidth', this.editorWidth.toString());
        },
        
        /**
         * Restore the saved scroll position for the current note in both panes. Also
         * called from the viewMode watcher because browsers reset scrollTop when an
         * overflow:auto element goes from display:none back to visible. Accepts either
         * a bare percentage or { editorPct }. Idempotent; isScrolling keeps the sync
         * handlers from echoing these programmatic writes.
         */
        _restoreNoteScroll() {
            if (!this.currentNote || this.currentMedia) return;
            const stored = this.noteScrollPositions[this.currentNote];
            if (stored === undefined || stored === null) return;

            if (!this._domCache.editor || !this._domCache.previewContainer) {
                this.refreshDOMCache();
            }
            const editor = this._domCache.editor;
            const preview = this._domCache.previewContainer;

            // Normalize both storage shapes into a single editorPct value.
            let pct = null;
            if (typeof stored === 'number') pct = stored;
            else if (typeof stored === 'object' && Number.isFinite(stored.editorPct)) pct = stored.editorPct;
            if (pct === null) return;

            if (editor) {
                const scrollable = editor.scrollHeight - editor.clientHeight;
                if (scrollable > 0) {
                    this.isScrolling = true;
                    editor.scrollTop = pct * scrollable;
                }
            }
            if (preview) {
                const scrollable = preview.scrollHeight - preview.clientHeight;
                if (scrollable > 0) {
                    const anchors = this._getScrollAnchors();
                    const totalLines = (this.noteContent || '').split('\n').length;
                    this.isScrolling = true;
                    preview.scrollTop = this._editorPctToPreviewScrollTop(
                        pct, anchors, editor, preview, totalLines
                    );
                }
            }
        },

        // Scroll to top of editor and preview
        scrollToTop() {
            // Disable scroll sync temporarily to prevent interference
            this.isScrolling = true;
            
            // Use cached references (refresh if not available)
            if (!this._domCache.editor || !this._domCache.previewContainer) {
                this.refreshDOMCache();
            }
            
            // Only scroll the visible panes based on viewMode
            if (this.viewMode === 'edit' || this.viewMode === 'split') {
                if (this._domCache.editor) {
                    this._domCache.editor.scrollTop = 0;
                }
            }
            
            if (this.viewMode === 'preview' || this.viewMode === 'split') {
                // Scroll the preview container (parent of .markdown-preview)
                if (this._domCache.previewContainer) {
                    this._domCache.previewContainer.scrollTop = 0;
                }
            }
            
            // Re-enable scroll sync after a short delay
            setTimeout(() => {
                this.isScrolling = false;
            }, CONFIG.SCROLL_SYNC_DELAY);
        },
        
        // Export current note as HTML via backend API
        async exportToHTML() {
            if (!this.currentNote || !this.noteContent) {
                this.toast(this.t('notes.no_content'), { type: 'info' });
                return;
            }
            
            try {
                // Build API URL with current theme
                const currentTheme = this.currentTheme || 'light';
                const encodedPath = this.currentNote.split('/').map(s => encodeURIComponent(s)).join('/');
                const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}`;
                
                // Fetch the exported HTML from backend
                const response = await fetch(url);
                if (!response.ok) {
                    const error = await response.json().catch(() => ({ detail: 'Export failed' }));
                    throw new Error(error.detail || 'Export failed');
                }
                
                // Get filename from Content-Disposition header or use note name
                let filename = (this.currentNoteName || 'note') + '.html';
                const contentDisposition = response.headers.get('Content-Disposition');
                if (contentDisposition) {
                    const match = contentDisposition.match(/filename="([^"]+)"/);
                    if (match) {
                        filename = match[1];
                    }
                }
                
                // Download as blob
                const blob = await response.blob();
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                
                // Cleanup
                URL.revokeObjectURL(blobUrl);
                document.body.removeChild(a);
                
            } catch (error) {
                console.error('HTML export failed:', error);
                this.toast(this.t('export.failed', { error: error.message }), { type: 'error' });
            }
        },
        
        // Open print preview in new window
        printPreview() {
            if (!this.currentNote || !this.noteContent) {
                this.toast(this.t('notes.no_content'), { type: 'info' });
                return;
            }
            
            // Build API URL with current theme and download=false for inline display
            const currentTheme = this.currentTheme || 'light';
            const encodedPath = this.currentNote.split('/').map(s => encodeURIComponent(s)).join('/');
            const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}&download=false`;
            
            // Open in new window/tab
            window.open(url, '_blank');
        },
        
        // Copy current note link to clipboard
        async copyNoteLink() {
            if (!this.currentNote) return;
            
            // Build the full URL
            const pathWithoutExtension = this.currentNote.replace('.md', '');
            const encodedPath = pathWithoutExtension.split('/').map(segment => encodeURIComponent(segment)).join('/');
            const url = `${window.location.origin}/${encodedPath}`;
            
            try {
                await navigator.clipboard.writeText(url);
            } catch (error) {
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = url;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            
            // Show brief "Copied!" feedback
            this.linkCopied = true;
            setTimeout(() => {
                this.linkCopied = false;
            }, 1500);
        },
        
        // ============================================
        // Quick Switcher (Ctrl+Alt+P)
        // ============================================
        
        openQuickSwitcher() {
            this.showQuickSwitcher = true;
            this.quickSwitcherQuery = '';
            this.quickSwitcherIndex = 0;
            // Populate initial results
            this.quickSwitcherResults = (this.allNotes || []).slice(0, 10);
            // Focus the input after the modal renders
            this.$nextTick(() => {
                const input = document.getElementById('quickSwitcherInput');
                if (input) input.focus();
            });
        },
        
        closeQuickSwitcher() {
            this.showQuickSwitcher = false;
            this.quickSwitcherQuery = '';
            this.quickSwitcherIndex = 0;
        },
        
        // Filter notes for quick switcher based on query
        filterQuickSwitcher(query) {
            // Only include actual notes, not images
            const notes = (this.notes || []).filter(n => n.type === 'note');
            if (!query || !query.trim()) {
                // Show recent notes when no query
                return notes.slice(0, 10);
            }
            const q = query.toLowerCase();
            return notes
                .filter(n => 
                    n.name.toLowerCase().includes(q) || 
                    n.path.toLowerCase().includes(q)
                )
                .slice(0, 10);
        },
        
        // Handle keyboard navigation in quick switcher
        handleQuickSwitcherKeydown(e) {
            const results = this.quickSwitcherResults;
            
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.quickSwitcherIndex = Math.min(this.quickSwitcherIndex + 1, results.length - 1);
                this.scrollQuickSwitcherIntoView();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.quickSwitcherIndex = Math.max(this.quickSwitcherIndex - 1, 0);
                this.scrollQuickSwitcherIntoView();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const note = results[this.quickSwitcherIndex];
                if (note) {
                    this.loadNote(note.path);
                    this.closeQuickSwitcher();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeQuickSwitcher();
            }
        },
        
        // Scroll selected item into view in quick switcher
        scrollQuickSwitcherIntoView() {
            this.$nextTick(() => {
                const items = document.querySelectorAll('[data-quick-switcher-item]');
                if (items[this.quickSwitcherIndex]) {
                    items[this.quickSwitcherIndex].scrollIntoView({ block: 'nearest' });
                }
            });
        },
        
        // Select note from quick switcher by click
        selectQuickSwitcherNote(note) {
            this.loadNote(note.path);
            this.closeQuickSwitcher();
        },
        
        // Toggle Zen Mode (full immersive writing experience)
        async toggleZenMode() {
            if (!this.zenMode) {
                // Entering Zen Mode
                this.previousViewMode = this.viewMode;
                this.viewMode = 'edit';
                this.mobileSidebarOpen = false;
                this.zenMode = true;
                
                // Request fullscreen
                try {
                    const elem = document.documentElement;
                    if (elem.requestFullscreen) {
                        await elem.requestFullscreen();
                    } else if (elem.webkitRequestFullscreen) {
                        await elem.webkitRequestFullscreen();
                    } else if (elem.msRequestFullscreen) {
                        await elem.msRequestFullscreen();
                    }
                } catch (e) {
                    // Fullscreen not supported or denied, continue anyway
                    console.log('Fullscreen not available:', e);
                }
                
                // Focus editor after transition
                setTimeout(() => {
                    const editor = document.getElementById('note-editor');
                    if (editor) editor.focus();
                }, 300);
            } else {
                // Exiting Zen Mode
                this.zenMode = false;
                this.viewMode = this.previousViewMode;
                
                // Exit fullscreen
                try {
                    if (document.exitFullscreen) {
                        await document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) {
                        await document.webkitExitFullscreen();
                    } else if (document.msExitFullscreen) {
                        await document.msExitFullscreen();
                    }
                } catch (e) {
                    console.log('Exit fullscreen error:', e);
                }
            }
        },
        
        // Homepage folder navigation methods
        goToHomepageFolder(folderPath) {
            this.showGraph = false; // Close graph when navigating
            this.selectedHomepageFolder = folderPath || '';
            this.homepageNameQuery = '';
            
            // Clear editor state to show landing page
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.closeMediaViewer();
            this.outline = [];
            this.backlinks = [];
            document.title = this.appName;
            
            // Invalidate cache to force recalculation
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            window.history.pushState({ homepageFolder: folderPath || '' }, '', '/');
        },
        
        // Navigate to homepage root and clear all editor state
        goHome() {
            this.showGraph = false; // Close graph when going home
            this.selectedHomepageFolder = '';
            this.homepageNameQuery = '';
            this.currentNote = '';
            this.currentNoteName = '';
            this.noteContent = '';
            this.closeMediaViewer();
            this.outline = [];
            this.backlinks = [];
            this.mobileSidebarOpen = false;
            document.title = this.appName;
            
            // Clear undo/redo history
            this.undoHistory = [];
            this.redoHistory = [];
            this.hasPendingHistoryChanges = false;
            
            // Invalidate cache to force recalculation
            this._homepageCache = {
                folderPath: null,
                notes: null,
                folders: null,
                breadcrumb: null
            };
            
            window.history.pushState({ homepageFolder: '' }, '', '/');
        },
        
        // Mobile files/home tab - context-aware behavior
        mobileFilesTabClick() {
            if (this.currentNote || this.currentMedia || this.showGraph) {
                // Leaving content lands in the folder the item lives in, not the vault
                // root: this tab is the only way out of a note on mobile, and dropping
                // the user at the root loses their place. Root stays one tap away on
                // the homepage breadcrumb.
                const openPath = this.currentNote || this.currentMedia;
                const parentFolder = openPath
                    ? openPath.split('/').slice(0, -1).join('/')
                    : this.selectedHomepageFolder;
                this.goToHomepageFolder(parentFolder);
                this.mobileSidebarOpen = false;
            } else {
                // On homepage → toggle files sidebar
                this.activePanel = 'files';
                this.mobileSidebarOpen = !this.mobileSidebarOpen;
            }
        },
        
        // ==================== GRAPH VIEW ====================
        
        // Initialize the graph visualization
        async initGraph() {
            this.graphError = '';
            this.graphEmpty = false;

            // vis-network (~700 KB) is fetched on first open of the graph
            // overlay — most sessions never open the graph at all.
            if (typeof vis === 'undefined') {
                if (!this._visLoadPromise) {
                    this._visLoadPromise = new Promise((resolve, reject) => {
                        const s = document.createElement('script');
                        s.src = '/static/vendor/vis-network/vis-network.min.js';
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    });
                    this._visLoadPromise.catch(() => {
                        this._visLoadPromise = null; // let the next open retry
                    });
                }
                try {
                    await this._visLoadPromise;
                } catch (e) {
                    console.error('vis-network failed to load:', e);
                    this._graphFail('graph.load_library_failed');
                    return;
                }
                if (typeof vis === 'undefined') {
                    console.error('vis-network library not loaded');
                    this._graphFail('graph.load_library_failed');
                    return;
                }
            }
            
            const requestId = (this._graphRequestId || 0) + 1;
            this._graphRequestId = requestId;
            this.graphLoaded = false;
            
            try {
                // Full map by default. The sidebar toggle asks the server to
                // leave out notes stored under any folder whose name starts with "_".
                const graphUrl = this.hideUnderscoreFolders
                    ? '/api/graph?include_system_folders=false'
                    : '/api/graph';
                const response = await fetch(graphUrl);
                if (requestId !== this._graphRequestId) return;
                if (!response.ok) throw new Error('Failed to fetch graph data');
                const data = await response.json();
                if (requestId !== this._graphRequestId) return;
                this.graphData = data;
                
                // Get container
                const container = document.getElementById('graph-overlay');
                if (!container) { this.graphLoaded = true; return; }
                
                // Nothing to draw: vis-network never emits
                // "stabilizationIterationsDone" with zero nodes, so the
                // spinner would spin forever without this early exit.
                const graphNodes = Array.isArray(data.nodes) ? data.nodes : [];
                if (graphNodes.length === 0) {
                    this.graphEmpty = true;
                    this.graphLoaded = true;
                    return;
                }
                
                // Get theme colors (force reflow to ensure CSS is applied)
                document.body.offsetHeight; // Force reflow
                const style = getComputedStyle(document.documentElement);
                
                // Helper to get CSS variable with fallback
                const getCssVar = (name, fallback) => {
                    const value = style.getPropertyValue(name).trim();
                    return value || fallback;
                };
                
                const accentPrimary = getCssVar('--accent-primary', '#7c3aed');
                const accentSecondary = getCssVar('--accent-secondary', '#a78bfa');
                const textPrimary = getCssVar('--text-primary', '#111827');
                const textSecondary = getCssVar('--text-secondary', '#6b7280');
                const bgPrimary = getCssVar('--bg-primary', '#ffffff');
                const bgSecondary = getCssVar('--bg-secondary', '#f3f4f6');
                const borderColor = getCssVar('--border-primary', '#e5e7eb');
                
                // Prepare nodes with styling - all nodes same base color
                const nodes = new vis.DataSet(graphNodes.map(n => ({
                    id: n.id,
                    label: n.label,
                    title: n.id, // Tooltip shows full path
                    color: {
                        background: accentPrimary,
                        border: accentPrimary,
                        highlight: {
                            background: accentPrimary,
                            border: textPrimary  // Darker border when selected
                        },
                        hover: {
                            background: accentSecondary,
                            border: accentPrimary
                        }
                    },
                    font: {
                        color: textPrimary,
                        size: 12,
                        face: 'system-ui, -apple-system, sans-serif'
                    },
                    borderWidth: this.currentNote === n.id ? 4 : 2,
                    chosen: {
                        node: (values) => {
                            values.size = 22;
                            values.borderWidth = 4;
                            values.borderColor = textPrimary;
                        }
                    }
                })));
                
                // Prepare edges with styling based on type
                const graphEdges = Array.isArray(data.edges) ? data.edges : [];
                const edges = new vis.DataSet(graphEdges.map((e, i) => ({
                    id: i,
                    from: e.source,
                    to: e.target,
                    color: {
                        color: e.type === 'wikilink' ? accentPrimary : borderColor,
                        highlight: accentPrimary,
                        hover: accentSecondary,
                        opacity: 0.8
                    },
                    width: e.type === 'wikilink' ? 2 : 1,
                    smooth: {
                        type: 'continuous',
                        roundness: 0.5
                    },
                    chosen: {
                        edge: (values) => {
                            values.width = 3;
                            values.color = accentPrimary;
                        }
                    }
                })));
                
                // Network options
                const options = {
                    nodes: {
                        shape: 'dot',
                        size: 16,
                        borderWidth: 2,
                        shadow: {
                            enabled: true,
                            color: 'rgba(0,0,0,0.1)',
                            size: 5,
                            x: 2,
                            y: 2
                        }
                    },
                    edges: {
                        arrows: {
                            to: {
                                enabled: true,
                                scaleFactor: 0.5,
                                type: 'arrow'
                            }
                        }
                    },
                    physics: {
                        enabled: true,
                        solver: 'forceAtlas2Based',
                        forceAtlas2Based: {
                            gravitationalConstant: -50,
                            centralGravity: 0.01,
                            springLength: 100,
                            springConstant: 0.08,
                            damping: 0.4,
                            avoidOverlap: 0.5
                        },
                        stabilization: {
                            enabled: true,
                            iterations: 200,
                            updateInterval: 25
                        }
                    },
                    interaction: {
                        hover: true,
                        tooltipDelay: 200,
                        navigationButtons: false,  // Using custom buttons instead
                        keyboard: {
                            enabled: true,
                            bindToWindow: false
                        },
                        zoomView: true,
                        dragView: true
                    },
                    layout: {
                        improvedLayout: true,
                        randomSeed: 42
                    }
                };
                
                // Destroy existing instance if any
                if (this.graphInstance) {
                    this.graphInstance.destroy();
                    this.graphInstance = null;
                }
                
                // Clear container to ensure clean state
                const graphCanvas = container.querySelector('canvas');
                if (graphCanvas) graphCanvas.remove();
                const visElements = container.querySelectorAll('.vis-network, .vis-navigation');
                visElements.forEach(el => el.remove());
                
                // Create the network
                this.graphInstance = new vis.Network(container, { nodes, edges }, options);
                
                // Store reference for callbacks
                const graphRef = this.graphInstance;
                const currentNoteRef = this.currentNote;
                
                // Hide the spinner exactly once, whenever stabilization ends.
                let finished = false;
                let safetyTimer = null;
                const finishGraphLoad = () => {
                    if (finished) return;
                    finished = true;
                    if (safetyTimer) clearTimeout(safetyTimer);
                    if (requestId !== this._graphRequestId) return;
                    
                    try {
                        graphRef.setOptions({ physics: { enabled: false } });
                    } catch (e) {
                        // Graph may already have been destroyed
                    }
                    this.graphLoaded = true;
                    
                    // Focus and select current note if one is loaded
                    if (currentNoteRef) {
                        setTimeout(() => {
                            try {
                                if (graphRef && this.showGraph) {
                                    const nodeIds = graphRef.body.data.nodes.getIds();
                                    if (nodeIds.includes(currentNoteRef)) {
                                        // Focus on the node
                                        graphRef.focus(currentNoteRef, {
                                            scale: 1.2,
                                            animation: {
                                                duration: 500,
                                                easingFunction: 'easeInOutQuad'
                                            }
                                        });
                                        // Select the node to highlight it
                                        graphRef.selectNodes([currentNoteRef]);
                                    }
                                }
                            } catch (e) {
                                // Ignore - graph may have been destroyed
                            }
                        }, 150);
                    }
                };
                
                // "stabilizationIterationsDone" is the normal path, but
                // vis-network can skip it entirely (0 nodes, a physics pass
                // that never settles, …). Without this fallback the overlay
                // would show "Loading graph..." forever.
                safetyTimer = setTimeout(finishGraphLoad, 10000);
                this.graphInstance.once('stabilizationIterationsDone', finishGraphLoad);
                this.graphInstance.once('stabilized', finishGraphLoad);
                
                // Click event - open note
                this.graphInstance.on('click', (params) => {
                    if (params.nodes.length > 0) {
                        const noteId = params.nodes[0];
                        this.loadNote(noteId);
                        // Node is already selected by vis-network on click, no need to call selectNodes
                    }
                });
                
                // Double-click event - open note and close graph
                this.graphInstance.on('doubleClick', (params) => {
                    if (params.nodes.length > 0) {
                        const noteId = params.nodes[0];
                        // Close graph and load note
                        this.showGraph = false;
                        this.loadNote(noteId);
                    }
                });
                
                // Hover event - highlight connections
                this.graphInstance.on('hoverNode', (params) => {
                    const nodeId = params.node;
                    const connectedNodes = this.graphInstance.getConnectedNodes(nodeId);
                    const connectedEdges = this.graphInstance.getConnectedEdges(nodeId);
                    
                    // Dim all nodes except hovered and connected
                    const allNodes = nodes.getIds();
                    const updates = allNodes.map(id => ({
                        id,
                        opacity: (id === nodeId || connectedNodes.includes(id)) ? 1 : 0.2
                    }));
                    nodes.update(updates);
                });
                
                this.graphInstance.on('blurNode', () => {
                    // Reset all nodes to full opacity
                    const allNodes = nodes.getIds();
                    const updates = allNodes.map(id => ({ id, opacity: 1 }));
                    nodes.update(updates);
                });
                
                // Add legend to container
                this.addGraphLegend(container, accentPrimary, borderColor, textSecondary);
                
            } catch (error) {
                if (requestId !== this._graphRequestId) return;
                console.error('Failed to initialize graph:', error);
                this._graphFail('graph.load_failed');
            }
        },
        
        // Stop the overlay spinner and surface a message instead of failing
        // silently (a bare console.error left "Loading graph..." up forever).
        _graphFail(messageKey) {
            this.graphLoaded = true;
            this.graphError = this.t(messageKey);
        },
        
        // Add legend to graph container
        addGraphLegend(container, wikiColor, mdColor, textColor) {
            // Remove existing legend if any
            const existingLegend = container.querySelector('.graph-legend');
            if (existingLegend) existingLegend.remove();
            
            const legend = document.createElement('div');
            legend.className = 'graph-legend';
            legend.innerHTML = `
                <div class="graph-legend-item">
                    <span class="graph-legend-dot" style="background: ${wikiColor};"></span>
                    <span style="color: ${textColor};">Wikilinks</span>
                </div>
                <div class="graph-legend-item">
                    <span class="graph-legend-dot" style="background: ${mdColor};"></span>
                    <span style="color: ${textColor};">${this.t('graph.markdown_links')}</span>
                </div>
                <div style="margin-top: 8px; font-size: 10px; color: ${textColor}; opacity: 0.7;">
                    ${this.t('graph.click_hint')}
                </div>
            `;
            container.appendChild(legend);
        },
        
        // Refresh graph when theme changes
        refreshGraph() {
            // The graph lives in its own overlay (showGraph), not in viewMode —
            // the old `viewMode === 'graph'` test was never true, so themes
            // never re-rendered the map.
            if (this.showGraph) {
                this.initGraph();
            }
        }
    }
}
