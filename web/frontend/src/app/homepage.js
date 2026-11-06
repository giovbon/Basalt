// Homepage grid, breadcrumbs and folder navigation.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';
import { readLocalSettings, saveSetting } from '../core/settings.js';

export function createHomepage() {
    return {
        
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
            
            const breadcrumb = [];
            
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
            saveSetting('homepageView', mode, LOCAL_SETTINGS);
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
        
        // Check if app is empty (no notes and no folders)
        get isAppEmpty() {
            const notesArray = Array.isArray(this.notes) ? this.notes : [];
            const foldersArray = Array.isArray(this.allFolders) ? this.allFolders : [];
            return notesArray.length === 0 && foldersArray.length === 0;
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
        
        // Homepage folder navigation methods
        goToHomepageFolder(folderPath) {
            this.showGraph = false; // Close graph when navigating
            this.selectedHomepageFolder = folderPath || '';
            this.homepageNameQuery = '';
            
            // Clear editor state to show landing page
            this._resetNoteState();
            
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
            this._resetNoteState();
            this.mobileSidebarOpen = false;
            
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
    };
}
