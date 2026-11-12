package main

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"strings"
)

// unpack writes a gzipped tar of pages under root and returns the hash of each file it wrote. Anything but a plain
// file at a safe path is skipped: the archive comes from somewhere else. It leaves what `keep` says it should not touch.
func unpack(stream io.Reader, root string, keep func(path string) bool) (map[string]string, error) {
	archive, err := gzip.NewReader(stream)
	if err != nil {
		return nil, fmt.Errorf("not a gzipped archive: %w", err)
	}
	defer archive.Close()
	written := map[string]string{}
	reader := tar.NewReader(archive)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return written, nil
		}
		if err != nil {
			return written, err
		}
		if header.Typeflag != tar.TypeReg || strings.HasPrefix(strings.ToLower(header.Name), metaDir+"/") || keep(header.Name) {
			continue
		}
		target, err := safeJoin(root, header.Name)
		if err != nil {
			continue
		}
		sum, err := streamToFile(target, reader, 0o644, "")
		if err != nil {
			return written, err
		}
		written[header.Name] = sum
	}
}
