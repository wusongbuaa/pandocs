// Command probe drives the shared-directory test from inside the network: it changes pages through the API and watches
// what another NFS client sees, on one clock.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type api struct {
	server string
	token  string
	client *http.Client
}

func (a *api) call(method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		raw, _ := json.Marshal(input)
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, a.server+"/api/v1/"+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.token)
	if method == http.MethodPut {
		var key [8]byte
		rand.Read(key[:])
		request.Header.Set("Idempotency-Key", hex.EncodeToString(key[:]))
	}
	response, err := a.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %d %s", method, path, response.StatusCode, raw)
	}
	if output == nil {
		return nil
	}
	var payload struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	return json.Unmarshal(payload.Data, output)
}

type saved struct {
	Document struct {
		ID string `json:"id"`
	} `json:"document"`
	Revision struct {
		No int `json:"no"`
	} `json:"revision"`
}

type manifestFile struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	SHA256     string `json:"sha256"`
	DocumentID string `json:"documentId"`
	Revision   int    `json:"revision"`
}

type manifest struct {
	Files []manifestFile `json:"files"`
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func setup(server string) {
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	form := url.Values{"displayName": {"Test"}, "email": {"test@example.test"}, "password": {"test-password-for-the-rig"}, "next": {"/"}}
	for attempt := 0; ; attempt++ {
		response, err := client.PostForm(server+"/setup", form)
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusSeeOther && response.Header.Get("Location") == "/" {
				break
			}
			// Already set up by an earlier run against the same containers.
			if response, err = client.PostForm(server+"/login", form); err == nil {
				response.Body.Close()
				if response.StatusCode == http.StatusSeeOther && response.Header.Get("Location") == "/" {
					break
				}
			}
		}
		if attempt > 120 {
			fatal("the server never came up: %v", err)
		}
		time.Sleep(time.Second)
	}
	raw, _ := json.Marshal(map[string]any{"name": "rig", "scopes": []string{"read", "write"}})
	request, _ := http.NewRequest(http.MethodPost, server+"/api/v1/account/tokens", bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		fatal("%v", err)
	}
	defer response.Body.Close()
	var payload struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil || payload.Data.Token == "" {
		fatal("no token: %v", err)
	}
	fmt.Print(payload.Data.Token)
}

func page(index, size int) string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "# Page %d\n\n", index)
	for builder.Len() < size {
		fmt.Fprintf(&builder, "Paragraph about page %d, with some words to search for later. needle%d\n\n", index, builder.Len()%97)
	}
	return builder.String()
}

func seed(a *api, space string, count, size int) {
	if err := a.call(http.MethodPost, "spaces", map[string]any{"slug": space, "name": "Rig", "defaultRole": "viewer"}, nil); err != nil {
		fatal("%v", err)
	}
	var next atomic.Int64
	var group sync.WaitGroup
	started := time.Now()
	for range 16 {
		group.Add(1)
		go func() {
			defer group.Done()
			for {
				index := int(next.Add(1))
				if index > count {
					return
				}
				section := index % 100
				if err := a.call(http.MethodPost, "spaces/"+space+"/documents", map[string]any{"title": fmt.Sprintf("Page %d", index), "slug": fmt.Sprintf("p%d-%d", section, index), "markdown": page(index, size)}, nil); err != nil {
					fatal("%v", err)
				}
			}
		}()
	}
	group.Wait()
	fmt.Printf("seeded %d pages of %d bytes in %.1fs\n", count, size, time.Since(started).Seconds())
}

var pollEvery = 5 * time.Millisecond

func percentile(values []float64, share float64) float64 {
	sort.Float64s(values)
	return values[min(int(float64(len(values))*share), len(values)-1)]
}

func summary(name string, values []float64) {
	if len(values) == 0 {
		fmt.Printf("%-28s no samples\n", name)
		return
	}
	fmt.Printf("%-28s p50 %7.0f ms   p90 %7.0f ms   max %7.0f ms   (%d samples)\n", name, percentile(values, 0.5), percentile(values, 0.9), percentile(values, 1), len(values))
}

// waitFor polls until check is true, returning milliseconds since start, or a negative value on timeout.
func waitFor(start time.Time, limit time.Duration, check func() bool) float64 {
	for time.Since(start) < limit {
		if check() {
			return float64(time.Since(start).Microseconds()) / 1000
		}
		time.Sleep(pollEvery)
	}
	return -1
}

// latency changes a page through the API, then asks another NFS client when it can see that.
func latency(a *api, space, mount string, count int) {
	var current manifest
	if err := a.call(http.MethodGet, "spaces/"+space+"/manifest", nil, &current); err != nil {
		fatal("%v", err)
	}
	var documents []manifestFile
	for _, file := range current.Files {
		if file.Kind == "document" {
			documents = append(documents, file)
		}
	}
	root := filepath.Join(mount, space)
	var fileTimes, currentTimes, manifestTimes []float64
	timeouts := 0
	for attempt := range count {
		chosen := documents[rand.Intn(len(documents))]
		marker := fmt.Sprintf("marker-%d-%d", attempt, rand.Int63())
		before, _ := os.ReadFile(filepath.Join(root, ".pandocs", "CURRENT"))
		var response struct {
			Revision struct {
				No int `json:"no"`
			} `json:"revision"`
		}
		var view struct {
			Revision struct {
				No int `json:"no"`
			} `json:"revision"`
		}
		if err := a.call(http.MethodGet, "documents/"+chosen.DocumentID, nil, &view); err != nil {
			fatal("%v", err)
		}
		start := time.Now()
		if err := a.call(http.MethodPut, "documents/"+chosen.DocumentID+"/content", map[string]any{"markdown": page(attempt, 4000) + marker + "\n", "expectedRevision": view.Revision.No}, &response); err != nil {
			fatal("%v", err)
		}
		var wg sync.WaitGroup
		var inFile, inCurrent, inManifest float64
		wg.Add(3)
		go func() {
			defer wg.Done()
			inFile = waitFor(start, 30*time.Second, func() bool {
				raw, err := os.ReadFile(filepath.Join(root, chosen.Path))
				return err == nil && bytes.Contains(raw, []byte(marker))
			})
		}()
		go func() {
			defer wg.Done()
			inCurrent = waitFor(start, 30*time.Second, func() bool {
				raw, err := os.ReadFile(filepath.Join(root, ".pandocs", "CURRENT"))
				return err == nil && !bytes.Equal(raw, before)
			})
		}()
		go func() {
			defer wg.Done()
			inManifest = waitFor(start, 30*time.Second, func() bool {
				raw, err := os.ReadFile(filepath.Join(root, ".pandocs", "MANIFEST.json"))
				if err != nil {
					return false
				}
				var seen manifest
				if json.Unmarshal(raw, &seen) != nil {
					return false
				}
				for _, file := range seen.Files {
					if file.Path == chosen.Path {
						return file.Revision >= response.Revision.No
					}
				}
				return false
			})
		}()
		wg.Wait()
		if inFile < 0 || inCurrent < 0 || inManifest < 0 {
			timeouts++
			continue
		}
		fileTimes = append(fileTimes, inFile)
		currentTimes = append(currentTimes, inCurrent)
		manifestTimes = append(manifestTimes, inManifest)
	}
	summary("save -> file readable", fileTimes)
	summary("save -> CURRENT changed", currentTimes)
	summary("save -> MANIFEST names it", manifestTimes)
	if timeouts > 0 {
		fatal("%d changes never showed up", timeouts)
	}
}

// selfChecked is a big page whose first line is the hash of the rest, so a reader can tell a whole file from half of one.
func selfChecked(round int, size int) string {
	var builder strings.Builder
	for builder.Len() < size {
		fmt.Fprintf(&builder, "Round %d, keeping this page large enough that a partial read would be easy to catch.\n\n", round)
	}
	body := builder.String()
	sum := sha256.Sum256([]byte(body))
	return "<!-- " + hex.EncodeToString(sum[:]) + " -->\n\n" + body
}

func wholeFile(raw []byte) bool {
	text := string(raw)
	if !strings.HasPrefix(text, "<!-- ") || len(text) < 75 {
		return false
	}
	sum := sha256.Sum256([]byte(text[75:]))
	return text[5:69] == hex.EncodeToString(sum[:])
}

// torn rewrites one large page as fast as the server takes it, while readers on this client read it without pause.
func torn(a *api, space, mount string, seconds int) {
	const size = 512 * 1024
	var created saved
	if err := a.call(http.MethodPost, "spaces/"+space+"/documents", map[string]any{"title": "Big", "slug": "big-self-checked", "markdown": selfChecked(0, size)}, &created); err != nil {
		fatal("%v", err)
	}
	target := filepath.Join(mount, space, "big-self-checked.md")
	// By listing, not by asking for the path: that can keep failing for up to a minute, as the docs warn readers.
	if waitFor(time.Now(), 30*time.Second, func() bool {
		entries, err := os.ReadDir(filepath.Join(mount, space))
		if err != nil {
			return false
		}
		for _, entry := range entries {
			if entry.Name() == "big-self-checked.md" {
				return true
			}
		}
		return false
	}) < 0 {
		fatal("the page never appeared")
	}
	stop := make(chan struct{})
	var reads, bad, failed atomic.Int64
	var group sync.WaitGroup
	for range 8 {
		group.Add(1)
		go func() {
			defer group.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				raw, err := os.ReadFile(target)
				if err != nil {
					failed.Add(1)
					continue
				}
				reads.Add(1)
				if !wholeFile(raw) {
					bad.Add(1)
				}
			}
		}()
	}
	writes := 0
	revision := created.Revision.No
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	for time.Now().Before(deadline) {
		var response saved
		if err := a.call(http.MethodPut, "documents/"+created.Document.ID+"/content", map[string]any{"markdown": selfChecked(revision+1, size), "expectedRevision": revision}, &response); err != nil {
			fatal("%v", err)
		}
		revision = response.Revision.No
		writes++
		time.Sleep(50 * time.Millisecond)
	}
	close(stop)
	group.Wait()
	fmt.Printf("%d saves of a 512 KB page, %d reads on another client: %d torn, %d failed\n", writes, reads.Load(), bad.Load(), failed.Load())
	if bad.Load() > 0 {
		fatal("a reader saw half a file")
	}
}

// compare checks a directory against the server, file by file, and waits for it to catch up.
func compare(a *api, space, mount string, limit time.Duration) {
	root := filepath.Join(mount, space)
	started := time.Now()
	last := ""
	for {
		var current manifest
		if err := a.call(http.MethodGet, "spaces/"+space+"/manifest", nil, &current); err != nil {
			last = err.Error()
		} else {
			last = differences(root, current)
		}
		if last == "" {
			fmt.Printf("%s matches the server (%d files) after %.1fs\n", root, len(current.Files), time.Since(started).Seconds())
			return
		}
		if time.Since(started) > limit {
			fatal("%s does not match the server: %s", root, last)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func differences(root string, current manifest) string {
	wanted := map[string]bool{}
	for _, file := range current.Files {
		wanted[file.Path] = true
		raw, err := os.ReadFile(filepath.Join(root, file.Path))
		if err != nil {
			return err.Error()
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != file.SHA256 {
			return file.Path + " differs"
		}
	}
	var extra string
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".pandocs" {
				return filepath.SkipDir
			}
			return nil
		}
		relative, _ := filepath.Rel(root, path)
		if relative != "llms.txt" && !wanted[relative] {
			extra = relative
		}
		return nil
	})
	if extra != "" {
		return extra + " should not be there"
	}
	return ""
}

// waitForText says how soon a file on this client holds some text. Asking for one file, unlike compare, costs next to nothing.
func waitForText(path, text string, limit time.Duration) {
	elapsed := waitFor(time.Now(), limit, func() bool {
		raw, err := os.ReadFile(path)
		return err == nil && bytes.Contains(raw, []byte(text))
	})
	if elapsed < 0 {
		fatal("%s did not get %q within %s", path, text, limit)
	}
	fmt.Printf("%.1f s\n", elapsed/1000)
}

func edit(a *api, space, path, text string) {
	var found struct {
		ID string `json:"id"`
	}
	if err := a.call(http.MethodGet, "spaces/"+space+"/resolve?path="+url.QueryEscape(path), nil, &found); err != nil {
		fatal("%v", err)
	}
	var view struct {
		Revision struct {
			No int `json:"no"`
		} `json:"revision"`
	}
	if err := a.call(http.MethodGet, "documents/"+found.ID, nil, &view); err != nil {
		fatal("%v", err)
	}
	if err := a.call(http.MethodPut, "documents/"+found.ID+"/content", map[string]any{"markdown": text, "expectedRevision": view.Revision.No}, nil); err != nil {
		fatal("%v", err)
	}
}

func main() {
	args := os.Args[1:]
	if len(args) < 2 {
		fatal("usage: probe <command> <server> ...")
	}
	command, server := args[0], args[1]
	if value, err := strconv.Atoi(os.Getenv("PROBE_POLL_MS")); err == nil && value > 0 {
		pollEvery = time.Duration(value) * time.Millisecond
	}
	if command == "setup" {
		setup(server)
		return
	}
	a := &api{server: server, token: os.Getenv("PANDOCS_TOKEN"), client: &http.Client{Timeout: 60 * time.Second}}
	number := func(at int) int {
		value, err := strconv.Atoi(args[at])
		if err != nil {
			fatal("%v", err)
		}
		return value
	}
	switch command {
	case "seed":
		seed(a, args[2], number(3), number(4))
	case "latency":
		latency(a, args[2], args[3], number(4))
	case "torn":
		torn(a, args[2], args[3], number(4))
	case "compare":
		compare(a, args[2], args[3], time.Duration(number(4))*time.Second)
	case "edit":
		edit(a, args[2], args[3], args[4])
	case "wait-text":
		waitForText(args[2], args[3], time.Duration(number(4))*time.Second)
	default:
		fatal("unknown command %s", command)
	}
}
