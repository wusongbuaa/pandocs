package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	// How often to look at a conversion, more and more slowly, and for how long. One that is retried on the server can
	// wait there for a long time, and a terminal should not wait with it.
	importPollPeriod = 500 * time.Millisecond
	importPollMost   = 5 * time.Second
	importWaitLimit  = 30 * time.Minute
)

type importJob struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	ErrorCode    string `json:"errorCode"`
	ErrorMessage string `json:"errorMessage"`
	DocumentID   string `json:"documentId"`
	DraftTitle   string `json:"draftTitle"`
	Report       struct {
		Warnings []string `json:"warnings"`
	} `json:"report"`
}

// importFile sends a file to be converted. Conversion runs in the background, so this waits for it. The result is a draft
// for someone to look over, unless they asked to publish it and may.
func (a *app) importFile(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("import", flag.ContinueOnError)
	asPath := set.String("as", "", "")
	toPage := set.String("to", "", "")
	publish := set.Bool("publish", false, "")
	asJSON := set.Bool("json", false, "")
	positional, err := parse(set, args)
	if err != nil {
		return err
	}
	if len(positional) != 2 {
		return usageError("usage: pandocs import <space> <file> [--as path/of/new/page] [--to existing/page] [--publish]")
	}
	if *asPath != "" && *toPage != "" {
		return usageError("--as makes a new page and --to replaces one, so give only one")
	}
	space, file := positional[0], positional[1]
	content, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	client, err := a.connect()
	if err != nil {
		return err
	}

	target := map[string]any{}
	if *toPage != "" {
		id, err := resolvePage(ctx, client, space+"/"+*toPage)
		if err != nil {
			return err
		}
		target["documentId"] = id
	}
	if *asPath != "" {
		trimmed := strings.Trim(strings.TrimSuffix(*asPath, ".md"), "/")
		target["slug"] = trimmed[strings.LastIndex(trimmed, "/")+1:]
		if at := strings.LastIndex(trimmed, "/"); at >= 0 {
			target["parentPath"] = trimmed[:at]
		}
	}

	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", filepath.Base(file))
	if err != nil {
		return err
	}
	if _, err := part.Write(content); err != nil {
		return err
	}
	targetJSON, err := json.Marshal(target)
	if err != nil {
		return err
	}
	if err := form.WriteField("target", string(targetJSON)); err != nil {
		return err
	}
	if err := form.Close(); err != nil {
		return err
	}
	response, err := client.open(ctx, http.MethodPost, apiBase+"spaces/"+segment(space)+"/imports", requestOptions{body: body.Bytes(), contentType: form.FormDataContentType()})
	if err != nil {
		return err
	}
	var payload struct {
		Data importJob `json:"data"`
	}
	err = json.NewDecoder(response.Body).Decode(&payload)
	response.Body.Close()
	if err != nil {
		return err
	}

	job := payload.Data
	period := importPollPeriod
	giveUp := time.After(importWaitLimit)
	for job.Status == "queued" || job.Status == "running" || job.Status == "retry_wait" {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-giveUp:
			return fmt.Errorf("the conversion is still %s after %s, and goes on on the server as import %s", strings.ReplaceAll(job.Status, "_", " "), importWaitLimit, job.ID)
		case <-time.After(period):
		}
		period = min(period*3/2, importPollMost)
		if err := client.get(ctx, "imports/"+segment(job.ID), &job); err != nil {
			return err
		}
	}
	if job.Status != "succeeded" {
		return fmt.Errorf("%s: %s", job.ErrorCode, job.ErrorMessage)
	}

	if *publish && job.DocumentID == "" {
		input := map[string]any{}
		for _, name := range []string{"slug", "parentPath", "documentId"} {
			if value, given := target[name]; given {
				input[name] = value
			}
		}
		parent, _ := target["parentPath"].(string)
		if err := ensureParentPages(ctx, client, space, parent, map[string]bool{}); err != nil {
			return fmt.Errorf("converted, but could not publish: %w", err)
		}
		if err := client.call(ctx, http.MethodPost, "imports/"+segment(job.ID)+"/publish", input, &job, false); err != nil {
			return fmt.Errorf("converted, but could not publish: %w", err)
		}
	}
	if *asJSON {
		return printJSON(a.out, job)
	}
	for _, warning := range job.Report.Warnings {
		fmt.Fprintf(a.err, "warning: %s\n", warning)
	}
	if job.DocumentID != "" {
		fmt.Fprintf(a.out, "published %s (%s)\n", filepath.Base(file), job.DocumentID)
		return nil
	}
	fmt.Fprintf(a.out, "draft     %s (%s): review it on the space's import page, or run again with --publish\n", filepath.Base(file), job.ID)
	return nil
}
