// Editor<->preview scroll synchronisation and anchor mapping.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { CONFIG, LOCAL_SETTINGS } from '../core/config.js';

export function createScrollSync() {
    return {
        
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
    };
}
