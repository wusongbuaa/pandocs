package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const metaDir = ".pandocs"

var reservedName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com\d|lpt\d)(\.|$)`)

// safeJoin turns a path from a manifest or an archive into one under root, or refuses. Those come from a server or a
// shared directory, and a mistake here would let them write anywhere this user can.
func safeJoin(root, path string) (string, error) {
	if path == "" || strings.ContainsAny(path, "\\:\x00") || strings.HasPrefix(path, "/") || !filepath.IsLocal(filepath.FromSlash(path)) {
		return "", fmt.Errorf("refusing path %q", path)
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		// Windows drops trailing dots and spaces when it opens a file, so `.. ` would be `..` there, and older versions
		// open a device for `con.md`. The server's rules for names exclude all of these, so nothing real ends up here.
		// On macOS and Windows `.PANDOCS` is this tool's own folder too.
		if part == "" || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || strings.EqualFold(strings.TrimRight(part, ". "), metaDir) || reservedName.MatchString(part) {
			return "", fmt.Errorf("refusing path %q", path)
		}
	}
	// A link on the way would take the file wherever it points, outside this copy too, so like git this never goes
	// through one. Only plain folders lead to a plain file.
	at := root
	for index, part := range parts {
		at = filepath.Join(at, part)
		info, err := os.Lstat(at)
		if errors.Is(err, fs.ErrNotExist) {
			break
		}
		if err != nil {
			return "", err
		}
		if index < len(parts)-1 && !info.IsDir() || index == len(parts)-1 && !info.Mode().IsRegular() {
			return "", fmt.Errorf("refusing path %q: %s is a link or not a plain folder or file", path, strings.Join(parts[:index+1], "/"))
		}
	}
	return filepath.Join(root, filepath.FromSlash(path)), nil
}

// writeFileAtomic replaces a file in one step, so that nothing ever reads half of it.
func writeFileAtomic(target string, content []byte, mode fs.FileMode) error {
	_, err := streamToFile(target, strings.NewReader(string(content)), mode, "")
	return err
}

// streamToFile does the same from a reader, returning the hash of what it wrote. Given the hash it should have, a file
// that arrived different is not put in place at all.
func streamToFile(target string, source io.Reader, mode fs.FileMode, expect string) (string, error) {
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(dir, ".pandocs-tmp-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(temporary.Name())
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(temporary, hash), source); err != nil {
		temporary.Close()
		return "", err
	}
	// On disk before it takes the name, or a crash just after could leave an empty file where a page was.
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	sum := hex.EncodeToString(hash.Sum(nil))
	if expect != "" && sum != expect {
		return "", fmt.Errorf("%s arrived damaged: expected %s, got %s", filepath.Base(target), expect, sum)
	}
	if err := os.Chmod(temporary.Name(), mode); err != nil {
		return "", err
	}
	if err := os.Rename(temporary.Name(), target); err != nil {
		return "", err
	}
	return sum, nil
}

// hashFile is empty for a file that is not there.
func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func hashBytes(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// removeWithParents removes a file and any folders that leaves empty, up to root.
func removeWithParents(root, target string) error {
	if err := os.Remove(target); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	for dir := filepath.Dir(target); dir != root && strings.HasPrefix(dir, root); dir = filepath.Dir(dir) {
		if err := os.Remove(dir); err != nil {
			break
		}
	}
	return nil
}
