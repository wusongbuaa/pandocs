package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Signing in through the browser is the authorization code flow with PKCE, coming back to a port on loopback, which is
// what RFC 8252 asks of an app on someone's own computer. The server knows the command line as a client of its own, and
// gives it a token that acts as the person, where an MCP client it has never seen before only ever gets an agent's.

// How long to wait for someone to say yes in the browser.
var browserWait = 10 * time.Minute

type authServer struct {
	Issuer        string `json:"issuer"`
	AuthorizeURL  string `json:"authorization_endpoint"`
	TokenURL      string `json:"token_endpoint"`
	RevocationURL string `json:"revocation_endpoint"`
	ClientID      string `json:"pandocs_cli_client_id"`
}

type tokenAnswer struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
}

var errNoBrowserLogin = errors.New("this server cannot sign the command line in through a browser yet: create a token on your account page, and run `pandocs login --token`")

// discover asks the server where to send the person, and whether it knows the command line at all.
func (c *Client) discover(ctx context.Context) (*authServer, error) {
	response, err := c.open(ctx, http.MethodGet, "/.well-known/oauth-authorization-server", requestOptions{})
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
			return nil, errNoBrowserLogin
		}
		return nil, err
	}
	defer response.Body.Close()
	var found authServer
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&found); err != nil {
		return nil, fmt.Errorf("the server sent something unreadable: %w", err)
	}
	if found.ClientID == "" || found.AuthorizeURL == "" || found.TokenURL == "" {
		return nil, errNoBrowserLogin
	}
	return &found, nil
}

func randomString() string {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw[:])
}

type callbackResult struct {
	code string
	err  error
}

// browserLogin has the person say yes in their browser, and comes back with a token and the session that renews it.
// show is called with the address once something is listening for the answer, to open it or print it.
func (a *app) browserLogin(ctx context.Context, server string, show func(address string)) (string, *Session, error) {
	client := newClient(server, "")
	found, err := client.discover(ctx)
	if err != nil {
		return "", nil, err
	}
	// 127.0.0.1 rather than localhost, which can be something else, and a port the system picks (RFC 8252, 7.3).
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, fmt.Errorf("could not wait for the browser: %w", err)
	}
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", listener.Addr().(*net.TCPAddr).Port)
	verifier := randomString()
	challenge := sha256.Sum256([]byte(verifier))
	state := randomString()
	address := found.AuthorizeURL + "?" + url.Values{
		"response_type":         {"code"},
		"client_id":             {found.ClientID},
		"redirect_uri":          {redirect},
		"scope":                 {"read write"},
		"state":                 {state},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"},
	}.Encode()

	results := make(chan callbackResult, 1)
	callback := &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		query := r.URL.Query()
		// Anything not carrying this login's state was not sent by the server for it, so it is not an answer.
		if query.Get("state") != state {
			http.Error(w, "This is not the sign-in pandocs is waiting for.", http.StatusBadRequest)
			return
		}
		result := callbackResult{code: query.Get("code")}
		switch {
		case query.Get("error") == "access_denied":
			result.err = errors.New("you did not authorize it in the browser")
		case query.Get("error") != "":
			result.err = fmt.Errorf("the server said no: %s", strings.TrimSpace(query.Get("error")+" "+query.Get("error_description")))
		case query.Get("iss") != "" && found.Issuer != "" && query.Get("iss") != found.Issuer:
			// Another server's answer, sent here to have this one take it (RFC 9207).
			result.err = errors.New("the answer came from a different server than the one asked")
		case result.code == "":
			result.err = errors.New("the browser came back without an answer")
		}
		finishedPage(w, result.err)
		select {
		case results <- result:
		default:
		}
	})}
	go func() { _ = callback.Serve(listener) }()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = callback.Shutdown(shutdown)
	}()

	show(address)
	waiting, cancel := context.WithTimeout(ctx, browserWait)
	defer cancel()
	var result callbackResult
	select {
	case result = <-results:
	case <-waiting.Done():
		if ctx.Err() != nil {
			return "", nil, ctx.Err()
		}
		return "", nil, errors.New("gave up waiting for the browser")
	}
	if result.err != nil {
		return "", nil, result.err
	}
	answer, err := client.tokenRequest(ctx, found.TokenURL, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {result.code},
		"client_id":     {found.ClientID},
		"redirect_uri":  {redirect},
		"code_verifier": {verifier},
	})
	if err != nil {
		return "", nil, err
	}
	return answer.AccessToken, &Session{
		ClientID:        found.ClientID,
		TokenURL:        found.TokenURL,
		RevocationURL:   found.RevocationURL,
		RefreshToken:    answer.RefreshToken,
		AccessExpiresAt: expiresAt(answer),
	}, nil
}

func expiresAt(answer *tokenAnswer) time.Time {
	return time.Now().Add(time.Duration(answer.ExpiresIn) * time.Second).UTC().Truncate(time.Second)
}

// finishedPage is what the browser shows once it is back here. An error can carry the server's words, so it is escaped.
func finishedPage(w http.ResponseWriter, failed error) {
	title, text := "Signed in", "You can close this tab and go back to the terminal."
	if failed != nil {
		title, text = "Not signed in", failed.Error()
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Pandocs</title><body style="font:16px system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem"><h1 style="font-size:1.4rem">%s</h1><p>%s</p></body>`, html.EscapeString(title), html.EscapeString(text))
}

func (c *Client) tokenRequest(ctx context.Context, endpoint string, form url.Values) (*tokenAnswer, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var answer tokenAnswer
	_ = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&answer)
	if response.StatusCode == http.StatusBadRequest && answer.Error == "invalid_grant" {
		return nil, errSignedOut
	}
	if response.StatusCode != http.StatusOK || answer.AccessToken == "" {
		return nil, fmt.Errorf("the server would not give a token (%d %s)", response.StatusCode, answer.Error)
	}
	return &answer, nil
}

var errSignedOut = errors.New("the login has ended, or was signed out from the account page: run `pandocs login` again")

// renewSession gets a new token for one the server no longer takes, which after an hour is every one. It reads the file
// again under the lock first: another pandocs may have renewed it a moment ago, and then the refresh token here is spent.
func renewSession(ctx context.Context, client *Client, held string) (string, error) {
	unlock, err := lockConfig()
	if err != nil {
		return "", err
	}
	defer unlock()
	saved, err := savedConfig()
	if err != nil {
		return "", err
	}
	if saved.Session == nil || strings.TrimRight(saved.Server, "/") != client.server {
		return "", errSignedOut
	}
	if saved.Token != held {
		return saved.Token, nil
	}
	answer, err := client.tokenRequest(ctx, saved.Session.TokenURL, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {saved.Session.RefreshToken},
		"client_id":     {saved.Session.ClientID},
	})
	if err != nil {
		return "", err
	}
	saved.Token = answer.AccessToken
	saved.Session.RefreshToken = answer.RefreshToken
	saved.Session.AccessExpiresAt = expiresAt(answer)
	if _, err := saveConfig(saved); err != nil {
		return "", err
	}
	return saved.Token, nil
}

// revokeSession gives the login back, so the server ends it too rather than leaving it to run out. It says nothing
// whether or not that worked: the copy here is gone either way.
func revokeSession(ctx context.Context, config Config) {
	if config.Session == nil || config.Session.RevocationURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	form := url.Values{"token": {config.Session.RefreshToken}, "token_type_hint": {"refresh_token"}, "client_id": {config.Session.ClientID}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.Session.RevocationURL, strings.NewReader(form.Encode()))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if response, err := newClient(config.Server, "").http.Do(request); err == nil {
		response.Body.Close()
	}
}

// canOpenBrowser says whether there is likely a browser here to open. Over SSH, or on Linux without a display, the
// page would open on a screen nobody is looking at, if anywhere.
func canOpenBrowser() bool {
	if os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != "" {
		return false
	}
	switch runtime.GOOS {
	case "darwin", "windows":
		return true
	default:
		return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
	}
}

// openBrowser is a variable so that tests can stand in for the person.
var openBrowser = func(address string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", address)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", address)
	default:
		command = exec.Command("xdg-open", address)
	}
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}
