// Media upload (drag/drop, paste) and the media viewer.
//
// Split out of the former monolith src/main.js; noteApp() in main.js composes
// this factory's object with the other feature slices (see compose()).

const MEDIA_FORMATS_DISPLAY = 'JPG, PNG, GIF, WebP, MP3, MP4, PDF, MD';

import { ErrorHandler, encodeVaultPath, FilenameValidator } from '../core/utils.js';
import * as api from '../core/api.js';
import { typeIconSvg } from '../lib/file-icons.js';

export function createMedia() {
    return {
        
        
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
         * Global picker (sidebar / homepage buttons): upload files from anywhere,
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
         * Toolbar attach button: upload the files picked in the dialog and insert
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
                const data = await api.sendJSON(`/api/notes/${encodeVaultPath(targetPath)}`, 'POST', { content });
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
            
            const data = await api.sendJSON('/api/upload-media', 'POST', formData);
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
        
        // Inline SVG icon for any file type (notes, media and PDFs).
        getMediaIcon(type) {
            return typeIconSvg(type);
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
                await api.send(`/api/notes/${encodeURIComponent(mediaPath)}`, 'DELETE');
            } catch (error) {
                ErrorHandler.handle('delete media', error);
                await this.loadNotes({ silent: true });
            }
        },

        // Open the rename dialog for a media file. The extension is kept
        // automatically, so the user edits only the visible stem.
        renameMedia(mediaPath) {
            const filename = mediaPath.split('/').pop();
            const dot = filename.lastIndexOf('.');
            const extension = dot > 0 ? filename.slice(dot) : '';
            const stem = dot > 0 ? filename.slice(0, dot) : filename;

            this.renameMediaPath = mediaPath;
            this.renameMediaOldName = filename;
            this.renameMediaExtension = extension;
            this.renameMediaInput = stem;
            this.showRenameMediaModal = true;
            this.mobileSidebarOpen = false;
            this.$nextTick(() => {
                const el = document.getElementById('rename-media-modal-input');
                if (el) {
                    el.focus();
                    el.select();
                }
            });
        },

        closeRenameMediaModal() {
            this.showRenameMediaModal = false;
            this.renameMediaPath = '';
            this.renameMediaOldName = '';
            this.renameMediaExtension = '';
            this.renameMediaInput = '';
        },

        cancelRenameMediaModal() {
            this.closeRenameMediaModal();
        },

        async submitRenameMediaModal() {
            const oldPath = this.renameMediaPath;
            const extension = this.renameMediaExtension;
            const newStem = (this.renameMediaInput || '').trim();
            if (!oldPath) return;
            if (!newStem) {
                this.toast(this.t('media.invalid_name'), { type: 'warning' });
                return;
            }

            const validation = FilenameValidator.validateFilename(newStem);
            if (!validation.valid) {
                this.toast(this.getValidationErrorMessage(validation, 'note'), { type: 'warning' });
                return;
            }

            const filename = validation.sanitized + extension;
            const folder = oldPath.split('/').slice(0, -1).join('/');
            const newPath = folder ? `${folder}/${filename}` : filename;
            if (newPath === oldPath) {
                this.closeRenameMediaModal();
                return;
            }
            if (this.notePathTaken(newPath)) {
                this.toast(this.t('media.already_exists', { name: filename }), { type: 'warning' });
                return;
            }

            const wasCurrentMedia = this.currentMedia === oldPath;
            this._optimisticRenameNote(oldPath, newPath);
            this._rebuildTreeAfterMutation();
            if (wasCurrentMedia) {
                this.currentMedia = newPath;
                document.title = `${filename} - ${this.appName}`;
            }

            try {
                await api.sendJSON('/api/media/move', 'POST', { oldPath, newPath });
                await this.loadNotes({ silent: true });
                this.closeRenameMediaModal();
            } catch (error) {
                ErrorHandler.handle('rename media', error);
                await this.loadNotes({ silent: true });
            }
        },
    };
}
