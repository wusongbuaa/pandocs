// Command pandocs reads and changes a Pandocs site from a terminal, and keeps a space as files on a local disk.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"

	"golang.org/x/term"
)

// Set when a release is built.
var version = "dev"

const usage = `pandocs reads and changes a Pandocs site, and keeps a space as files on this disk.

Getting connected
  login [--server URL] [--token-stdin]   Remember a server and an API token (create one on your account page)
  logout                                 Forget them
  whoami                                 Who the token belongs to

Reading
  spaces                                 List spaces
  get <space/path | id> [--revision N]   Print a page's Markdown
  search <words> [--space S]             Search pages
  tools                                  List what the server can do
  call <tool> [json | -] [--arg k=v]     Do one of those things

Working on files
  sync <space> [dir] [--watch] [--from shared-dir]
                                         Bring a copy up to date. Edits here are never overwritten
  status [--remote]                      What changed here, and optionally on the server
  commit [paths] [-m text] [--propose] [--delete] [--strict] [--resolved] [--change-set title | --to-change-set id]
                                         Send edits back. People's become revisions, agents' become proposals
  upload <space> <file>                  Upload an image or file, and print the path to use in a page
  import <space> <file> [--as path] [--to page] [--publish]
                                         Make a page from a Word, Excel, PowerPoint, PDF, HTML or CSV file

For agents
  mcp                                    Bridge MCP over stdio to the server

Other
  version                                Print the version

Add --json to the reading commands for machine-readable output.
PANDOCS_URL and PANDOCS_TOKEN override what login remembered.
`

// exitCodes: 1 is an error, 2 is a mistake in the command, and 3 means some files need a person to look at them.
type exitError struct {
	code    int
	message string
}

func (e *exitError) Error() string { return e.message }

func usageError(format string, args ...any) error {
	return &exitError{code: 2, message: fmt.Sprintf(format, args...)}
}

type app struct {
	in  io.Reader
	out io.Writer
	err io.Writer
}

func newFlagSet() *flag.FlagSet { return flag.NewFlagSet("pandocs", flag.ContinueOnError) }

// parse handles flags before, between and after positional arguments, since people write them in any order.
func parse(set *flag.FlagSet, args []string) ([]string, error) {
	set.SetOutput(io.Discard)
	var positional []string
	for {
		if err := set.Parse(args); err != nil {
			return nil, usageError("%v", err)
		}
		args = set.Args()
		if len(args) == 0 {
			return positional, nil
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
}

func (a *app) connect() (*Client, error) {
	config, err := loadConfig()
	if err != nil {
		return nil, err
	}
	if config.Server == "" || config.Token == "" {
		return nil, errors.New("not logged in: run `pandocs login --server https://your.site`, or set PANDOCS_URL and PANDOCS_TOKEN")
	}
	if err := validServer(config.Server); err != nil {
		return nil, err
	}
	return newClient(config.Server, config.Token), nil
}

func run(ctx context.Context, a *app, args []string) error {
	if len(args) == 0 {
		fmt.Fprint(a.out, usage)
		return nil
	}
	command, rest := args[0], args[1:]
	switch command {
	case "help", "--help", "-h":
		fmt.Fprint(a.out, usage)
		return nil
	case "version", "--version":
		fmt.Fprintf(a.out, "pandocs %s %s/%s\n", version, runtime.GOOS, runtime.GOARCH)
		return nil
	case "login":
		return a.login(ctx, rest)
	case "logout":
		if err := removeConfig(); err != nil {
			return err
		}
		fmt.Fprintln(a.out, "Logged out.")
		return nil
	case "whoami":
		return a.whoami(ctx, rest)
	case "spaces":
		return a.spaces(ctx, rest)
	case "get":
		return a.getPage(ctx, rest)
	case "search":
		return a.search(ctx, rest)
	case "tools":
		return a.tools(ctx, rest)
	case "call":
		return a.callTool(ctx, rest)
	case "sync":
		return a.sync(ctx, rest)
	case "status":
		return a.status(ctx, rest)
	case "commit":
		return a.commit(ctx, rest)
	case "upload":
		return a.upload(ctx, rest)
	case "import":
		return a.importFile(ctx, rest)
	case "mcp":
		client, err := a.connect()
		if err != nil {
			return err
		}
		client.channel = "mcp"
		return bridgeMCP(ctx, client, a.in, a.out)
	}
	return usageError("unknown command %q: run `pandocs help`", command)
}

func (a *app) login(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("login", flag.ContinueOnError)
	server := set.String("server", "", "")
	fromStdin := set.Bool("token-stdin", false, "")
	if _, err := parse(set, args); err != nil {
		return err
	}
	config, err := loadConfig()
	if err != nil {
		return err
	}
	if *server != "" {
		config.Server = *server
	}
	if config.Server == "" {
		return usageError("which server? run `pandocs login --server https://your.site`")
	}
	if err := validServer(config.Server); err != nil {
		return usageError("%v", err)
	}
	if plainTextOverNetwork(config.Server) {
		fmt.Fprintln(a.err, "warning: this address is not https, so your token would cross the network unencrypted")
	}
	token, err := a.readToken(*fromStdin)
	if err != nil {
		return err
	}
	if token == "" {
		return usageError("no token given")
	}
	client := newClient(config.Server, token)
	me, err := client.me(ctx)
	if err != nil {
		return fmt.Errorf("could not log in to %s: %w", config.Server, err)
	}
	path, err := saveConfig(Config{Server: config.Server, Token: token})
	if err != nil {
		return err
	}
	fmt.Fprintf(a.out, "Logged in to %s as %s. Saved in %s\n", config.Server, me.DisplayName, path)
	return nil
}

// readToken never takes the token as an argument, where it would end up in shell history and process lists.
func (a *app) readToken(fromStdin bool) (string, error) {
	if file, ok := a.in.(*os.File); ok && !fromStdin && term.IsTerminal(int(file.Fd())) {
		fmt.Fprint(a.err, "API token (create one on your account page): ")
		raw, err := term.ReadPassword(int(file.Fd()))
		fmt.Fprintln(a.err)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(raw)), nil
	}
	raw, err := io.ReadAll(io.LimitReader(a.in, 4096))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

func (a *app) whoami(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("whoami", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	if _, err := parse(set, args); err != nil {
		return err
	}
	client, err := a.connect()
	if err != nil {
		return err
	}
	me, err := client.me(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(a.out, me)
	}
	fmt.Fprintf(a.out, "%s (%s, %s) on %s\n", me.DisplayName, me.Kind, strings.Join(me.Scopes, "+"), client.server)
	return nil
}

func (a *app) spaces(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("spaces", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	if _, err := parse(set, args); err != nil {
		return err
	}
	client, err := a.connect()
	if err != nil {
		return err
	}
	var spaces []struct {
		Slug string `json:"slug"`
		Name string `json:"name"`
	}
	if *asJSON {
		var raw json.RawMessage
		if err := client.get(ctx, "spaces", &raw); err != nil {
			return err
		}
		return printJSON(a.out, raw)
	}
	if err := client.get(ctx, "spaces", &spaces); err != nil {
		return err
	}
	for _, space := range spaces {
		fmt.Fprintf(a.out, "%s\t%s\n", space.Slug, space.Name)
	}
	return nil
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

// resolvePage takes an id or `space/path`.
func resolvePage(ctx context.Context, client *Client, reference string) (string, error) {
	if uuidPattern.MatchString(reference) {
		return reference, nil
	}
	space, path, found := strings.Cut(strings.TrimSuffix(reference, ".md"), "/")
	if !found || path == "" {
		return "", usageError("%q should be a page id or space/path", reference)
	}
	var page struct {
		ID string `json:"id"`
	}
	if err := client.get(ctx, "spaces/"+segment(space)+"/resolve?path="+url.QueryEscape(path), &page); err != nil {
		return "", err
	}
	return page.ID, nil
}

func (a *app) getPage(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("get", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	revision := set.Int("revision", 0, "")
	positional, err := parse(set, args)
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return usageError("usage: pandocs get <space/path | id> [--revision N] [--json]")
	}
	client, err := a.connect()
	if err != nil {
		return err
	}
	id, err := resolvePage(ctx, client, positional[0])
	if err != nil {
		return err
	}
	query := ""
	if *revision > 0 {
		query = fmt.Sprintf("?revision=%d", *revision)
	}
	if *asJSON {
		var raw json.RawMessage
		if err := client.get(ctx, "documents/"+segment(id)+query, &raw); err != nil {
			return err
		}
		return printJSON(a.out, raw)
	}
	response, err := client.open(ctx, http.MethodGet, apiBase+"documents/"+segment(id)+"/content"+query, requestOptions{})
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, err = io.Copy(a.out, response.Body)
	return err
}

func (a *app) search(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("search", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	space := set.String("space", "", "")
	positional, err := parse(set, args)
	if err != nil {
		return err
	}
	if len(positional) == 0 {
		return usageError("usage: pandocs search <words> [--space S] [--json]")
	}
	client, err := a.connect()
	if err != nil {
		return err
	}
	query := url.Values{"q": {strings.Join(positional, " ")}}
	if *space != "" {
		query.Set("space", *space)
	}
	var raw json.RawMessage
	if err := client.get(ctx, "search?"+query.Encode(), &raw); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(a.out, raw)
	}
	var hits []struct {
		SpaceSlug string `json:"spaceSlug"`
		Path      string `json:"path"`
		Title     string `json:"title"`
		Snippet   string `json:"snippet"`
	}
	if err := json.Unmarshal(raw, &hits); err != nil {
		return err
	}
	for _, hit := range hits {
		fmt.Fprintf(a.out, "%s/%s\t%s\n", hit.SpaceSlug, hit.Path, hit.Title)
		if hit.Snippet != "" {
			fmt.Fprintf(a.out, "  %s\n", strings.Join(strings.Fields(hit.Snippet), " "))
		}
	}
	return nil
}

func (a *app) tools(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("tools", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	if _, err := parse(set, args); err != nil {
		return err
	}
	client, err := a.connect()
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if err := client.get(ctx, "tools", &raw); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(a.out, raw)
	}
	var tools []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(raw, &tools); err != nil {
		return err
	}
	for _, tool := range tools {
		fmt.Fprintf(a.out, "%-24s %s\n", tool.Name, tool.Description)
	}
	return nil
}

type repeated []string

func (r *repeated) String() string     { return strings.Join(*r, ",") }
func (r *repeated) Set(v string) error { *r = append(*r, v); return nil }

// toolArguments merges a JSON object, from an argument or stdin, with --arg name=value. A value that is valid JSON
// counts as JSON, so numbers and lists work, and anything else is a string.
func toolArguments(a *app, positional []string, pairs []string) (map[string]any, error) {
	arguments := map[string]any{}
	if len(positional) > 0 {
		raw := []byte(positional[0])
		if positional[0] == "-" {
			var err error
			if raw, err = io.ReadAll(a.in); err != nil {
				return nil, err
			}
		}
		if err := json.Unmarshal(raw, &arguments); err != nil {
			return nil, usageError("the arguments should be a JSON object: %v", err)
		}
	}
	for _, pair := range pairs {
		name, value, found := strings.Cut(pair, "=")
		if !found || name == "" {
			return nil, usageError("--arg should be name=value, not %q", pair)
		}
		var parsed any
		if json.Unmarshal([]byte(value), &parsed) == nil {
			arguments[name] = parsed
		} else {
			arguments[name] = value
		}
	}
	return arguments, nil
}

func (a *app) callTool(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("call", flag.ContinueOnError)
	var pairs repeated
	set.Var(&pairs, "arg", "")
	positional, err := parse(set, args)
	if err != nil {
		return err
	}
	if len(positional) == 0 || len(positional) > 2 {
		return usageError("usage: pandocs call <tool> [json | -] [--arg name=value]")
	}
	arguments, err := toolArguments(a, positional[1:], pairs)
	if err != nil {
		return err
	}
	client, err := a.connect()
	if err != nil {
		return err
	}
	var result json.RawMessage
	if err := client.call(ctx, http.MethodPost, "tools/"+segment(positional[0]), arguments, &result, false); err != nil {
		return err
	}
	return printJSON(a.out, result)
}

func (a *app) upload(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("upload", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	positional, err := parse(set, args)
	if err != nil {
		return err
	}
	if len(positional) != 2 {
		return usageError("usage: pandocs upload <space> <file>")
	}
	content, err := os.ReadFile(positional[1])
	if err != nil {
		return err
	}
	client, err := a.connect()
	if err != nil {
		return err
	}
	target := apiBase + "spaces/" + segment(positional[0]) + "/assets?filename=" + url.QueryEscape(filepath.Base(positional[1]))
	response, err := client.open(ctx, http.MethodPost, target, requestOptions{body: content, contentType: "application/octet-stream"})
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var payload struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return err
	}
	if *asJSON {
		return printJSON(a.out, payload.Data)
	}
	var asset struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(payload.Data, &asset); err != nil {
		return err
	}
	fmt.Fprintln(a.out, asset.Path)
	return nil
}

func (a *app) printSync(report *SyncReport) {
	for _, path := range report.Written {
		fmt.Fprintf(a.out, "updated   %s\n", path)
	}
	for _, path := range report.Removed {
		fmt.Fprintf(a.out, "removed   %s\n", path)
	}
	for _, path := range report.Moved {
		fmt.Fprintf(a.out, "moved     %s\n", path)
	}
	for _, path := range report.Kept {
		fmt.Fprintf(a.out, "kept      %s (changed here)\n", path)
	}
	for _, path := range report.Conflicts {
		fmt.Fprintf(a.out, "both      %s (changed here and on the server: `pandocs commit` merges them)\n", path)
	}
	for _, path := range report.Skipped {
		fmt.Fprintf(a.err, "skipped   %s (not a safe path)\n", path)
	}
}

func (a *app) sync(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("sync", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	watch := set.Bool("watch", false, "")
	from := set.String("from", "", "")
	positional, err := parse(set, args)
	if err != nil {
		return err
	}
	if len(positional) > 2 {
		return usageError("usage: pandocs sync <space> [dir] [--watch] [--from shared-dir]")
	}

	space, root := "", ""
	if len(positional) > 0 {
		space = positional[0]
		root = space
	}
	if len(positional) == 2 {
		root = positional[1]
	}
	var state *State
	if space == "" {
		found, err := findRoot(".")
		if err != nil {
			return usageError("usage: pandocs sync <space> [dir]: %v", err)
		}
		root = found
	}
	if root, err = filepath.Abs(root); err != nil {
		return err
	}
	state, err = loadState(root)
	switch {
	case err == nil:
		if space != "" && state.Space != space {
			return usageError("%s already holds space %q", root, state.Space)
		}
		space = state.Space
	case errors.Is(err, os.ErrNotExist):
		state = &State{Version: stateVersion, Space: space, Files: map[string]FileState{}}
	default:
		return err
	}

	// A shared directory on its own is enough to read. With a server as well, the directory is just the quick way to most of it.
	var shared *dirSource
	if *from != "" {
		shared = &dirSource{dir: *from}
	}
	client, connectErr := a.connect()
	var src source
	switch {
	case connectErr == nil:
		src = &httpSource{client: client, space: space}
		state.Server = client.server
	case shared != nil:
		src = shared
	default:
		return connectErr
	}

	round := func(ctx context.Context) (*SyncReport, error) {
		unlock, err := lockCopy(root)
		if err != nil {
			return nil, err
		}
		defer unlock()
		// A commit in another terminal may have recorded something since the last round, which this one has to keep.
		if current, err := loadState(root); err == nil {
			current.Server = state.Server
			*state = *current
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		var quickStart source
		if shared != nil {
			quickStart = shared
		}
		report, err := reconcile(ctx, src, root, state, quickStart)
		if report != nil {
			if saveErr := saveState(root, state); saveErr != nil && err == nil {
				err = saveErr
			}
		}
		return report, err
	}

	report, err := round(ctx)
	if err != nil && report == nil {
		return err
	}
	if !*watch {
		if err != nil {
			if report != nil {
				a.printSync(report)
			}
			return err
		}
		if *asJSON {
			return printJSON(a.out, report)
		}
		a.printSync(report)
		fmt.Fprintf(a.out, "%s is up to date in %s\n", space, root)
		return nil
	}
	if err != nil {
		fmt.Fprintf(a.err, "sync failed, will try again: %v\n", err)
	} else {
		a.printSync(report)
	}
	fmt.Fprintf(a.out, "Watching %s in %s\n", space, root)

	wake := make(chan struct{}, 1)
	failed := make(chan error, 1)
	go func() {
		if connectErr == nil {
			failed <- wakesFromServer(ctx, client, space, state.Cursor, wake)
		} else {
			failed <- wakesFromDir(ctx, shared, wake)
		}
	}()
	return watchLoop(ctx, wake, failed, func() error {
		report, err := round(ctx)
		if report != nil {
			a.printSync(report)
		}
		return err
	}, func(err error) { fmt.Fprintln(a.err, err) })
}

func (a *app) status(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("status", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	remote := set.Bool("remote", false, "")
	if _, err := parse(set, args); err != nil {
		return err
	}
	root, err := findRoot(".")
	if err != nil {
		return err
	}
	state, err := loadState(root)
	if err != nil {
		return err
	}
	changes, err := localChanges(root, state)
	if err != nil {
		return err
	}
	if *remote {
		client, err := a.connect()
		if err != nil {
			return err
		}
		manifest, err := (&httpSource{client: client, space: state.Space}).manifest(ctx)
		if err != nil {
			return err
		}
		changes = withRemote(changes, manifest, state)
	}
	if *asJSON {
		return printJSON(a.out, append([]Change{}, changes...))
	}
	for _, change := range changes {
		fmt.Fprintf(a.out, "%-9s %s\n", change.Status, change.Path)
	}
	if len(changes) == 0 {
		fmt.Fprintln(a.out, "Nothing changed.")
	}
	return nil
}

// withRemote adds what the server has that this copy does not yet.
func withRemote(changes []Change, manifest *Manifest, state *State) []Change {
	local := map[string]int{}
	for at, change := range changes {
		local[change.Path] = at
	}
	wanted := map[string]bool{}
	for _, file := range manifest.Files {
		wanted[file.Path] = true
		if file.Kind != "document" {
			continue
		}
		base, known := state.Files[file.Path]
		if known && base.SHA256 == file.SHA256 {
			continue
		}
		if at, here := local[file.Path]; here {
			changes[at].Status = "both"
		} else {
			changes = append(changes, Change{file.Path, "behind"})
		}
	}
	for path, base := range state.Files {
		if base.Kind == "document" && !wanted[path] {
			if _, here := local[path]; !here {
				changes = append(changes, Change{path, "gone"})
			}
		}
	}
	return changes
}

func (a *app) commit(ctx context.Context, args []string) error {
	set := flag.NewFlagSet("commit", flag.ContinueOnError)
	asJSON := set.Bool("json", false, "")
	options := commitOptions{}
	set.StringVar(&options.message, "m", "", "")
	set.BoolVar(&options.propose, "propose", false, "")
	set.BoolVar(&options.allowDelete, "delete", false, "")
	set.BoolVar(&options.strict, "strict", false, "")
	set.BoolVar(&options.resolved, "resolved", false, "")
	set.StringVar(&options.changeSetTitle, "change-set", "", "")
	set.StringVar(&options.changeSetID, "to-change-set", "", "")
	positional, err := parse(set, args)
	if err != nil {
		return err
	}
	if options.changeSetTitle != "" && options.changeSetID != "" {
		return usageError("--change-set makes a new change set and --to-change-set adds to one, so give one of them")
	}
	root, err := findRoot(".")
	if err != nil {
		return err
	}
	unlock, err := lockCopy(root)
	if err != nil {
		return err
	}
	defer unlock()
	state, err := loadState(root)
	if err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	for _, path := range positional {
		absolute, err := filepath.Abs(filepath.Join(cwd, path))
		if filepath.IsAbs(path) {
			absolute, err = filepath.Clean(path), nil
		}
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, absolute)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return usageError("%s is not in this copy", path)
		}
		options.only = append(options.only, filepath.ToSlash(relative))
	}
	client, err := a.connect()
	if err != nil {
		return err
	}
	// What was already saved is said even when a later file fails, since it has happened on the server either way.
	results, err := commitChanges(ctx, client, root, state, options)
	if err != nil && len(results) == 0 {
		return err
	}
	if *asJSON {
		if err := printJSON(a.out, results); err != nil {
			return err
		}
	} else {
		for _, result := range results {
			line := fmt.Sprintf("%-9s %s", result.Action, result.Path)
			if result.Revision > 0 {
				line += fmt.Sprintf(" (revision %d)", result.Revision)
			}
			if result.ID != "" {
				line += " " + result.ID
			}
			if result.Message != "" {
				line += ": " + result.Message
			}
			fmt.Fprintln(a.out, line)
		}
		if len(results) == 0 {
			fmt.Fprintln(a.out, "Nothing to commit.")
		}
	}
	if err != nil {
		return err
	}
	conflict, failed := false, false
	for _, result := range results {
		conflict = conflict || result.Action == "conflict"
		failed = failed || result.Action == "failed"
	}
	switch {
	case failed:
		return &exitError{code: 1, message: "some files could not be committed"}
	case conflict:
		return &exitError{code: 3, message: "some files changed in the same place on both sides"}
	}
	return nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := run(ctx, &app{in: os.Stdin, out: os.Stdout, err: os.Stderr}, os.Args[1:])
	if err == nil {
		return
	}
	fmt.Fprintf(os.Stderr, "pandocs: %v\n", err)
	var exit *exitError
	if errors.As(err, &exit) {
		os.Exit(exit.code)
	}
	os.Exit(1)
}
