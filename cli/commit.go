package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
)

type commitOptions struct {
	message     string
	propose     bool
	allowDelete bool
	strict      bool
	// The files were edited to keep what the server had when they conflicted, so they are sent as made from that.
	resolved bool
	only     []string
	// Everything goes into one change set, new or already there, rather than being saved or proposed page by page.
	changeSetTitle string
	changeSetID    string
}

// CommitResult is what happened to one file.
type CommitResult struct {
	Path     string `json:"path"`
	Action   string `json:"action"`
	Revision int    `json:"revision,omitempty"`
	ID       string `json:"id,omitempty"`
	Message  string `json:"message,omitempty"`
}

type savedRevision struct {
	Document struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	} `json:"document"`
	Revision struct {
		No     int    `json:"no"`
		SHA256 string `json:"sha256"`
	} `json:"revision"`
	Merged      bool `json:"merged"`
	Diagnostics []struct {
		Line    int    `json:"line"`
		Message string `json:"message"`
	} `json:"diagnostics"`
}

func firstHeading(markdown []byte) string {
	for _, line := range bytes.Split(markdown, []byte("\n")) {
		text := strings.TrimSpace(string(line))
		if strings.HasPrefix(text, "# ") {
			return strings.TrimSpace(text[2:])
		}
	}
	return ""
}

func describeDiagnostics(saved savedRevision) string {
	var parts []string
	for _, problem := range saved.Diagnostics {
		parts = append(parts, fmt.Sprintf("line %d: %s", problem.Line, problem.Message))
	}
	return strings.Join(parts, "; ")
}

// committer sends what changed in a copy back to the server, one file at a time, naming the revision each edit started
// from. People's edits become revisions, merged if the page moved on. Agents' edits become proposals for a person to decide.
type committer struct {
	client  *Client
	root    string
	state   *State
	options commitOptions
	asAgent bool
	parents map[string]bool
}

func (c *committer) usesChangeSet() bool {
	return c.options.changeSetTitle != "" || c.options.changeSetID != ""
}

// changeSet makes the change set the first time something needs to go in it, so a commit with nothing to say makes none.
func (c *committer) changeSet(ctx context.Context) (string, error) {
	if c.options.changeSetID != "" {
		return c.options.changeSetID, nil
	}
	input := map[string]any{"title": c.options.changeSetTitle}
	if c.options.message != "" {
		input["description"] = c.options.message
	}
	var made struct {
		ID string `json:"id"`
	}
	if err := c.client.call(ctx, http.MethodPost, "spaces/"+segment(c.state.Space)+"/change-sets", input, &made, false); err != nil {
		return "", err
	}
	c.options.changeSetID = made.ID
	return made.ID, nil
}

// inChangeSet adds one file to the change set. Nothing happens to the page until someone merges it, so this copy keeps
// thinking of the file as changed, and remembers not to send the same text again.
func (c *committer) inChangeSet(ctx context.Context, change Change) CommitResult {
	file := change.Path
	fail := func(err error) CommitResult { return CommitResult{Path: file, Action: "failed", Message: err.Error()} }
	input := map[string]any{}
	sum := ""
	base := c.state.Files[file]
	if change.Status == "deleted" {
		if !c.options.allowDelete {
			return CommitResult{Path: file, Action: "skipped", Message: "deleted here: pass --delete to delete the page too"}
		}
		input["document"], input["baseRevision"], input["delete"] = base.DocumentID, base.Revision, true
		sum = "deleted"
	} else {
		target, err := safeJoin(c.root, file)
		if err != nil {
			return fail(err)
		}
		content, err := os.ReadFile(target)
		if err != nil {
			return fail(err)
		}
		sum = hashBytes(content)
		input["markdown"] = string(content)
		if change.Status == "added" {
			pagePath := strings.TrimSuffix(file, path.Ext(file))
			title := firstHeading(content)
			if title == "" {
				title = path.Base(pagePath)
			}
			input["path"], input["title"] = pagePath, title
		} else {
			if base.Revision == 0 {
				return CommitResult{Path: file, Action: "failed", Message: "this page exists on the server but this file did not come from it: move the file aside and sync again"}
			}
			input["document"], input["baseRevision"] = base.DocumentID, base.Revision
		}
	}
	if c.state.Submitted[file] == sum && c.options.changeSetTitle == "" {
		return CommitResult{Path: file, Action: "unchanged", Message: "already in the change set"}
	}
	id, err := c.changeSet(ctx)
	if err != nil {
		return fail(err)
	}
	if err := c.client.call(ctx, http.MethodPost, "change-sets/"+segment(id)+"/pages", input, nil, false); err != nil {
		return fail(err)
	}
	if c.state.Submitted == nil {
		c.state.Submitted = map[string]string{}
	}
	c.state.Submitted[file] = sum
	return CommitResult{Path: file, Action: "added", ID: id, Message: "in the change set, waiting for review"}
}

func (c *committer) ensureParents(ctx context.Context, parent string) error {
	return ensureParentPages(ctx, c.client, c.state.Space, parent, c.parents)
}

// ensureParentPages makes any pages missing above a path, since a page has to have somewhere to go. known saves asking
// about the same ones again.
func ensureParentPages(ctx context.Context, client *Client, space, parent string, known map[string]bool) error {
	if parent == "" || parent == "." {
		return nil
	}
	current := ""
	for _, part := range strings.Split(parent, "/") {
		above := current
		if current == "" {
			current = part
		} else {
			current = current + "/" + part
		}
		if known[current] {
			continue
		}
		var found struct {
			ID string `json:"id"`
		}
		err := client.get(ctx, "spaces/"+segment(space)+"/resolve?path="+url.QueryEscape(current), &found)
		if err != nil {
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
				return err
			}
			input := map[string]any{"title": part, "slug": part, "markdown": ""}
			if above != "" {
				input["parentPath"] = above
			}
			if err := client.call(ctx, http.MethodPost, "spaces/"+segment(space)+"/documents", input, nil, false); err != nil {
				return err
			}
		}
		known[current] = true
	}
	return nil
}

func (c *committer) added(ctx context.Context, file string) CommitResult {
	target, err := safeJoin(c.root, file)
	if err != nil {
		return CommitResult{Path: file, Action: "failed", Message: err.Error()}
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return CommitResult{Path: file, Action: "failed", Message: err.Error()}
	}
	pagePath := strings.TrimSuffix(file, path.Ext(file))
	slug := path.Base(pagePath)
	parent := path.Dir(pagePath)
	title := firstHeading(content)
	if title == "" {
		title = slug
	}
	if c.asAgent || c.options.propose {
		sum := hashBytes(content)
		if c.state.Submitted[file] == sum {
			return CommitResult{Path: file, Action: "unchanged", Message: "already submitted for review"}
		}
		pageTarget := map[string]any{"slug": slug, "title": title}
		if parent != "." {
			pageTarget["parentPath"] = parent
		}
		input := map[string]any{"filename": path.Base(file), "markdown": string(content), "contentType": "text/markdown", "target": pageTarget}
		var job struct {
			ID string `json:"id"`
		}
		if err := c.client.call(ctx, http.MethodPost, "spaces/"+segment(c.state.Space)+"/imports", input, &job, false); err != nil {
			return CommitResult{Path: file, Action: "failed", Message: err.Error()}
		}
		if c.state.Submitted == nil {
			c.state.Submitted = map[string]string{}
		}
		c.state.Submitted[file] = sum
		return CommitResult{Path: file, Action: "submitted", ID: job.ID, Message: "waiting for someone with edit rights"}
	}
	if err := c.ensureParents(ctx, parent); err != nil {
		return CommitResult{Path: file, Action: "failed", Message: err.Error()}
	}
	input := map[string]any{"title": title, "slug": slug, "markdown": string(content)}
	if parent != "." {
		input["parentPath"] = parent
	}
	if c.options.message != "" {
		input["message"] = c.options.message
	}
	if c.options.strict {
		input["strict"] = true
	}
	var saved savedRevision
	if err := c.client.call(ctx, http.MethodPost, "spaces/"+segment(c.state.Space)+"/documents", input, &saved, false); err != nil {
		return CommitResult{Path: file, Action: "failed", Message: err.Error()}
	}
	c.state.Files[file] = FileState{SHA256: saved.Revision.SHA256, Revision: saved.Revision.No, DocumentID: saved.Document.ID, Kind: "document"}
	delete(c.state.Submitted, file)
	return CommitResult{Path: file, Action: "created", Revision: saved.Revision.No, Message: describeDiagnostics(saved)}
}

// conflictRevision is the revision the server had when a commit conflicted with it.
func conflictRevision(err error, otherwise int) int {
	var apiErr *APIError
	var details struct {
		CurrentRevision int `json:"currentRevision"`
	}
	if !errors.As(err, &apiErr) || json.Unmarshal(apiErr.Details, &details) != nil || details.CurrentRevision == 0 {
		return otherwise
	}
	return details.CurrentRevision
}

func (c *committer) modified(ctx context.Context, file string) CommitResult {
	target, err := safeJoin(c.root, file)
	if err != nil {
		return CommitResult{Path: file, Action: "failed", Message: err.Error()}
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return CommitResult{Path: file, Action: "failed", Message: err.Error()}
	}
	base := c.state.Files[file]
	if base.Revision == 0 {
		return CommitResult{Path: file, Action: "failed", Message: "this page exists on the server but this file did not come from it: move the file aside, sync, then copy your changes in"}
	}
	if c.asAgent || c.options.propose {
		sum := hashBytes(content)
		if base.Proposed == sum {
			return CommitResult{Path: file, Action: "unchanged", Message: "already proposed"}
		}
		input := map[string]any{"baseRevision": base.Revision, "markdown": string(content)}
		if c.options.message != "" {
			input["rationale"] = c.options.message
		}
		var proposal struct {
			ID string `json:"id"`
		}
		if err := c.client.call(ctx, http.MethodPost, "documents/"+segment(base.DocumentID)+"/proposals", input, &proposal, true); err != nil {
			return CommitResult{Path: file, Action: "failed", Message: err.Error()}
		}
		base.Proposed = sum
		c.state.Files[file] = base
		return CommitResult{Path: file, Action: "proposed", ID: proposal.ID, Message: "waiting for someone with edit rights"}
	}
	// Until someone says the conflict is resolved, the file is still made from the version it started from, so the
	// server keeps merging rather than take a file that may not have their changes in it.
	expected := base.Revision
	if c.options.resolved && base.Resolving > 0 {
		expected = base.Resolving
	}
	input := map[string]any{"markdown": string(content), "expectedRevision": expected, "merge": true}
	if c.options.message != "" {
		input["message"] = c.options.message
	}
	if c.options.strict {
		input["strict"] = true
	}
	var saved savedRevision
	if err := c.client.call(ctx, http.MethodPut, "documents/"+segment(base.DocumentID)+"/content", input, &saved, true); err != nil {
		if isAPIError(err, "MERGE_CONFLICT") {
			base.Resolving = conflictRevision(err, base.Resolving)
			c.state.Files[file] = base
			page := path.Join(c.state.Space, strings.TrimSuffix(file, path.Ext(file)))
			return CommitResult{Path: file, Action: "conflict", Revision: base.Resolving, Message: fmt.Sprintf("someone changed the same place: run `pandocs get %s --revision %d` to see their version, work their changes into this file, and commit it with --resolved", page, base.Resolving)}
		}
		return CommitResult{Path: file, Action: "failed", Message: err.Error()}
	}
	entry := FileState{SHA256: saved.Revision.SHA256, Revision: saved.Revision.No, DocumentID: base.DocumentID, Kind: "document"}
	action := "saved"
	if saved.Merged {
		action = "merged"
		// The server's merged text is now the page, and this copy should say the same.
		got, err := (&httpSource{client: c.client, space: c.state.Space}).file(ctx, ManifestFile{Kind: "document", DocumentID: base.DocumentID})
		if err != nil {
			c.state.Files[file] = entry
			return CommitResult{Path: file, Action: "failed", Message: "merged on the server, but could not fetch the result: run `pandocs sync`: " + err.Error()}
		}
		defer got.body.Close()
		expect := ""
		if got.revision == saved.Revision.No {
			expect = saved.Revision.SHA256
		}
		sum, err := streamToFile(target, got.body, 0o644, expect)
		if err != nil {
			return CommitResult{Path: file, Action: "failed", Message: err.Error()}
		}
		entry.SHA256 = sum
		if got.revision != 0 {
			entry.Revision = got.revision
		}
	}
	c.state.Files[file] = entry
	return CommitResult{Path: file, Action: action, Revision: entry.Revision, Message: describeDiagnostics(saved)}
}

func (c *committer) deleted(ctx context.Context, file string) CommitResult {
	if !c.options.allowDelete {
		return CommitResult{Path: file, Action: "skipped", Message: "deleted here: pass --delete to delete the page too"}
	}
	if c.asAgent {
		return CommitResult{Path: file, Action: "failed", Message: "an agent cannot delete pages: ask someone with edit rights"}
	}
	base := c.state.Files[file]
	if err := c.client.call(ctx, http.MethodDelete, "documents/"+segment(base.DocumentID), nil, nil, false); err != nil {
		return CommitResult{Path: file, Action: "failed", Message: err.Error()}
	}
	delete(c.state.Files, file)
	return CommitResult{Path: file, Action: "deleted"}
}

func commitChanges(ctx context.Context, client *Client, root string, state *State, options commitOptions) ([]CommitResult, error) {
	me, err := client.me(ctx)
	if err != nil {
		return nil, err
	}
	changes, err := localChanges(root, state)
	if err != nil {
		return nil, err
	}
	wanted := func(file string) bool {
		if len(options.only) == 0 {
			return true
		}
		for _, only := range options.only {
			if file == only || strings.HasPrefix(file, strings.TrimSuffix(only, "/")+"/") {
				return true
			}
		}
		return false
	}
	// A parent has to exist before the pages under it.
	sort.SliceStable(changes, func(a, b int) bool {
		return strings.Count(changes[a].Path, "/") < strings.Count(changes[b].Path, "/")
	})
	work := committer{client: client, root: root, state: state, options: options, asAgent: me.Kind == "agent", parents: map[string]bool{}}
	results := []CommitResult{}
	for _, change := range changes {
		if !wanted(change.Path) {
			continue
		}
		var result CommitResult
		switch {
		case work.usesChangeSet():
			result = work.inChangeSet(ctx, change)
		case change.Status == "added":
			result = work.added(ctx, change.Path)
		case change.Status == "modified":
			result = work.modified(ctx, change.Path)
		default:
			result = work.deleted(ctx, change.Path)
		}
		results = append(results, result)
		// Each answer from the server is a fact from then on, whatever happens to the next file.
		if err := saveState(root, state); err != nil {
			return results, err
		}
	}
	return results, nil
}

func printJSON(out interface{ Write([]byte) (int, error) }, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
