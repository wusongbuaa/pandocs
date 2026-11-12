package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	stateVersion = 1
	workers      = 8
	// Below this many missing files, asking for them one by one is less work for everyone than an archive.
	packThreshold = 32
)

// FileState is what a file was when this copy last agreed with the server, which is what makes a three-way decision possible.
type FileState struct {
	SHA256     string `json:"sha256"`
	Revision   int    `json:"revision,omitempty"`
	DocumentID string `json:"documentId,omitempty"`
	Kind       string `json:"kind"`
	// Proposed is the hash of a text already sent for review, so committing again does not send it again.
	Proposed string `json:"proposed,omitempty"`
	// Resolving is the revision a commit last conflicted with. Once someone has worked its changes into the file and
	// commits with --resolved, the file is sent as made from it.
	Resolving int `json:"resolving,omitempty"`
}

// State holds no credentials, so a synced directory can be shared or checked in.
type State struct {
	Version int                  `json:"version"`
	Server  string               `json:"server,omitempty"`
	Space   string               `json:"space"`
	Cursor  string               `json:"cursor"`
	Files   map[string]FileState `json:"files"`
	// Submitted remembers new pages already sent for review, by path.
	Submitted map[string]string `json:"submitted,omitempty"`
}

func statePath(root string) string { return filepath.Join(root, metaDir, "state.json") }

func loadState(root string) (*State, error) {
	raw, err := os.ReadFile(statePath(root))
	if err != nil {
		return nil, err
	}
	var state State
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, fmt.Errorf("%s is not readable: %w", statePath(root), err)
	}
	// A newer pandocs may keep things this one does not know about, and saving over it would lose them.
	if state.Version > stateVersion {
		return nil, fmt.Errorf("%s was written by a newer pandocs: update this one to use the copy", statePath(root))
	}
	if state.Files == nil {
		state.Files = map[string]FileState{}
	}
	return &state, nil
}

func saveState(root string, state *State) error {
	raw, err := json.MarshalIndent(state, "", " ")
	if err != nil {
		return err
	}
	return writeFileAtomic(statePath(root), raw, 0o644)
}

// findRoot walks up from a directory to the synced copy it is in, the way git finds a repository.
func findRoot(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(statePath(dir)); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("not inside a synced space: run `pandocs sync <space> [dir]` first")
		}
		dir = parent
	}
}

// SyncReport says what a round did, and what it left for someone to look at.
type SyncReport struct {
	Written   []string `json:"written"`
	Removed   []string `json:"removed"`
	Moved     []string `json:"moved"`
	Kept      []string `json:"kept"`
	Conflicts []string `json:"conflicts"`
	Skipped   []string `json:"skipped"`
}

func (r *SyncReport) changed() bool {
	return len(r.Written)+len(r.Removed)+len(r.Moved) > 0
}

// reconcile brings a copy up to date. Anything changed here stays: a file is only replaced if it still matches what
// the server last gave, so a sync can never lose someone's work. Repeating it is always safe.
func reconcile(ctx context.Context, src source, root string, state *State, quickStart source) (*SyncReport, error) {
	manifest, err := src.manifest(ctx)
	if err != nil {
		return nil, err
	}
	report := &SyncReport{}
	followMoves(root, manifest, state, report)

	missing := 0
	for _, file := range manifest.Files {
		if _, known := state.Files[file.Path]; !known && file.Kind == "document" {
			missing++
		}
	}
	switch {
	case quickStart != nil && len(state.Files) == 0:
		seedFromPack(ctx, quickStart, root, state, manifest, report)
	case missing >= packThreshold:
		seedFromPack(ctx, src, root, state, manifest, report)
	}

	var fetchList []ManifestFile
	for _, file := range manifest.Files {
		target, err := safeJoin(root, file.Path)
		if err != nil {
			report.Skipped = append(report.Skipped, file.Path)
			continue
		}
		local, err := hashFile(target)
		if err != nil {
			return nil, err
		}
		base, known := state.Files[file.Path]
		switch {
		case local == file.SHA256:
			state.Files[file.Path] = agreed(file, file.Revision)
			delete(state.Submitted, file.Path)
		case file.Kind == "asset" || local == "" && !known || known && local == base.SHA256:
			// Uploads never change in place, so a different local one is simply wrong.
			fetchList = append(fetchList, file)
		case local == "":
			// Deleted here. `commit --delete` is what makes that count, and until then it is left alone.
			if base.SHA256 != file.SHA256 {
				report.Conflicts = append(report.Conflicts, file.Path)
			}
		case !known || base.SHA256 != file.SHA256:
			// Changed here and there. The server can merge these on commit, and only it has the history to.
			if !known {
				state.Files[file.Path] = FileState{Kind: file.Kind, DocumentID: file.DocumentID}
			}
			report.Conflicts = append(report.Conflicts, file.Path)
		default:
			report.Kept = append(report.Kept, file.Path)
		}
	}
	err = fetchAll(ctx, src, root, fetchList, state, report)

	wanted := map[string]bool{}
	folded := map[string]string{}
	for _, file := range manifest.Files {
		wanted[file.Path] = true
		folded[strings.ToLower(file.Path)] = file.Path
	}
	for path, base := range state.Files {
		if wanted[path] {
			continue
		}
		target, joinErr := safeJoin(root, path)
		if joinErr != nil || sameFileAs(root, target, folded[strings.ToLower(path)]) {
			delete(state.Files, path)
			continue
		}
		local, hashErr := hashFile(target)
		if hashErr != nil {
			return nil, hashErr
		}
		switch {
		case local == "":
		case local == base.SHA256:
			if removeErr := removeWithParents(root, target); removeErr != nil {
				return nil, removeErr
			}
			report.Removed = append(report.Removed, path)
		default:
			// Gone from the server, with work here. Without a base it shows as a new page, so nothing is lost.
			report.Kept = append(report.Kept, path)
		}
		delete(state.Files, path)
	}
	state.Cursor = manifest.Cursor
	sort.Strings(report.Written)
	sort.Strings(report.Removed)
	sort.Strings(report.Kept)
	sort.Strings(report.Conflicts)
	return report, err
}

// sameFileAs is whether a file the server no longer has is, under another letter case, one it still has: on macOS and
// Windows both names open the same file, and removing the old one would remove the page.
func sameFileAs(root, target, other string) bool {
	if other == "" {
		return false
	}
	otherTarget, err := safeJoin(root, other)
	if err != nil {
		return false
	}
	first, errFirst := os.Stat(target)
	second, errSecond := os.Stat(otherTarget)
	return errFirst == nil && errSecond == nil && os.SameFile(first, second)
}

func agreed(file ManifestFile, revision int) FileState {
	return FileState{SHA256: file.SHA256, Revision: revision, DocumentID: file.DocumentID, Kind: file.Kind}
}

// followMoves carries a page's local file along when it moved on the server, so a rename does not read as one page
// deleted and another created, and work in progress stays on the right page.
func followMoves(root string, manifest *Manifest, state *State, report *SyncReport) {
	byDocument := map[string]string{}
	for path, file := range state.Files {
		if file.DocumentID != "" {
			byDocument[file.DocumentID] = path
		}
	}
	for _, file := range manifest.Files {
		old, known := byDocument[file.DocumentID]
		if file.DocumentID == "" || !known || old == file.Path {
			continue
		}
		from, errFrom := safeJoin(root, old)
		to, errTo := safeJoin(root, file.Path)
		if errFrom != nil || errTo != nil {
			continue
		}
		// On macOS and Windows a name that changed only in case is the same file, and it still has to be renamed.
		if existing, err := os.Lstat(to); err == nil {
			if current, err := os.Lstat(from); err != nil || !os.SameFile(current, existing) {
				continue
			}
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			continue
		}
		if err := os.Rename(from, to); err != nil && !errors.Is(err, fs.ErrNotExist) {
			continue
		}
		_ = removeEmptyParents(root, from)
		state.Files[file.Path] = state.Files[old]
		delete(state.Files, old)
		report.Moved = append(report.Moved, old+" -> "+file.Path)
	}
}

func removeEmptyParents(root, target string) error {
	for dir := filepath.Dir(target); dir != root && strings.HasPrefix(dir, root); dir = filepath.Dir(dir) {
		if err := os.Remove(dir); err != nil {
			return nil
		}
	}
	return nil
}

// seedFromPack gets most pages in one go, but is only ever a head start. It fills in files that are not here, and keeps
// those that match the manifest. Older ones are dropped again to be fetched properly, so an archive that is behind
// cannot look like someone's edit, and an archive that fails halfway costs nothing.
func seedFromPack(ctx context.Context, src source, root string, state *State, manifest *Manifest, report *SyncReport) {
	stream, err := src.pack(ctx)
	if err != nil || stream == nil {
		return
	}
	defer stream.Close()
	wanted := map[string]ManifestFile{}
	for _, file := range manifest.Files {
		if file.Kind != "document" {
			continue
		}
		target, err := safeJoin(root, file.Path)
		if err != nil {
			continue
		}
		if _, err := os.Lstat(target); errors.Is(err, fs.ErrNotExist) {
			wanted[file.Path] = file
		}
	}
	written, _ := unpack(stream, root, func(path string) bool {
		_, needed := wanted[path]
		return !needed
	})
	for path, sum := range written {
		file := wanted[path]
		if sum == file.SHA256 {
			state.Files[path] = agreed(file, file.Revision)
			report.Written = append(report.Written, path)
			continue
		}
		if target, err := safeJoin(root, path); err == nil {
			_ = removeWithParents(root, target)
		}
	}
}

func fetchAll(ctx context.Context, src source, root string, files []ManifestFile, state *State, report *SyncReport) error {
	jobs := make(chan ManifestFile)
	var lock sync.Mutex
	var firstErr error
	var group sync.WaitGroup
	for range min(workers, max(len(files), 1)) {
		group.Add(1)
		go func() {
			defer group.Done()
			for file := range jobs {
				revision, sum, err := fetchOne(ctx, src, root, file)
				lock.Lock()
				if err != nil {
					if firstErr == nil {
						firstErr = fmt.Errorf("%s: %w", file.Path, err)
					}
				} else {
					entry := agreed(file, revision)
					entry.SHA256 = sum
					state.Files[file.Path] = entry
					report.Written = append(report.Written, file.Path)
				}
				lock.Unlock()
			}
		}()
	}
	for _, file := range files {
		jobs <- file
	}
	close(jobs)
	group.Wait()
	return firstErr
}

func fetchOne(ctx context.Context, src source, root string, file ManifestFile) (int, string, error) {
	target, err := safeJoin(root, file.Path)
	if err != nil {
		return 0, "", err
	}
	got, err := src.file(ctx, file)
	if err != nil {
		return 0, "", err
	}
	defer got.body.Close()
	// An upload is its hash, so any difference means a bad transfer. A page may have moved on since the manifest, but
	// one at the revision the manifest named has to be what it said. Either way nothing here is replaced by it.
	expect := ""
	if file.Kind == "asset" || got.revision != 0 && got.revision == file.Revision {
		expect = file.SHA256
	}
	sum, err := streamToFile(target, got.body, 0o644, expect)
	if err != nil {
		return 0, "", err
	}
	revision := got.revision
	if revision == 0 {
		revision = file.Revision
	}
	return revision, sum, nil
}

// Change is one difference between a copy and what it last agreed with the server.
type Change struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// isPagePath is whether a file in a copy could be a page. Uploads and this tool's own files are never one.
func isPagePath(path string) bool {
	if !strings.HasSuffix(strings.ToLower(path), ".md") || path == "assets" || strings.HasPrefix(path, "assets/") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	return true
}

func localChanges(root string, state *State) ([]Change, error) {
	var changes []Change
	seen := map[string]bool{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if relative == "." {
			return nil
		}
		if entry.IsDir() {
			if strings.HasPrefix(entry.Name(), ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() || !isPagePath(relative) {
			return nil
		}
		seen[relative] = true
		base, known := state.Files[relative]
		if !known {
			changes = append(changes, Change{relative, "added"})
			return nil
		}
		sum, err := hashFile(path)
		if err != nil {
			return err
		}
		if sum != base.SHA256 {
			changes = append(changes, Change{relative, "modified"})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for path, base := range state.Files {
		if base.Kind == "document" && !seen[path] {
			changes = append(changes, Change{path, "deleted"})
		}
	}
	sort.Slice(changes, func(a, b int) bool { return changes[a].Path < changes[b].Path })
	return changes, nil
}
