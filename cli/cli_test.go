package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeServer is a space on a server, reduced to what a copy on disk ever asks of it.
type fakeServer struct {
	t         *testing.T
	lock      sync.Mutex
	files     map[string]*fakeFile
	cursor    int
	pack      []byte
	packCalls atomic.Int32
	fileCalls atomic.Int32
	saves     []map[string]any
	failNext  atomic.Int32
	me        string
	extra     []ManifestFile
	damage    atomic.Bool
}

type fakeFile struct {
	id       string
	content  string
	revision int
}

func newFakeServer(t *testing.T) (*fakeServer, *Client) {
	t.Helper()
	fake := &fakeServer{t: t, files: map[string]*fakeFile{}, me: "user"}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	client := newClient(server.URL, "pd_test")
	client.retryDelay = time.Millisecond
	return fake, client
}

func (f *fakeServer) put(path, content string) {
	f.lock.Lock()
	defer f.lock.Unlock()
	if file, known := f.files[path]; known {
		file.content = content
		file.revision++
		return
	}
	f.files[path] = &fakeFile{id: "id-" + hashBytes([]byte(path))[:12], content: content, revision: 1}
}

func (f *fakeServer) move(from, to string) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.files[to] = f.files[from]
	delete(f.files, from)
}

func (f *fakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if f.failNext.Load() > 0 {
		f.failNext.Add(-1)
		http.Error(w, "restarting", http.StatusServiceUnavailable)
		return
	}
	if r.Header.Get("Authorization") != "Bearer pd_test" {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"TOKEN_INVALID","message":"no"}}`))
		return
	}
	f.lock.Lock()
	defer f.lock.Unlock()
	data := func(status int, value any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"version": 1, "data": value})
	}
	path := strings.TrimPrefix(r.URL.Path, apiBase)
	switch {
	case path == "me":
		data(200, Me{ID: "1", DisplayName: "Someone", Kind: f.me, Scopes: []string{"read", "write"}})
	case path == "spaces/shop/manifest":
		manifest := Manifest{Cursor: fmt.Sprintf("1.%d", f.cursor), Files: slices.Clone(f.extra)}
		for name, file := range f.files {
			manifest.Files = append(manifest.Files, ManifestFile{Path: name, Kind: "document", SHA256: hashBytes([]byte(file.content)), DocumentID: file.id, Revision: file.revision})
		}
		data(200, manifest)
	case path == "spaces/shop/snapshot":
		f.packCalls.Add(1)
		_, _ = w.Write(f.pack)
	case strings.HasPrefix(path, "spaces/shop/assets/"):
		_, _ = w.Write([]byte("wrong bytes"))
	case strings.HasPrefix(path, "documents/") && strings.HasSuffix(path, "/content") && r.Method == http.MethodGet:
		f.fileCalls.Add(1)
		for _, file := range f.files {
			if strings.Contains(path, file.id) {
				w.Header().Set("X-Pandocs-Revision", fmt.Sprint(file.revision))
				if f.damage.Load() {
					_, _ = w.Write([]byte(file.content + "garbled"))
					return
				}
				_, _ = w.Write([]byte(file.content))
				return
			}
		}
		w.WriteHeader(404)
	case strings.HasPrefix(path, "documents/") && strings.HasSuffix(path, "/content") && r.Method == http.MethodPut:
		var input map[string]any
		_ = json.NewDecoder(r.Body).Decode(&input)
		input["key"] = r.Header.Get("Idempotency-Key")
		f.saves = append(f.saves, input)
		for _, file := range f.files {
			if !strings.Contains(path, file.id) {
				continue
			}
			if int(input["expectedRevision"].(float64)) != file.revision {
				w.WriteHeader(http.StatusConflict)
				_, _ = fmt.Fprintf(w, `{"error":{"code":"MERGE_CONFLICT","message":"same place","details":{"currentRevision":%d,"conflicts":[]}}}`, file.revision)
				return
			}
			file.content = input["markdown"].(string)
			file.revision++
			data(200, map[string]any{"revision": map[string]any{"no": file.revision, "sha256": hashBytes([]byte(file.content))}})
			return
		}
		w.WriteHeader(404)
	default:
		w.WriteHeader(404)
	}
}

func syncOnce(t *testing.T, client *Client, root string, state *State) *SyncReport {
	t.Helper()
	report, err := reconcile(context.Background(), &httpSource{client: client, space: "shop"}, root, state, nil)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	return report
}

func newState() *State {
	return &State{Version: stateVersion, Space: "shop", Files: map[string]FileState{}}
}

func readText(t *testing.T, parts ...string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(parts...))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func writeText(t *testing.T, content string, parts ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(parts...)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parts...), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSafeJoinRefusesAnythingThatLeavesTheCopy(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{
		"", "/etc/passwd", "../evil", "a/../../evil", "a/..", ".", "..", "a//b", "a/./b",
		`..\evil`, `a\..\..\evil`, `C:\evil`, "C:evil", "a:stream", "nul\x00byte",
		".pandocs/state.json", "a/.pandocs/x", ".pandocs", ".. /evil", ".pandocs /x", ".pandocs./x", "a./b", "a /b", "end.",
		".PANDOCS/state.json", "a/.Pandocs/x",
		"CON", "con.md", "a/NUL", "COM1.txt", "lpt9",
	} {
		if target, err := safeJoin(root, path); err == nil {
			t.Errorf("safeJoin(%q) gave %q", path, target)
		}
	}
	for _, path := range []string{"a.md", "指南/入门/第一步.md", "assets/abc.png", "a.b/c.md", ".hidden-is-the-servers-business.md", "console.md", "com.md"} {
		target, err := safeJoin(root, path)
		if err != nil {
			t.Errorf("safeJoin(%q): %v", path, err)
			continue
		}
		if !strings.HasPrefix(target, root+string(filepath.Separator)) {
			t.Errorf("safeJoin(%q) gave %q, outside %q", path, target, root)
		}
	}
}

func TestSyncWritesFollowsAndRemoves(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("a.md", "one\n")
	fake.put("dir/b.md", "two\n")
	fake.put("gone/c.md", "three\n")
	root := t.TempDir()
	state := newState()

	report := syncOnce(t, client, root, state)
	if len(report.Written) != 3 {
		t.Fatalf("written %v", report.Written)
	}
	if got := readText(t, root, "dir", "b.md"); got != "two\n" {
		t.Fatalf("got %q", got)
	}

	fake.put("a.md", "one, again\n")
	delete(fake.files, "gone/c.md")
	report = syncOnce(t, client, root, state)
	if !slices.Equal(report.Written, []string{"a.md"}) || !slices.Equal(report.Removed, []string{"gone/c.md"}) {
		t.Fatalf("report %+v", report)
	}
	if state.Files["a.md"].Revision != 2 {
		t.Fatalf("revision %d", state.Files["a.md"].Revision)
	}
	if _, err := os.Stat(filepath.Join(root, "gone")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("empty folder left behind: %v", err)
	}
	if report = syncOnce(t, client, root, state); report.changed() {
		t.Fatalf("nothing changed, yet %+v", report)
	}
}

// caseBlind is whether this file system opens `a` for `A`, as macOS and Windows do unless told otherwise.
func caseBlind(t *testing.T, dir string) bool {
	t.Helper()
	writeText(t, "x", dir, "probe")
	defer os.Remove(filepath.Join(dir, "probe"))
	_, err := os.Stat(filepath.Join(dir, "PROBE"))
	return err == nil
}

func TestSyncFollowsARenameThatOnlyChangesCase(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("guide/readme.md", "hello\n")
	root := t.TempDir()
	if !caseBlind(t, root) {
		t.Skip("this file system tells names apart by case, where renaming is like any other")
	}
	state := newState()
	syncOnce(t, client, root, state)

	fake.move("guide/readme.md", "guide/README.md")
	report := syncOnce(t, client, root, state)
	if len(report.Removed) != 0 || !slices.Equal(report.Moved, []string{"guide/readme.md -> guide/README.md"}) {
		t.Fatalf("report %+v", report)
	}
	entries, err := os.ReadDir(filepath.Join(root, "guide"))
	if err != nil || len(entries) != 1 || entries[0].Name() != "README.md" {
		t.Fatalf("on disk: %v %v", entries, err)
	}
	if _, known := state.Files["guide/readme.md"]; known || state.Files["guide/README.md"].SHA256 == "" {
		t.Fatalf("state %+v", state.Files)
	}
	if changes, err := localChanges(root, state); err != nil || len(changes) != 0 {
		t.Fatalf("changes %v %v", changes, err)
	}
}

func TestSyncNeverRemovesAPageUnderItsOtherCase(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("readme.md", "hello\n")
	root := t.TempDir()
	if !caseBlind(t, root) {
		t.Skip("this file system tells names apart by case")
	}
	state := newState()
	syncOnce(t, client, root, state)
	// As if the rename had not been followed: the old name is still in the state, and the new one is what the server has.
	fake.move("readme.md", "README.md")
	fake.files["README.md"].id = "id-another"
	report := syncOnce(t, client, root, state)
	if len(report.Removed) != 0 {
		t.Fatalf("removed %v", report.Removed)
	}
	if got := readText(t, root, "README.md"); got != "hello\n" {
		t.Fatalf("got %q", got)
	}
}

func TestSyncNeverGoesThroughALink(t *testing.T) {
	fake, client := newFakeServer(t)
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("cannot make a link here: %v", err)
	}
	writeText(t, "mine\n", outside, "kept.md")
	if err := os.Symlink(filepath.Join(outside, "kept.md"), filepath.Join(root, "linked.md")); err != nil {
		t.Fatal(err)
	}
	fake.put("escape/pwned.md", "owned\n")
	fake.put("linked.md", "theirs\n")
	state := newState()
	report := syncOnce(t, client, root, state)
	if !slices.Equal(report.Skipped, []string{"escape/pwned.md", "linked.md"}) && !slices.Equal(report.Skipped, []string{"linked.md", "escape/pwned.md"}) {
		t.Fatalf("report %+v", report)
	}
	if _, err := os.Stat(filepath.Join(outside, "pwned.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("wrote outside the copy: %v", err)
	}
	if got := readText(t, outside, "kept.md"); got != "mine\n" {
		t.Fatalf("wrote through a link: %q", got)
	}
}

func TestSyncNeverLosesWork(t *testing.T) {
	fake, client := newFakeServer(t)
	for _, name := range []string{"kept.md", "both.md", "removed.md", "moved.md"} {
		fake.put(name, name+" original\n")
	}
	root := t.TempDir()
	state := newState()
	syncOnce(t, client, root, state)
	for _, name := range []string{"kept.md", "both.md", "removed.md", "moved.md"} {
		writeText(t, name+" mine\n", root, name)
	}
	fake.put("both.md", "theirs\n")
	delete(fake.files, "removed.md")
	fake.move("moved.md", "elsewhere/moved.md")

	report := syncOnce(t, client, root, state)
	for name, want := range map[string]string{"kept.md": "kept.md mine\n", "both.md": "both.md mine\n", "removed.md": "removed.md mine\n", "elsewhere/moved.md": "moved.md mine\n"} {
		if got := readText(t, root, filepath.FromSlash(name)); got != want {
			t.Errorf("%s holds %q", name, got)
		}
	}
	if !slices.Equal(report.Conflicts, []string{"both.md"}) {
		t.Errorf("conflicts %v", report.Conflicts)
	}
	if state.Files["both.md"].Revision != 1 {
		t.Errorf("the base revision moved to %d, so a merge would lose their change", state.Files["both.md"].Revision)
	}
	if !slices.Equal(report.Moved, []string{"moved.md -> elsewhere/moved.md"}) {
		t.Errorf("moved %v", report.Moved)
	}
	changes, err := localChanges(root, state)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(changes, Change{"removed.md", "added"}) {
		t.Errorf("work on a page removed on the server should show as new: %v", changes)
	}
}

func TestSyncSkipsPathsThatLeaveTheCopy(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("fine.md", "fine\n")
	fake.extra = []ManifestFile{{Path: "../evil.md", Kind: "document", SHA256: "x", DocumentID: "nope"}, {Path: ".pandocs/state.json", Kind: "document", SHA256: "x", DocumentID: "nope"}}
	parent := t.TempDir()
	root := filepath.Join(parent, "copy")
	report := syncOnce(t, client, root, newState())
	if len(report.Skipped) != 2 {
		t.Fatalf("skipped %v", report.Skipped)
	}
	if _, err := os.Stat(filepath.Join(parent, "evil.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("wrote outside the copy")
	}
	if got := readText(t, root, "fine.md"); got != "fine\n" {
		t.Fatalf("got %q", got)
	}
}

func TestSyncRefusesAnUploadThatArrivedDamaged(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.extra = []ManifestFile{{Path: "assets/abc.png", Kind: "asset", SHA256: strings.Repeat("a", 64)}}
	root := t.TempDir()
	_, err := reconcile(context.Background(), &httpSource{client: client, space: "shop"}, root, newState(), nil)
	if err == nil || !strings.Contains(err.Error(), "damaged") {
		t.Fatalf("err %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, "assets", "abc.png")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("kept the damaged file")
	}
}

type packEntry struct {
	name     string
	content  string
	typeflag byte
}

func makePack(t *testing.T, entries ...packEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	zipper := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(zipper)
	for _, entry := range entries {
		kind := entry.typeflag
		if kind == 0 {
			kind = tar.TypeReg
		}
		header := &tar.Header{Name: entry.name, Mode: 0o644, Size: int64(len(entry.content)), Typeflag: kind, Format: tar.FormatPAX}
		if kind != tar.TypeReg {
			header.Size = 0
			header.Linkname = entry.content
		}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if kind == tar.TypeReg {
			if _, err := archive.Write([]byte(entry.content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipper.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestSyncKeepsNoPageThatArrivedDamaged(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("page.md", "one\n")
	root := t.TempDir()
	state := newState()
	syncOnce(t, client, root, state)

	fake.put("page.md", "two\n")
	fake.damage.Store(true)
	if _, err := reconcile(context.Background(), &httpSource{client: client, space: "shop"}, root, state, nil); err == nil || !strings.Contains(err.Error(), "arrived damaged") {
		t.Fatalf("err %v", err)
	}
	if got := readText(t, root, "page.md"); got != "one\n" {
		t.Fatalf("got %q", got)
	}
	fake.damage.Store(false)
	syncOnce(t, client, root, state)
	if got := readText(t, root, "page.md"); got != "two\n" || state.Files["page.md"].Revision != 2 {
		t.Fatalf("got %q at %d", got, state.Files["page.md"].Revision)
	}
}

func TestOnePandocsAtATimeWorksOnACopy(t *testing.T) {
	was := lockWait
	lockWait = 200 * time.Millisecond
	defer func() { lockWait = was }()
	root := t.TempDir()
	unlock, err := lockCopy(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockCopy(root); !errors.Is(err, errLocked) {
		t.Fatalf("a second one got in: %v", err)
	}
	// One that waits gets in as soon as the first is done.
	go func() {
		time.Sleep(50 * time.Millisecond)
		unlock()
	}()
	again, err := lockCopy(root)
	if err != nil {
		t.Fatal(err)
	}
	again()
}

func TestAStateFromANewerVersionIsLeftAlone(t *testing.T) {
	root := t.TempDir()
	writeText(t, `{"version":2,"space":"shop","files":{}}`, root, metaDir, "state.json")
	if _, err := loadState(root); err == nil || !strings.Contains(err.Error(), "newer pandocs") {
		t.Fatalf("err %v", err)
	}
}

func TestAnArchiveIsOnlyAHeadStart(t *testing.T) {
	fake, client := newFakeServer(t)
	for index := range packThreshold + 2 {
		fake.put(fmt.Sprintf("page%d.md", index), fmt.Sprintf("current %d\n", index))
	}
	entries := []packEntry{{name: ".pandocs/MANIFEST.json", content: "{}"}, {name: "../evil.md", content: "evil"}, {name: "link.md", content: "/etc/passwd", typeflag: tar.TypeSymlink}, {name: "extra.md", content: "not in the manifest"}}
	for index := range packThreshold + 2 {
		content := fmt.Sprintf("current %d\n", index)
		// One is behind, as an archive can be.
		if index == 0 {
			content = "older\n"
		}
		entries = append(entries, packEntry{name: fmt.Sprintf("page%d.md", index), content: content})
	}
	fake.pack = makePack(t, entries...)
	parent := t.TempDir()
	root := filepath.Join(parent, "copy")
	state := newState()
	report := syncOnce(t, client, root, state)

	if fake.packCalls.Load() != 1 {
		t.Fatalf("archive asked for %d times", fake.packCalls.Load())
	}
	if fake.fileCalls.Load() != 1 {
		t.Fatalf("%d pages fetched one by one, wanted just the one the archive had old", fake.fileCalls.Load())
	}
	if got := readText(t, root, "page0.md"); got != "current 0\n" {
		t.Fatalf("got %q", got)
	}
	if len(report.Conflicts) != 0 || len(report.Kept) != 0 {
		t.Fatalf("an old archive should not look like someone's edit: %+v", report)
	}
	if len(report.Written) != packThreshold+2 {
		t.Fatalf("written %d", len(report.Written))
	}
	for _, name := range []string{"evil.md", filepath.Join("copy", "link.md"), filepath.Join("copy", "extra.md"), filepath.Join("copy", ".pandocs", "MANIFEST.json")} {
		if _, err := os.Lstat(filepath.Join(parent, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s should not exist", name)
		}
	}
}

func TestAnArchiveThatFailsCostsNothing(t *testing.T) {
	fake, client := newFakeServer(t)
	for index := range packThreshold + 2 {
		fake.put(fmt.Sprintf("page%d.md", index), "text\n")
	}
	fake.pack = []byte("this is not an archive")
	root := t.TempDir()
	report := syncOnce(t, client, root, newState())
	if len(report.Written) != packThreshold+2 {
		t.Fatalf("written %d", len(report.Written))
	}
}

func TestAnArchiveDoesNotTouchFilesAlreadyHere(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("mine.md", "server\n")
	fake.pack = makePack(t, packEntry{name: "mine.md", content: "server\n"})
	root := t.TempDir()
	writeText(t, "local work\n", root, "mine.md")
	state := newState()
	report, err := reconcile(context.Background(), &httpSource{client: client, space: "shop"}, root, state, &httpSource{client: client, space: "shop"})
	if err != nil {
		t.Fatal(err)
	}
	if got := readText(t, root, "mine.md"); got != "local work\n" {
		t.Fatalf("got %q", got)
	}
	if !slices.Equal(report.Conflicts, []string{"mine.md"}) {
		t.Fatalf("report %+v", report)
	}
}

func TestLocalChangesOnlyConsiderPages(t *testing.T) {
	root := t.TempDir()
	state := newState()
	state.Files["same.md"] = FileState{SHA256: hashBytes([]byte("same")), Kind: "document"}
	state.Files["edited.md"] = FileState{SHA256: hashBytes([]byte("old")), Kind: "document"}
	state.Files["deleted.md"] = FileState{SHA256: hashBytes([]byte("x")), Kind: "document"}
	state.Files["assets/a.png"] = FileState{SHA256: hashBytes([]byte("x")), Kind: "asset"}
	writeText(t, "same", root, "same.md")
	writeText(t, "new", root, "edited.md")
	writeText(t, "new", root, "folder", "added.md")
	writeText(t, "ignored", root, "notes.txt")
	writeText(t, "ignored", root, "llms.txt")
	writeText(t, "ignored", root, ".git", "x.md")
	writeText(t, "ignored", root, ".hidden.md")
	writeText(t, "ignored", root, "assets", "x.md")
	writeText(t, "{}", root, metaDir, "state.json")

	changes, err := localChanges(root, state)
	if err != nil {
		t.Fatal(err)
	}
	want := []Change{{"deleted.md", "deleted"}, {"edited.md", "modified"}, {"folder/added.md", "added"}}
	if !slices.Equal(changes, want) {
		t.Fatalf("got %v", changes)
	}
}

func TestFindRootWalksUp(t *testing.T) {
	root := t.TempDir()
	writeText(t, "{}", root, metaDir, "state.json")
	deep := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	found, err := findRoot(deep)
	if err != nil {
		t.Fatal(err)
	}
	resolvedWant, _ := filepath.EvalSymlinks(root)
	resolvedGot, _ := filepath.EvalSymlinks(found)
	if resolvedGot != resolvedWant {
		t.Fatalf("found %q, wanted %q", found, root)
	}
}

func TestCommitSavesWithTheBaseRevision(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("page.md", "one\n")
	root := t.TempDir()
	state := newState()
	syncOnce(t, client, root, state)
	writeText(t, "mine\n", root, "page.md")

	results, err := commitChanges(context.Background(), client, root, state, commitOptions{message: "note"})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Action != "saved" || results[0].Revision != 2 {
		t.Fatalf("results %+v", results)
	}
	save := fake.saves[0]
	if save["expectedRevision"].(float64) != 1 || save["merge"] != true || save["message"] != "note" || save["key"] == "" {
		t.Fatalf("sent %+v", save)
	}
	saved, err := loadState(root)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Files["page.md"].Revision != 2 {
		t.Fatalf("state says revision %d", saved.Files["page.md"].Revision)
	}
	if results, err = commitChanges(context.Background(), client, root, state, commitOptions{}); err != nil || len(results) != 0 {
		t.Fatalf("second commit: %+v %v", results, err)
	}
}

func TestCommitReportsAConflictAndLeavesTheFile(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("page.md", "one\n")
	root := t.TempDir()
	state := newState()
	syncOnce(t, client, root, state)
	writeText(t, "mine\n", root, "page.md")
	fake.put("page.md", "theirs\n")
	results, err := commitChanges(context.Background(), client, root, state, commitOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if results[0].Action != "conflict" {
		t.Fatalf("results %+v", results)
	}
	if got := readText(t, root, "page.md"); got != "mine\n" {
		t.Fatalf("got %q", got)
	}
}

func TestCommitAfterResolvingAConflictByHand(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("page.md", "one\n")
	root := t.TempDir()
	state := newState()
	syncOnce(t, client, root, state)
	writeText(t, "mine\n", root, "page.md")
	fake.put("page.md", "theirs\n")
	results, err := commitChanges(context.Background(), client, root, state, commitOptions{})
	if err != nil || results[0].Action != "conflict" || results[0].Revision != 2 {
		t.Fatalf("first commit: %+v %v", results, err)
	}
	if !strings.Contains(results[0].Message, "pandocs get shop/page --revision 2") || !strings.Contains(results[0].Message, "--resolved") {
		t.Fatalf("says %q", results[0].Message)
	}
	// Without saying it is resolved, it is still made from the old version, and still conflicts rather than undo theirs.
	writeText(t, "mine and theirs\n", root, "page.md")
	if results, _ = commitChanges(context.Background(), client, root, state, commitOptions{}); results[0].Action != "conflict" {
		t.Fatalf("unmarked commit: %+v", results)
	}
	results, err = commitChanges(context.Background(), client, root, state, commitOptions{resolved: true})
	if err != nil || len(results) != 1 || results[0].Action != "saved" || results[0].Revision != 3 {
		t.Fatalf("resolved commit: %+v %v", results, err)
	}
	if sent := fake.saves[len(fake.saves)-1]; sent["expectedRevision"].(float64) != 2 || sent["merge"] != true {
		t.Fatalf("sent %+v", sent)
	}
	saved, err := loadState(root)
	if err != nil {
		t.Fatal(err)
	}
	if file := saved.Files["page.md"]; file.Revision != 3 || file.Resolving != 0 {
		t.Fatalf("state %+v", file)
	}
}

func TestRetriesOnlyWhatCanSafelyHappenTwice(t *testing.T) {
	fake, client := newFakeServer(t)
	fake.put("page.md", "one\n")
	fake.failNext.Store(2)
	if _, err := client.me(context.Background()); err != nil {
		t.Fatalf("a read should get through a restart: %v", err)
	}

	root := t.TempDir()
	state := newState()
	syncOnce(t, client, root, state)
	writeText(t, "mine\n", root, "page.md")
	fake.failNext.Store(1)
	var saved savedRevision
	if err := client.call(context.Background(), http.MethodPut, "documents/"+segment(state.Files["page.md"].DocumentID)+"/content", map[string]any{"markdown": "mine\n", "expectedRevision": 1}, &saved, true); err != nil {
		t.Fatalf("a keyed write should be retried: %v", err)
	}
	if len(fake.saves) != 1 || fake.saves[0]["key"] == "" {
		t.Fatalf("saves %+v", fake.saves)
	}

	fake.failNext.Store(1)
	err := client.call(context.Background(), http.MethodPost, "anything", map[string]any{}, nil, false)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("a plain write should not be retried: %v", err)
	}

	fake.failNext.Store(10)
	if _, err := client.me(context.Background()); err == nil {
		t.Fatal("should give up eventually")
	}
	fake.failNext.Store(0)
}

func TestErrorsFromTheServerReadWell(t *testing.T) {
	_, client := newFakeServer(t)
	client.token = "wrong"
	_, err := client.me(context.Background())
	if err == nil || !isAPIError(err, "TOKEN_INVALID") || !strings.Contains(err.Error(), "TOKEN_INVALID: no") {
		t.Fatalf("err %v", err)
	}
}

func TestReadEvents(t *testing.T) {
	stream := ": connected\n\nid: 1.1\nevent: ready\ndata: {}\n\n: keep-alive\n\nid: 1.2\nevent: change\ndata: {\"kind\":\"document\"}\n\ndata: no event name\n\nevent: reset\ndata: {}\n\n" +
		"event:message\ndata:{\"a\":\ndata: 1}\r\n\r\nid: 1.3\n\n"
	var frames []serverEvent
	if err := readEvents(strings.NewReader(stream), func(frame serverEvent) { frames = append(frames, frame) }); err != nil {
		t.Fatal(err)
	}
	want := []serverEvent{{"1.1", "ready", "{}"}, {"1.2", "change", `{"kind":"document"}`}, {"", "message", "no event name"}, {"", "reset", "{}"}, {"", "message", "{\"a\":\n1}"}}
	if !slices.Equal(frames, want) {
		t.Fatalf("got %+v", frames)
	}
}

func TestWakesOnFileChangesButNotOnComments(t *testing.T) {
	var connections atomic.Int32
	var lastSeen atomic.Value
	lastSeen.Store("")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count := connections.Add(1)
		lastSeen.Store(r.Header.Get("Last-Event-ID"))
		w.WriteHeader(200)
		if count == 1 {
			_, _ = io.WriteString(w, "id: 1.1\nevent: change\ndata: {\"kind\":\"discussion\"}\n\n")
			return
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wake := make(chan struct{}, 8)
	done := make(chan error, 1)
	go func() { done <- wakesFromServer(ctx, newClient(server.URL, "t"), "shop", "1.0", wake) }()
	// Once for connecting, whatever was missed. The comment is not a reason, but connecting again is.
	<-wake
	deadline := time.After(5 * time.Second)
	for connections.Load() < 2 {
		select {
		case <-deadline:
			t.Fatal("did not reconnect")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if lastSeen.Load() != "1.1" {
		t.Fatalf("reconnected from %q", lastSeen.Load())
	}
	cancel()
	<-done
}

func TestWakesGiveUpOnAConnectionGoneQuiet(t *testing.T) {
	was := quietLimit
	quietLimit = 50 * time.Millisecond
	defer func() { quietLimit = was }()
	var connections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connections.Add(1)
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		// Nothing more, not even the keep-alive, as through a network that dropped the connection without a word.
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- wakesFromServer(ctx, newClient(server.URL, "t"), "shop", "", make(chan struct{}, 8)) }()
	deadline := time.After(5 * time.Second)
	for connections.Load() < 2 {
		select {
		case <-deadline:
			t.Fatal("kept waiting on a dead connection")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	<-done
}

func TestAFailedRoundIsTriedAgainWithoutAChange(t *testing.T) {
	was := firstRetry
	firstRetry = 20 * time.Millisecond
	defer func() { firstRetry = was }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wake := make(chan struct{}, 1)
	wake <- struct{}{}
	var rounds atomic.Int32
	var reports []error
	done := make(chan error, 1)
	go func() {
		done <- watchLoop(ctx, wake, make(chan error), func() error {
			if rounds.Add(1) < 3 {
				return errors.New("network is down")
			}
			cancel()
			return nil
		}, func(err error) { reports = append(reports, err) })
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the failed round was not tried again")
	}
	if rounds.Load() != 3 || len(reports) != 2 || !strings.Contains(reports[0].Error(), "will try again in 20ms") || !strings.Contains(reports[1].Error(), "will try again in 40ms") {
		t.Fatalf("rounds %d, reports %v", rounds.Load(), reports)
	}
}

func TestWaitsAsAskedWhenThereAreTooManyRequests(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = io.WriteString(w, `{"version":1,"data":{"id":"1","displayName":"Someone","kind":"user","scopes":["read"]}}`)
	}))
	defer server.Close()
	if _, err := newClient(server.URL, "t").me(context.Background()); err != nil || calls.Load() != 2 {
		t.Fatalf("calls %d, err %v", calls.Load(), err)
	}

	calls.Store(0)
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "3600")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer slow.Close()
	if _, err := newClient(slow.URL, "t").me(context.Background()); err == nil || calls.Load() != 1 {
		t.Fatalf("an hour is not worth waiting at a prompt: calls %d, err %v", calls.Load(), err)
	}
	if wait, ok := retryAfter("Wed, 21 Oct 2015 07:28:30 GMT", time.Date(2015, 10, 21, 7, 28, 0, 0, time.UTC)); !ok || wait != 30*time.Second {
		t.Fatalf("a date: %v %v", wait, ok)
	}
}

func TestWakesStopOnARefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"TOKEN_INVALID","message":"no"}}`))
	}))
	defer server.Close()
	err := wakesFromServer(context.Background(), newClient(server.URL, "t"), "shop", "", make(chan struct{}, 1))
	if !isAPIError(err, "TOKEN_INVALID") {
		t.Fatalf("err %v", err)
	}
}

func TestWakesFromDirWatchTheSmallFile(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for a poll")
	}
	root := t.TempDir()
	writeText(t, "one", root, metaDir, "CURRENT")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wake := make(chan struct{}, 1)
	go func() { _ = wakesFromDir(ctx, &dirSource{dir: root}, wake) }()
	time.Sleep(100 * time.Millisecond)
	writeText(t, "two", root, metaDir, "CURRENT")
	select {
	case <-wake:
	case <-time.After(dirPollPeriod * 3):
		t.Fatal("no wake-up")
	}
}

func TestBridgeMCPCarriesMessagesBothWays(t *testing.T) {
	var lock sync.Mutex
	versions := map[string]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&message)
		lock.Lock()
		versions[message.Method] = r.Header.Get("MCP-Protocol-Version") + "|" + r.Header.Get("Authorization")
		lock.Unlock()
		switch message.Method {
		case "initialize":
			_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18"}}`, message.ID)
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "streamed":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":\"streamed\"}\n\n", message.ID)
		case "fails":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"code":"NOPE","message":"not allowed"}}`))
		default:
			_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":"ok"}`, message.ID)
		}
	}))
	defer server.Close()
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize"}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"plain"}`,
		`{"jsonrpc":"2.0","id":3,"method":"streamed"}`,
		`{"jsonrpc":"2.0","id":4,"method":"fails"}`,
		`{"jsonrpc":"2.0","method":"fails"}`,
		`not json`,
	}, "\n")
	var output bytes.Buffer
	if err := bridgeMCP(context.Background(), newClient(server.URL, "pd_x"), strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	byID := map[string]map[string]any{}
	for _, line := range lines {
		var answer map[string]any
		if err := json.Unmarshal([]byte(line), &answer); err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		byID[fmt.Sprint(answer["id"])] = answer
	}
	if len(lines) != 5 {
		t.Fatalf("got %d lines: %q", len(lines), output.String())
	}
	if byID["3"]["result"] != "streamed" || byID["2"]["result"] != "ok" {
		t.Fatalf("answers %v", byID)
	}
	if message := byID["4"]["error"].(map[string]any)["message"]; !strings.Contains(message.(string), "NOPE") {
		t.Fatalf("error %v", message)
	}
	if byID["<nil>"]["error"].(map[string]any)["code"].(float64) != -32700 {
		t.Fatalf("bad JSON %v", byID["<nil>"])
	}
	if versions["plain"] != "2025-06-18|Bearer pd_x" {
		t.Fatalf("headers %q", versions["plain"])
	}
}

func TestConfigIsPrivateAndOverridable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "config.json")
	t.Setenv("PANDOCS_CONFIG", path)
	t.Setenv("PANDOCS_URL", "")
	t.Setenv("PANDOCS_TOKEN", "")
	if _, err := saveConfig(Config{Server: "https://a.example", Token: "secret"}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v", info.Mode())
		}
	}
	config, err := loadConfig()
	if err != nil || config.Server != "https://a.example" || config.Token != "secret" {
		t.Fatalf("%+v %v", config, err)
	}
	t.Setenv("PANDOCS_TOKEN", "from-env")
	if config, _ = loadConfig(); config.Token != "from-env" {
		t.Fatalf("%+v", config)
	}
	if err := removeConfig(); err != nil {
		t.Fatal(err)
	}
	if err := removeConfig(); err != nil {
		t.Fatalf("removing twice: %v", err)
	}
}

func TestServerAddressChecks(t *testing.T) {
	for _, bad := range []string{"", "docs.example.com", "ftp://x", "http://"} {
		if validServer(bad) == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	for address, plain := range map[string]bool{"https://x.example": false, "http://localhost:80": false, "http://127.0.0.1:8": false, "http://[::1]:8": false, "http://x.example": true, "http://10.0.0.1": true} {
		if plainTextOverNetwork(address) != plain {
			t.Errorf("%s: wanted %v", address, plain)
		}
	}
}

func TestArgumentsCanComeInAnyOrder(t *testing.T) {
	run := func(args ...string) (string, bool, []string) {
		var message string
		var flagged bool
		a := &app{in: strings.NewReader(""), out: io.Discard, err: io.Discard}
		_ = a
		set := newFlagSet()
		set.StringVar(&message, "m", "", "")
		set.BoolVar(&flagged, "x", false, "")
		positional, err := parse(set, args)
		if err != nil {
			t.Fatal(err)
		}
		return message, flagged, positional
	}
	message, flagged, positional := run("one", "-m", "text", "two", "-x", "three")
	if message != "text" || !flagged || !slices.Equal(positional, []string{"one", "two", "three"}) {
		t.Fatalf("%q %v %v", message, flagged, positional)
	}
}

func TestToolArguments(t *testing.T) {
	a := &app{in: strings.NewReader(`{"from":"stdin"}`)}
	got, err := toolArguments(a, []string{"-"}, []string{"count=3", "name=plain", `list=["a"]`, "yes=true"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(got)
	if string(raw) != `{"count":3,"from":"stdin","list":["a"],"name":"plain","yes":true}` {
		t.Fatalf("got %s", raw)
	}
	if _, err := toolArguments(a, nil, []string{"no-equals"}); err == nil {
		t.Fatal("accepted a bad --arg")
	}
	if _, err := toolArguments(a, []string{"{nope"}, nil); err == nil {
		t.Fatal("accepted bad JSON")
	}
}
