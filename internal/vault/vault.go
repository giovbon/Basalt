package vault

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	wikilinkRe = regexp.MustCompile(`\[\[([^\]|]+)(?:\|[^\]]+)?\]\]`)
	mdlinkRe   = regexp.MustCompile(`\[([^\]]+)\]\(([^\)]+)\)`)
)

func isExternalOrFragmentLink(target string) bool {
	t := strings.TrimSpace(strings.ToLower(target))
	return strings.HasPrefix(t, "http://") ||
		strings.HasPrefix(t, "https://") ||
		strings.HasPrefix(t, "mailto:") ||
		strings.HasPrefix(t, "#") ||
		strings.HasPrefix(t, "data:")
}

type NoteRecord struct {
	Name     string   `json:"name"`
	Path     string   `json:"path"`
	Folder   string   `json:"folder"`
	Modified string   `json:"modified"`
	Size     int64    `json:"size"`
	Type     string   `json:"type"`
	Tags     []string `json:"tags"`
	MTime    float64  `json:"-"`
}

type NoteMetadata struct {
	Created  string `json:"created"`
	Modified string `json:"modified"`
	Size     int64  `json:"size"`
	Lines    int    `json:"lines"`
}

type BacklinkRef struct {
	LineNumber int    `json:"line_number"`
	Context    string `json:"context"`
	Type       string `json:"type"`
}

type BacklinkItem struct {
	Path       string        `json:"path"`
	Name       string        `json:"name"`
	References []BacklinkRef `json:"references"`
}

type GraphNode struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type GraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
}

type GraphData struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

type Vault struct {
	notesDir string
	mu       sync.RWMutex
}

func New(notesDir string) *Vault {
	return &Vault{
		notesDir: filepath.Clean(notesDir),
	}
}

func (v *Vault) NotesDir() string {
	return v.notesDir
}

// EnsureDirectories creates the root notesDir if it does not exist
func (v *Vault) EnsureDirectories() error {
	return os.MkdirAll(v.notesDir, 0755)
}

// ValidatePathSecurity checks that resolved path is safely inside notesDir
func (v *Vault) ValidatePathSecurity(targetPath string) bool {
	absBase, err := filepath.Abs(v.notesDir)
	if err != nil {
		return false
	}
	absTarget, err := filepath.Abs(targetPath)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absBase, absTarget)
	if err != nil {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

func (v *Vault) FullPath(relPath string) string {
	cleanRel := filepath.Clean(strings.ReplaceAll(relPath, "\\", "/"))
	cleanRel = strings.TrimPrefix(cleanRel, "/")
	return filepath.Join(v.notesDir, cleanRel)
}

func NormalizedRelPath(p string) string {
	return strings.Trim(strings.ReplaceAll(p, "\\", "/"), "/")
}

func PathHasHash(p string) bool {
	return strings.Contains(p, "#")
}

func ContentHash(content string) string {
	// Normalize CRLF to LF
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	hasher := sha256.New()
	hasher.Write([]byte(normalized))
	return hex.EncodeToString(hasher.Sum(nil))
}

// FormatTime formats timestamp to Python isoformat UTC with microsecond parity
func FormatTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.999999+00:00")
}

// MatchingChild checks case-insensitively for an existing child file or directory
func (v *Vault) MatchingChild(parent string, name string, wantDir bool) string {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return ""
	}
	folded := strings.ToLower(name)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || (info.Mode()&os.ModeSymlink != 0) {
			continue
		}
		isDir := entry.IsDir()
		if isDir != wantDir {
			continue
		}
		if entry.Name() == name {
			return entry.Name()
		}
		if strings.ToLower(entry.Name()) == folded {
			return entry.Name()
		}
	}
	return ""
}

func (v *Vault) NoteExistsExact(notePath string) bool {
	full := v.FullPath(notePath)
	st, err := os.Lstat(full)
	if err != nil {
		return false
	}
	return !st.IsDir() && (st.Mode()&os.ModeSymlink == 0)
}

func (v *Vault) FolderExistsExact(folderPath string) bool {
	if folderPath == "" || folderPath == "." {
		return true
	}
	full := v.FullPath(folderPath)
	st, err := os.Lstat(full)
	if err != nil {
		return false
	}
	return st.IsDir() && (st.Mode()&os.ModeSymlink == 0)
}

func (v *Vault) NoteNameConflict(notePath string) string {
	clean := NormalizedRelPath(notePath)
	if clean == "" {
		return ""
	}
	parts := strings.Split(clean, "/")
	currentDir := v.notesDir
	var resolved []string

	for i, segment := range parts {
		isLast := (i == len(parts)-1)
		child := v.MatchingChild(currentDir, segment, !isLast)
		if child == "" {
			return ""
		}
		resolved = append(resolved, child)
		currentDir = filepath.Join(currentDir, child)
	}

	found := strings.Join(resolved, "/")
	if found != clean {
		return found
	}
	return ""
}

func (v *Vault) FolderNameConflict(folderPath string) string {
	clean := NormalizedRelPath(folderPath)
	if clean == "" {
		return ""
	}
	parts := strings.Split(clean, "/")
	currentDir := v.notesDir
	var resolved []string

	for _, segment := range parts {
		child := v.MatchingChild(currentDir, segment, true)
		if child == "" {
			return ""
		}
		resolved = append(resolved, child)
		currentDir = filepath.Join(currentDir, child)
	}

	found := strings.Join(resolved, "/")
	if found != clean {
		return found
	}
	return ""
}

// ParseTags extracts tags from a note's YAML frontmatter.
//
// Supported shapes (key matched case-insensitively, "tags" or "tag"):
//
//	tags: [a, b]
//	tags: a
//	tags:
//	  - a
//
// It tolerates a UTF-8 BOM and blank lines before the opening "---" (common
// in files saved by Windows editors) and strips quotes around values, so the
// same note parses identically no matter which editor wrote it.
func ParseTags(content string) []string {
	// Windows editors often prepend a UTF-8 BOM. TrimSpace does NOT remove
	// U+FEFF (it is a format character, not whitespace), so strip it first —
	// otherwise every check below fails and the note reports zero tags.
	content = strings.TrimPrefix(content, "\ufeff")

	// Parse from the trimmed content so leading/trailing blank lines cannot
	// break the first-line "---" check.
	trimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmed, "---") {
		return []string{}
	}

	lines := strings.Split(trimmed, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return []string{}
	}

	endIdx := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			endIdx = i
			break
		}
	}
	if endIdx == -1 {
		return []string{}
	}

	fmLines := lines[1:endIdx]
	var rawTags []string
	inTagsList := false

	// Normalize one raw tag value: trim, drop surrounding quotes, lowercase.
	cleanTag := func(t string) string {
		t = strings.ToLower(strings.TrimSpace(t))
		if len(t) >= 2 {
			if q := t[0]; (q == '"' || q == '\'') && t[len(t)-1] == q {
				t = strings.TrimSpace(t[1 : len(t)-1])
			}
		}
		return t
	}

	for _, line := range fmLines {
		stripped := strings.TrimSpace(line)

		if !inTagsList {
			key, rest, hasKey := strings.Cut(stripped, ":")
			if !hasKey {
				continue
			}
			key = strings.ToLower(strings.TrimSpace(key))
			if key != "tags" && key != "tag" {
				continue
			}

			rest = strings.TrimSpace(rest)
			if strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]") {
				for _, p := range strings.Split(rest[1:len(rest)-1], ",") {
					if t := cleanTag(p); t != "" {
						rawTags = append(rawTags, t)
					}
				}
				break
			} else if rest != "" {
				if t := cleanTag(rest); t != "" {
					rawTags = append(rawTags, t)
				}
				break
			}
			inTagsList = true
			continue
		}

		// Inside a multiline "tags:" block.
		if strings.HasPrefix(stripped, "-") {
			if t := cleanTag(strings.TrimPrefix(stripped, "-")); t != "" {
				rawTags = append(rawTags, t)
			}
		} else if stripped != "" && !strings.HasPrefix(stripped, "#") {
			break
		}
	}

	// Unique & sort
	tagMap := make(map[string]struct{})
	for _, t := range rawTags {
		tagMap[t] = struct{}{}
	}
	result := make([]string, 0, len(tagMap))
	for t := range tagMap {
		result = append(result, t)
	}
	sort.Strings(result)
	return result
}

func (v *Vault) GetNoteContent(notePath string) (string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return "", os.ErrNotExist
	}
	info, err := os.Stat(fullPath)
	if err != nil || info.IsDir() {
		return "", os.ErrNotExist
	}

	data, err := os.ReadFile(fullPath)
	if err != nil {
		return "", err
	}
	// Normalize CRLF to LF
	return strings.ReplaceAll(string(data), "\r\n", "\n"), nil
}

func (v *Vault) SaveNote(notePath string, content string) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return fmt.Errorf("invalid path security")
	}

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	// Python writes UTF-8 string directly
	return os.WriteFile(fullPath, []byte(content), 0644)
}

func (v *Vault) DeleteNote(notePath string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()

	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return false
	}
	if err := os.Remove(fullPath); err != nil {
		return false
	}
	return true
}

func (v *Vault) MoveNote(oldPath, newPath string) (bool, string) {
	v.mu.Lock()
	defer v.mu.Unlock()

	oldFull := v.FullPath(oldPath)
	newFull := v.FullPath(newPath)

	if !v.ValidatePathSecurity(oldFull) {
		return false, "Invalid source path"
	}
	if !v.ValidatePathSecurity(newFull) {
		return false, "Invalid destination path"
	}
	if _, err := os.Stat(oldFull); err != nil {
		return false, fmt.Sprintf("Source note does not exist: %s", oldPath)
	}
	if _, err := os.Stat(newFull); err == nil {
		return false, fmt.Sprintf("A note already exists at: %s", newPath)
	}

	conflict := v.NoteNameConflict(newPath)
	if conflict != "" && strings.ToLower(NormalizedRelPath(conflict)) != strings.ToLower(NormalizedRelPath(oldPath)) {
		return false, fmt.Sprintf("A note already exists at: %s", conflict)
	}

	if err := os.MkdirAll(filepath.Dir(newFull), 0755); err != nil {
		return false, fmt.Sprintf("Failed to move file: %s", err.Error())
	}

	if err := os.Rename(oldFull, newFull); err != nil {
		return false, fmt.Sprintf("Failed to move file: %s", err.Error())
	}
	return true, ""
}

func (v *Vault) CreateFolder(folderPath string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()

	fullPath := v.FullPath(folderPath)
	if !v.ValidatePathSecurity(fullPath) {
		return false
	}
	err := os.MkdirAll(fullPath, 0755)
	return err == nil
}

func (v *Vault) MoveFolder(oldPath, newPath string) (bool, string) {
	v.mu.Lock()
	defer v.mu.Unlock()

	oldFull := v.FullPath(oldPath)
	newFull := v.FullPath(newPath)

	if !v.ValidatePathSecurity(oldFull) {
		return false, "Invalid source path"
	}
	if !v.ValidatePathSecurity(newFull) {
		return false, "Invalid destination path"
	}
	info, err := os.Stat(oldFull)
	if err != nil || !info.IsDir() {
		return false, fmt.Sprintf("Source folder does not exist: %s", oldPath)
	}
	if _, err := os.Stat(newFull); err == nil {
		return false, fmt.Sprintf("A folder already exists at: %s", newPath)
	}

	conflict := v.FolderNameConflict(newPath)
	if conflict != "" && strings.ToLower(NormalizedRelPath(conflict)) != strings.ToLower(NormalizedRelPath(oldPath)) {
		return false, fmt.Sprintf("A folder already exists at: %s", conflict)
	}

	if err := os.MkdirAll(filepath.Dir(newFull), 0755); err != nil {
		return false, fmt.Sprintf("Failed to move folder: %s", err.Error())
	}

	if err := os.Rename(oldFull, newFull); err != nil {
		return false, fmt.Sprintf("Failed to move folder: %s", err.Error())
	}
	return true, ""
}

func (v *Vault) DeleteFolder(folderPath string) bool {
	v.mu.Lock()
	defer v.mu.Unlock()

	fullPath := v.FullPath(folderPath)
	if !v.ValidatePathSecurity(fullPath) {
		return false
	}
	info, err := os.Stat(fullPath)
	if err != nil || !info.IsDir() {
		return false
	}
	return os.RemoveAll(fullPath) == nil
}

func (v *Vault) ResolveVaultFolder(folderPath string) (string, error) {
	parts := strings.Split(strings.ReplaceAll(folderPath, "\\", "/"), "/")
	for _, part := range parts {
		if strings.HasPrefix(part, ".") {
			return "", os.ErrNotExist
		}
	}
	target := v.FullPath(folderPath)
	if !v.ValidatePathSecurity(target) {
		return "", os.ErrNotExist
	}
	st, err := os.Lstat(target)
	if err != nil || !st.IsDir() || (st.Mode()&os.ModeSymlink != 0) {
		return "", os.ErrNotExist
	}
	return target, nil
}

func (v *Vault) CollectFolderFiles(folder string) ([]string, int64, error) {
	var files []string
	var totalBytes int64

	err := filepath.WalkDir(folder, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || (info.Mode()&os.ModeSymlink != 0) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			files = append(files, path)
			totalBytes += info.Size()
		}
		return nil
	})
	return files, totalBytes, err
}

func (v *Vault) CreateNoteMetadata(notePath string) NoteMetadata {
	fullPath := v.FullPath(notePath)
	if !v.ValidatePathSecurity(fullPath) {
		return NoteMetadata{}
	}

	info, err := os.Stat(fullPath)
	if err != nil || info.IsDir() {
		return NoteMetadata{}
	}

	createdTime := info.ModTime()
	if sys := info.Sys(); sys != nil {
		if stat, ok := sys.(*syscall.Stat_t); ok {
			createdTime = time.Unix(stat.Ctim.Sec, stat.Ctim.Nsec)
		}
	}

	file, err := os.Open(fullPath)
	if err != nil {
		return NoteMetadata{}
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	lineCount := 0
	for scanner.Scan() {
		lineCount++
	}

	return NoteMetadata{
		Created:  FormatTime(createdTime),
		Modified: FormatTime(info.ModTime()),
		Size:     info.Size(),
		Lines:    lineCount,
	}
}

// Media handling
var mediaExtensions = map[string][]string{
	"image":    {".jpg", ".jpeg", ".png", ".gif", ".webp"},
	"audio":    {".mp3", ".wav", ".ogg", ".m4a"},
	"video":    {".mp4", ".webm", ".mov", ".avi"},
	"document": {".pdf"},
}

func GetMediaType(filename string) string {
	nameLower := strings.ToLower(filepath.Base(filename))
	if strings.HasPrefix(nameLower, "drawing-") && strings.HasSuffix(nameLower, ".png") {
		return "drawing"
	}
	ext := strings.ToLower(filepath.Ext(filename))
	for mediaType, exts := range mediaExtensions {
		for _, e := range exts {
			if ext == e {
				return mediaType
			}
		}
	}
	return ""
}

func AllMediaExtensions() map[string]struct{} {
	all := make(map[string]struct{})
	for _, exts := range mediaExtensions {
		for _, e := range exts {
			all[e] = struct{}{}
		}
	}
	return all
}

var sanitizeRe = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)
var multiUnderscores = regexp.MustCompile(`_+`)

func SanitizeFilename(filename string) string {
	if filename == "" {
		return filename
	}
	ext := filepath.Ext(filename)
	stem := strings.TrimSuffix(filename, ext)

	name := sanitizeRe.ReplaceAllString(stem, "_")
	name = multiUnderscores.ReplaceAllString(name, "_")
	name = strings.Trim(name, "_ ")
	if name == "" {
		name = "unnamed"
	}
	return name + ext
}

func (v *Vault) GetAttachmentDir(notePath string) string {
	if notePath == "" {
		return filepath.Join(v.notesDir, "_attachments")
	}
	clean := strings.ReplaceAll(notePath, "\\", "/")
	dir := filepath.Dir(clean)
	if dir == "." || dir == "" {
		return filepath.Join(v.notesDir, "_attachments")
	}
	return filepath.Join(v.notesDir, dir, "_attachments")
}

func (v *Vault) SaveUploadedImage(notePath string, filename string, data []byte, siblingFolder *string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	timestamp := time.Now().Format("20060102150405")

	if siblingFolder != nil {
		cf := strings.TrimSpace(strings.ReplaceAll(*siblingFolder, "\\", "/"))
		segments := []string{}
		for _, s := range strings.Split(cf, "/") {
			if s != "" && s != "." {
				if s == ".." {
					return "", fmt.Errorf("invalid path")
				}
				segments = append(segments, s)
			}
		}
		destDir := v.notesDir
		if len(segments) > 0 {
			destDir = filepath.Join(v.notesDir, filepath.Join(segments...))
		}
		if !v.ValidatePathSecurity(destDir) {
			return "", fmt.Errorf("security validation failed")
		}
		if err := os.MkdirAll(destDir, 0755); err != nil {
			return "", err
		}
		fileName := fmt.Sprintf("drawing-%s.png", timestamp)
		fullPath := filepath.Join(destDir, fileName)
		if !v.ValidatePathSecurity(fullPath) {
			return "", fmt.Errorf("security validation failed")
		}
		if err := os.WriteFile(fullPath, data, 0644); err != nil {
			return "", err
		}
		rel, _ := filepath.Rel(v.notesDir, fullPath)
		return strings.ReplaceAll(rel, "\\", "/"), nil
	}

	sanitized := SanitizeFilename(filename)
	ext := filepath.Ext(sanitized)
	stem := strings.TrimSuffix(sanitized, ext)
	finalFilename := fmt.Sprintf("%s-%s%s", stem, timestamp, ext)

	attachDir := v.GetAttachmentDir(notePath)
	if err := os.MkdirAll(attachDir, 0755); err != nil {
		return "", err
	}
	fullPath := filepath.Join(attachDir, finalFilename)
	if !v.ValidatePathSecurity(fullPath) {
		return "", fmt.Errorf("security validation failed")
	}
	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(v.notesDir, fullPath)
	return strings.ReplaceAll(rel, "\\", "/"), nil
}

// ScanNotes traverses the vault skipping dot directories/files and symlinks.
func (v *Vault) ScanNotes(includeMedia bool) ([]NoteRecord, []string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	var notes []NoteRecord = []NoteRecord{}
	folderSet := make(map[string]struct{})

	err := filepath.WalkDir(v.notesDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || (info.Mode()&os.ModeSymlink != 0) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		relPath, err := filepath.Rel(v.notesDir, path)
		if err != nil {
			return nil
		}
		relStr := strings.ReplaceAll(relPath, "\\", "/")

		if d.IsDir() {
			if relStr != "." && relStr != "" {
				folderSet[relStr] = struct{}{}
			}
			return nil
		}

		mediaType := ""
		if includeMedia {
			mediaType = GetMediaType(name)
		}
		isMarkdown := strings.ToLower(filepath.Ext(name)) == ".md"
		shouldInclude := isMarkdown || (includeMedia && mediaType != "")
		if !shouldInclude {
			return nil
		}

		parentFolder := filepath.Dir(relStr)
		if parentFolder == "." {
			parentFolder = ""
		}

		itemType := "note"
		if mediaType != "" {
			itemType = mediaType
		}

		var tags []string
		if isMarkdown {
			if data, err := os.ReadFile(path); err == nil {
				tags = ParseTags(string(data))
			}
		}

		notes = append(notes, NoteRecord{
			Name:     strings.TrimSuffix(name, filepath.Ext(name)),
			Path:     relStr,
			Folder:   parentFolder,
			Modified: FormatTime(info.ModTime()),
			Size:     info.Size(),
			Type:     itemType,
			Tags:     tags,
			MTime:    float64(info.ModTime().UnixNano()) / 1e9,
		})
		return nil
	})

	if err != nil {
		return nil, nil, err
	}

	folders := make([]string, 0, len(folderSet))
	for f := range folderSet {
		folders = append(folders, f)
	}
	sort.Strings(folders)

	return notes, folders, nil
}

// Backlinks resolution
func (v *Vault) GetBacklinks(targetNotePath string) []BacklinkItem {
	targetPath := targetNotePath
	targetPathLower := strings.ToLower(targetPath)
	targetPathNoExtLower := strings.TrimSuffix(targetPathLower, ".md")
	stemLower := strings.ToLower(strings.TrimSuffix(filepath.Base(targetPath), filepath.Ext(targetPath)))

	wikilinkRefs := map[string]struct{}{
		targetPathLower:      {},
		targetPathNoExtLower: {},
		stemLower:            {},
	}

	notes, _, err := v.ScanNotes(false)
	if err != nil {
		return []BacklinkItem{}
	}

	// Sort notes by MTime descending
	sort.Slice(notes, func(i, j int) bool {
		return notes[i].MTime > notes[j].MTime
	})

	var backlinks []BacklinkItem
	for _, note := range notes {
		if note.Path == targetPath {
			continue
		}
		content, err := v.GetNoteContent(note.Path)
		if err != nil {
			continue
		}

		refs := extractBacklinkReferences(note.Path, targetPath, targetPathLower, targetPathNoExtLower, wikilinkRefs, content)
		if len(refs) > 0 {
			if len(refs) > 3 {
				refs = refs[:3]
			}
			backlinks = append(backlinks, BacklinkItem{
				Path:       note.Path,
				Name:       strings.TrimSuffix(note.Name, ".md"),
				References: refs,
			})
		}
	}
	return backlinks
}

func extractBacklinkReferences(
	sourcePath string,
	targetPath string,
	targetPathLower string,
	targetPathNoExtLower string,
	wikilinkRefs map[string]struct{},
	content string,
) []BacklinkRef {
	sourceFolder := strings.ReplaceAll(filepath.Dir(sourcePath), "\\", "/")
	if sourceFolder == "." {
		sourceFolder = ""
	}

	lines := strings.Split(content, "\n")
	var found []BacklinkRef

	for lineNum, line := range lines {
		num := lineNum + 1

		// Wikilinks
		for _, match := range wikilinkRe.FindAllStringSubmatchIndex(line, -1) {
			rawTarget := line[match[2]:match[3]]
			targetLower := strings.ToLower(strings.TrimSpace(rawTarget))
			targetNoExt := strings.TrimSuffix(targetLower, ".md")

			_, in1 := wikilinkRefs[targetLower]
			_, in2 := wikilinkRefs[targetNoExt]
			if in1 || in2 {
				start := match[0] - 30
				if start < 0 {
					start = 0
				}
				end := match[1] + 30
				if end > len(line) {
					end = len(line)
				}
				ctx := line[start:end]
				if start > 0 {
					ctx = "..." + ctx
				}
				if end < len(line) {
					ctx = ctx + "..."
				}
				found = append(found, BacklinkRef{
					LineNumber: num,
					Context:    ctx,
					Type:       "wikilink",
				})
			}
		}

		// Markdown links
		for _, match := range mdlinkRe.FindAllStringSubmatchIndex(line, -1) {
			rawTarget := line[match[4]:match[5]]
			if isExternalOrFragmentLink(rawTarget) {
				continue
			}
			parts := strings.Split(rawTarget, "#")
			linkPath := parts[0]
			if linkPath == "" {
				continue
			}
			if u, err := url.PathUnescape(linkPath); err == nil {
				linkPath = u
			}
			if strings.HasPrefix(linkPath, "./") {
				linkPath = linkPath[2:]
			}
			linkPathWithMD := linkPath
			if !strings.HasSuffix(linkPathWithMD, ".md") {
				linkPathWithMD += ".md"
			}

			var resolvedPath string
			if sourceFolder != "" && !strings.HasPrefix(linkPath, "/") {
				relPath := fmt.Sprintf("%s/%s", sourceFolder, linkPathWithMD)
				if strings.ToLower(relPath) == targetPathLower {
					resolvedPath = targetPath
				} else if strings.ToLower(fmt.Sprintf("%s/%s", sourceFolder, linkPath)) == targetPathNoExtLower {
					resolvedPath = targetPath
				}
			}
			if resolvedPath == "" {
				if strings.ToLower(linkPathWithMD) == targetPathLower {
					resolvedPath = targetPath
				} else if strings.ToLower(linkPath) == targetPathNoExtLower {
					resolvedPath = targetPath
				}
			}

			if resolvedPath != "" {
				start := match[0] - 30
				if start < 0 {
					start = 0
				}
				end := match[1] + 30
				if end > len(line) {
					end = len(line)
				}
				ctx := line[start:end]
				if start > 0 {
					ctx = "..." + ctx
				}
				if end < len(line) {
					ctx = ctx + "..."
				}
				found = append(found, BacklinkRef{
					LineNumber: num,
					Context:    ctx,
					Type:       "markdown",
				})
			}
		}
	}
	return found
}

// Resolver for graph edges
type LinkResolver struct {
	notePaths      map[string]struct{}
	notePathsLower map[string]string
	noteNames      map[string]string
}

func NewLinkResolver(notes []string) *LinkResolver {
	r := &LinkResolver{
		notePaths:      make(map[string]struct{}, len(notes)),
		notePathsLower: make(map[string]string, len(notes)*2),
		noteNames:      make(map[string]string, len(notes)*2),
	}
	for _, p := range notes {
		r.notePaths[p] = struct{}{}
		pLower := strings.ToLower(p)
		r.notePathsLower[pLower] = p
		if strings.HasSuffix(pLower, ".md") {
			r.notePathsLower[strings.TrimSuffix(pLower, ".md")] = p
		}
		stem := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
		r.noteNames[strings.ToLower(stem)] = p
		r.noteNames[strings.ToLower(filepath.Base(p))] = p
	}
	return r
}

func (r *LinkResolver) ResolveWikilink(target string, sourceFolder string) string {
	target = strings.TrimSpace(target)
	if target == "" {
		return ""
	}
	targetLower := strings.ToLower(target)

	// 1. Relative to source folder
	if sourceFolder != "" && !strings.Contains(target, "/") {
		rel := fmt.Sprintf("%s/%s", sourceFolder, target)
		relLower := strings.ToLower(rel)
		if _, ok := r.notePaths[rel]; ok {
			if strings.HasSuffix(rel, ".md") {
				return rel
			}
			return rel + ".md"
		}
		if _, ok := r.notePaths[rel+".md"]; ok {
			return rel + ".md"
		}
		if orig, ok := r.notePathsLower[relLower]; ok {
			return orig
		}
		if orig, ok := r.notePathsLower[relLower+".md"]; ok {
			return orig
		}
	}

	// 2. Relative to vault root
	if _, ok := r.notePaths[target]; ok {
		if strings.HasSuffix(target, ".md") {
			return target
		}
		return target + ".md"
	}
	if _, ok := r.notePaths[target+".md"]; ok {
		return target + ".md"
	}
	if orig, ok := r.notePathsLower[targetLower]; ok {
		return orig
	}
	if orig, ok := r.notePathsLower[targetLower+".md"]; ok {
		return orig
	}

	// 3. Fallback to stem
	if orig, ok := r.noteNames[targetLower]; ok {
		return orig
	}

	return ""
}

func (r *LinkResolver) ResolveMDLink(linkPath string, sourceFolder string) string {
	if linkPath == "" {
		return ""
	}
	parts := strings.Split(linkPath, "#")
	linkPath = parts[0]
	if linkPath == "" {
		return ""
	}
	if u, err := url.PathUnescape(linkPath); err == nil {
		linkPath = u
	}
	if strings.HasPrefix(linkPath, "./") {
		linkPath = linkPath[2:]
	}
	linkPathWithMD := linkPath
	if !strings.HasSuffix(linkPathWithMD, ".md") {
		linkPathWithMD += ".md"
	}

	if sourceFolder != "" && !strings.HasPrefix(linkPath, "/") {
		rel := fmt.Sprintf("%s/%s", sourceFolder, linkPath)
		relMD := fmt.Sprintf("%s/%s", sourceFolder, linkPathWithMD)
		relLower := strings.ToLower(rel)
		relMDLower := strings.ToLower(relMD)

		if _, ok := r.notePaths[rel]; ok {
			if strings.HasSuffix(rel, ".md") {
				return rel
			}
			return rel + ".md"
		}
		if _, ok := r.notePaths[relMD]; ok {
			return relMD
		}
		if orig, ok := r.notePathsLower[relLower]; ok {
			return orig
		}
		if orig, ok := r.notePathsLower[relMDLower]; ok {
			return orig
		}
	}

	linkPathLower := strings.ToLower(linkPath)
	linkPathMDLower := strings.ToLower(linkPathWithMD)

	if _, ok := r.notePaths[linkPath]; ok {
		if strings.HasSuffix(linkPath, ".md") {
			return linkPath
		}
		return linkPath + ".md"
	}
	if _, ok := r.notePaths[linkPathWithMD]; ok {
		return linkPathWithMD
	}
	if orig, ok := r.notePathsLower[linkPathLower]; ok {
		return orig
	}
	if orig, ok := r.notePathsLower[linkPathMDLower]; ok {
		return orig
	}

	return ""
}

func IsUnderSystemFolder(path string) bool {
	parent := ""
	if strings.Contains(path, "/") {
		idx := strings.LastIndex(path, "/")
		parent = path[:idx]
	}
	if parent == "" || parent == "." {
		return false
	}
	segments := strings.Split(parent, "/")
	for _, seg := range segments {
		if strings.HasPrefix(seg, "_") {
			return true
		}
	}
	return false
}

func (v *Vault) GetGraphData(includeSystemFolders bool) (GraphData, error) {
	notes, _, err := v.ScanNotes(false)
	if err != nil {
		return GraphData{}, err
	}

	var allNotePaths []string
	for _, n := range notes {
		if n.Type == "note" {
			allNotePaths = append(allNotePaths, n.Path)
		}
	}

	resolver := NewLinkResolver(allNotePaths)
	type edgeKey struct {
		s, t string
	}
	edgeMap := make(map[edgeKey]GraphEdge)

	var nodePaths []string
	for _, p := range allNotePaths {
		if !includeSystemFolders && IsUnderSystemFolder(p) {
			continue
		}
		nodePaths = append(nodePaths, p)

		content, err := v.GetNoteContent(p)
		if err != nil {
			continue
		}

		sourceFolder := strings.ReplaceAll(filepath.Dir(p), "\\", "/")
		if sourceFolder == "." {
			sourceFolder = ""
		}

		// 1. Wikilinks (first-wins)
		for _, match := range wikilinkRe.FindAllStringSubmatch(content, -1) {
			target := strings.TrimSpace(match[1])
			resolved := resolver.ResolveWikilink(target, sourceFolder)
			if resolved != "" && resolved != p {
				if !includeSystemFolders && IsUnderSystemFolder(resolved) {
					continue
				}
				k := edgeKey{s: p, t: resolved}
				if _, exists := edgeMap[k]; !exists {
					edgeMap[k] = GraphEdge{
						Source: p,
						Target: resolved,
						Type:   "wikilink",
					}
				}
			}
		}

		// 2. Markdown links
		for _, match := range mdlinkRe.FindAllStringSubmatch(content, -1) {
			target := strings.TrimSpace(match[2])
			if isExternalOrFragmentLink(target) {
				continue
			}
			resolved := resolver.ResolveMDLink(target, sourceFolder)
			if resolved != "" && resolved != p {
				if !includeSystemFolders && IsUnderSystemFolder(resolved) {
					continue
				}
				k := edgeKey{s: p, t: resolved}
				if _, exists := edgeMap[k]; !exists {
					edgeMap[k] = GraphEdge{
						Source: p,
						Target: resolved,
						Type:   "markdown",
					}
				}
			}
		}
	}

	nodes := make([]GraphNode, 0, len(nodePaths))
	for _, p := range nodePaths {
		stem := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
		nodes = append(nodes, GraphNode{
			ID:    p,
			Label: stem,
		})
	}

	edges := make([]GraphEdge, 0, len(edgeMap))
	for _, e := range edgeMap {
		edges = append(edges, e)
	}

	return GraphData{
		Nodes: nodes,
		Edges: edges,
	}, nil
}
