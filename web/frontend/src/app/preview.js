// Markdown preview rendering, math, mermaid and code blocks.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import * as api from '../core/api.js';
import { encodeVaultPath } from '../core/utils.js';
import { scanTaskLines, toggleTaskAt, setAllTasks } from '../lib/tasks.js';
import { typeIconSvg } from '../lib/file-icons.js';

export function createPreview() {
    return {
        
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

            const result = setAllTasks(this.noteContent, index);
            if (!result.found) return false;
            if (!result.changed) return true;

            this.noteContent = result.text;
            this.autoSave();
            this.toast(
                this.t(result.nextState === 'x' ? 'editor.tasks_all_checked' : 'editor.tasks_all_unchecked',
                    { changed: result.changeCount, total: result.total })
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
                const response = await api.raw('/api/notes/replace', {
                    method: 'POST',
                    json: { path: this.currentNote, old_str: oldLine, new_str: newLine }
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
            const result = toggleTaskAt(this.noteContent, index);
            if (!result.changed) return false;

            this.noteContent = result.text;
            if (!this.isUndoRedo) this.pushToHistory();
            this.lastSaved = false;
            this._persistTaskToggle(result.oldLine, result.newLine);
            return true;
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
                        errorMsg.textContent = `Mermaid diagram error: ${error.message}`;
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
                const svg = (paths) => '<svg class="callout-icon-svg" viewBox="0 0 24 24" '
                    + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
                    + 'stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
                const CALLOUT_ICONS = {
                    note: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
                    tip: svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'),
                    important: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
                    warning: svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
                    caution: svg('<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2z"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
                };
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
                    const icon = typeIconSvg(mediaType || 'image');
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
                        link.innerHTML = '<span class="pdf-link-content">'
                            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                            + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'
                            + '</svg> ' + safeAlt + '</span><span class="pdf-link-note">Opens in new tab</span>';
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
            return scanTaskLines(source);
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
                const encodedPath = encodeVaultPath(this.currentNote);
                const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}`;
                
                // Fetch the exported HTML from backend
                // Needs the raw response for Content-Disposition + blob().
                const response = await api.raw(url);
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
            const encodedPath = encodeVaultPath(this.currentNote);
            const url = `/api/export/${encodedPath}?theme=${encodeURIComponent(currentTheme)}&download=false`;
            
            // Open in new window/tab
            window.open(url, '_blank');
        },
    };
}
