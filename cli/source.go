package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ManifestFile and Manifest are the same on the server and in a shared directory.
type ManifestFile struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	SHA256     string `json:"sha256"`
	Size       int64  `json:"size"`
	DocumentID string `json:"documentId,omitempty"`
	Title      string `json:"title,omitempty"`
	Revision   int    `json:"revision,omitempty"`
}

type Manifest struct {
	Space struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"space"`
	Cursor string         `json:"cursor"`
	Files  []ManifestFile `json:"files"`
}

// fetched is one file's content, and which revision that turned out to be: it may be newer than the manifest said.
type fetched struct {
	body     io.ReadCloser
	revision int
}

// source is where a space comes from: the server, or a directory published by it.
type source interface {
	manifest(ctx context.Context) (*Manifest, error)
	file(ctx context.Context, file ManifestFile) (*fetched, error)
	// pack gives every page in one archive, or nil when there is none to be had.
	pack(ctx context.Context) (io.ReadCloser, error)
}

type httpSource struct {
	client *Client
	space  string
}

func (s *httpSource) manifest(ctx context.Context) (*Manifest, error) {
	var manifest Manifest
	if err := s.client.get(ctx, "spaces/"+segment(s.space)+"/manifest", &manifest); err != nil {
		return nil, err
	}
	return &manifest, nil
}

func (s *httpSource) file(ctx context.Context, file ManifestFile) (*fetched, error) {
	if file.Kind == "asset" {
		response, err := s.client.open(ctx, http.MethodGet, apiBase+"spaces/"+segment(s.space)+"/assets/"+segment(file.SHA256), requestOptions{})
		if err != nil {
			return nil, err
		}
		return &fetched{body: response.Body}, nil
	}
	response, err := s.client.open(ctx, http.MethodGet, apiBase+"documents/"+segment(file.DocumentID)+"/content", requestOptions{})
	if err != nil {
		return nil, err
	}
	revision, _ := strconv.Atoi(response.Header.Get("X-Pandocs-Revision"))
	return &fetched{body: response.Body, revision: revision}, nil
}

func (s *httpSource) pack(ctx context.Context) (io.ReadCloser, error) {
	response, err := s.client.open(ctx, http.MethodGet, apiBase+"spaces/"+segment(s.space)+"/snapshot", requestOptions{})
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

// dirSource reads what a server published to a shared directory, for a machine with the mount and no way to the server.
type dirSource struct {
	dir string
}

func (s *dirSource) manifest(context.Context) (*Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, metaDir, "MANIFEST.json"))
	if err != nil {
		return nil, fmt.Errorf("%s does not look like a published space: %w", s.dir, err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("%s has an unreadable manifest: %w", s.dir, err)
	}
	return &manifest, nil
}

func (s *dirSource) file(_ context.Context, file ManifestFile) (*fetched, error) {
	path, err := safeJoin(s.dir, file.Path)
	if err != nil {
		return nil, err
	}
	body, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return &fetched{body: body, revision: file.Revision}, nil
}

func (s *dirSource) pack(context.Context) (io.ReadCloser, error) {
	body, err := os.Open(filepath.Join(s.dir, metaDir, "pack.tar.gz"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	return body, err
}

// current is a small file that changes whenever anything in the directory does.
func (s *dirSource) current() string {
	raw, err := os.ReadFile(filepath.Join(s.dir, metaDir, "CURRENT"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
