// Basalt Frontend Application

// Modular sources live in src/; build-js.sh bundles them into app.js.
// Pure modules (config, utils, lib/*) have no DOM or Alpine dependency and are
// covered by node --test (see test/).
import { createWikilink } from './app/wikilink.js';
import { createScrollSync } from './app/scroll-sync.js';
import { createState } from './app/state.js';
import { createQuickSwitcher } from './app/quick-switcher.js';
import { createMedia } from './app/media.js';
import { createSearch } from './app/search.js';
import { createBootstrap } from './app/bootstrap.js';
import { createNotes } from './app/notes.js';
import { createPreview } from './app/preview.js';
import { createGraph } from './app/graph.js';
import { createEditor } from './app/editor.js';
import { createLinkPreview } from './app/link-preview.js';
import { createHomepage } from './app/homepage.js';
import { createSidebar } from './app/sidebar.js';
import { createUi } from './app/ui.js';

// Composition root: each feature slice owns a group of methods (and
// state.js owns the data fields). compose() copies property descriptors so
// `get` accessors stay getters instead of being evaluated once.
function compose(...slices) {
    const out = {};
    for (const slice of slices) {
        Object.defineProperties(out, Object.getOwnPropertyDescriptors(slice));
    }
    return out;
}

function noteApp() {
    return compose(
        createWikilink(),
        createScrollSync(),
        createState(),
        createQuickSwitcher(),
        createMedia(),
        createSearch(),
        createBootstrap(),
        createNotes(),
        createPreview(),
        createGraph(),
        createEditor(),
        createLinkPreview(),
        createHomepage(),
        createSidebar(),
        createUi(),
    );
}

// index.html uses x-data="noteApp()": the iife bundle is not global by default.
window.noteApp = noteApp;
