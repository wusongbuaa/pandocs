package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const apiBase = "/api/v1/"

// Client talks to one Pandocs server. The token lives only in memory here and in the config file.
type Client struct {
	server string
	// lock guards token, which a login from the browser renews while requests may be going out.
	lock  sync.Mutex
	token string
	// renew gets a token to replace one the server turned down, when there is a way to. It is given the one turned down.
	renew   func(ctx context.Context, held string) (string, error)
	http    *http.Client
	channel string
	// retryDelay is the pause before the first retry, doubling after that. A replica restarting during an
	// upgrade should not fail anyone's sync.
	retryDelay time.Duration
}

func newClient(server, token string) *Client {
	// No overall timeout: an archive or a live stream can rightly go on for as long as it goes on. These only stop a
	// server that never answers from hanging a command, since by default that takes minutes per attempt.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ResponseHeaderTimeout = 60 * time.Second
	return &Client{
		server:     strings.TrimRight(server, "/"),
		token:      token,
		http:       &http.Client{Transport: transport},
		channel:    "cli",
		retryDelay: 300 * time.Millisecond,
	}
}

// APIError is an answer from the server saying no.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details json.RawMessage
}

func (e *APIError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("the server answered %d", e.Status)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func isAPIError(err error, code string) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Code == code
}

func segment(value string) string { return url.PathEscape(value) }

func newKey() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw[:])
}

func apiErrorFrom(response *http.Response) error {
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	var payload struct {
		Error struct {
			Code    string          `json:"code"`
			Message string          `json:"message"`
			Details json.RawMessage `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &payload)
	return &APIError{Status: response.StatusCode, Code: payload.Error.Code, Message: payload.Error.Message, Details: payload.Error.Details}
}

type requestOptions struct {
	body        []byte
	contentType string
	idempotent  bool
	headers     map[string]string
}

// open sends a request and hands back the response for the caller to read and close. Only requests that can
// safely happen twice are retried: reads, and writes carrying a key the server uses to answer a replay.
func (c *Client) open(ctx context.Context, method, target string, options requestOptions) (*http.Response, error) {
	address := c.server + target
	key := ""
	if options.idempotent {
		key = newKey()
	}
	retryable := method == http.MethodGet || options.idempotent
	delay := c.retryDelay
	renewed := false
	var last error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
			delay *= 2
		}
		request, err := http.NewRequestWithContext(ctx, method, address, bytes.NewReader(options.body))
		if err != nil {
			return nil, err
		}
		token := c.currentToken()
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		request.Header.Set("X-Pandocs-Channel", c.channel)
		if options.contentType != "" {
			request.Header.Set("Content-Type", options.contentType)
		}
		if key != "" {
			request.Header.Set("Idempotency-Key", key)
		}
		for name, value := range options.headers {
			request.Header.Set(name, value)
		}
		response, err := c.http.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			last = err
			if retryable {
				continue
			}
			return nil, err
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return response, nil
		}
		// A token from the browser lasts an hour. Turned down, nothing was done, so even a write can go again.
		if response.StatusCode == http.StatusUnauthorized && c.renew != nil && !renewed {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if err := c.renewToken(ctx, token); err != nil {
				return nil, err
			}
			renewed = true
			attempt--
			continue
		}
		if retryable && (response.StatusCode == 429 || response.StatusCode == 502 || response.StatusCode == 503 || response.StatusCode == 504) {
			wait, said := retryAfter(response.Header.Get("Retry-After"), time.Now())
			last = apiErrorFrom(response)
			// Asked to wait longer than anyone would at a prompt, it is better to say so now.
			if said && wait > mostRetryAfter {
				return nil, last
			}
			if said {
				delay = max(delay, wait)
			}
			continue
		}
		return nil, apiErrorFrom(response)
	}
	return nil, last
}

func (c *Client) currentToken() string {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.token
}

// renewToken replaces the token that was turned down, unless another request here already has.
func (c *Client) renewToken(ctx context.Context, held string) error {
	c.lock.Lock()
	defer c.lock.Unlock()
	if c.token != held {
		return nil
	}
	token, err := c.renew(ctx, held)
	if err != nil {
		return err
	}
	c.token = token
	return nil
}

// mostRetryAfter is the longest a request waits when the server asks it to come back later.
const mostRetryAfter = 30 * time.Second

// retryAfter reads a Retry-After header, which is either seconds or a date.
func retryAfter(value string, now time.Time) (time.Duration, bool) {
	if value == "" {
		return 0, false
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second, true
	}
	if at, err := http.ParseTime(value); err == nil {
		return max(at.Sub(now), 0), true
	}
	return 0, false
}

// call sends JSON and decodes the `data` of the answer.
func (c *Client) call(ctx context.Context, method, path string, input, output any, idempotent bool) error {
	options := requestOptions{idempotent: idempotent}
	if input != nil {
		body, err := json.Marshal(input)
		if err != nil {
			return err
		}
		options.body = body
		options.contentType = "application/json"
	}
	response, err := c.open(ctx, method, apiBase+path, options)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if output == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	var payload struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return fmt.Errorf("the server sent something unreadable: %w", err)
	}
	return json.Unmarshal(payload.Data, output)
}

func (c *Client) get(ctx context.Context, path string, output any) error {
	return c.call(ctx, http.MethodGet, path, nil, output, false)
}

// Me is who the token belongs to. An agent reads, discusses and proposes, and a person decides.
type Me struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"displayName"`
	Kind        string   `json:"kind"`
	IsAdmin     bool     `json:"isAdmin"`
	Scopes      []string `json:"scopes"`
}

func (c *Client) me(ctx context.Context) (*Me, error) {
	var me Me
	if err := c.get(ctx, "me", &me); err != nil {
		return nil, err
	}
	return &me, nil
}
