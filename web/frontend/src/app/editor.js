// Editor input handling, text formatting and undo/redo history.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

import { applyEditorOutdent } from '../lib/editor.js';

export function createEditor() {
    return {

        // Handle Tab key in editor (inserts tab; Shift+Tab outdents matching lines)
        handleTabKey(event) {
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
    };
}
