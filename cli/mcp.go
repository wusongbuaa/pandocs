package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

// bridgeMCP gives agents that only speak MCP over stdio the server's remote MCP endpoint. Each line in is one message,
// each answer one line out. Messages run side by side, as clients expect a slow tool call not to hold up the others.
func bridgeMCP(ctx context.Context, client *Client, input io.Reader, output io.Writer) error {
	var writeLock sync.Mutex
	writeLine := func(line []byte) {
		writeLock.Lock()
		defer writeLock.Unlock()
		_, _ = output.Write(append(bytes.TrimRight(line, "\r\n"), '\n'))
	}
	var sessionLock sync.Mutex
	headers := map[string]string{"Accept": "application/json, text/event-stream"}
	headersNow := func() map[string]string {
		sessionLock.Lock()
		defer sessionLock.Unlock()
		copied := make(map[string]string, len(headers))
		for name, value := range headers {
			copied[name] = value
		}
		return copied
	}
	remember := func(name, value string) {
		sessionLock.Lock()
		defer sessionLock.Unlock()
		headers[name] = value
	}

	send := func(message []byte) {
		var parsed struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal(message, &parsed)
		fail := func(err error) {
			// Notifications have no one to answer to.
			if len(parsed.ID) == 0 {
				return
			}
			reply, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": parsed.ID, "error": map[string]any{"code": -32603, "message": err.Error()}})
			writeLine(reply)
		}
		response, err := client.open(ctx, http.MethodPost, "/mcp", requestOptions{body: message, contentType: "application/json", headers: headersNow()})
		if err != nil {
			fail(err)
			return
		}
		defer response.Body.Close()
		if id := response.Header.Get("Mcp-Session-Id"); id != "" {
			remember("Mcp-Session-Id", id)
		}
		if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			if err := readEvents(response.Body, func(frame serverEvent) {
				if frame.data != "" {
					writeLine([]byte(frame.data))
				}
			}); err != nil {
				fail(err)
			}
			return
		}
		body, err := io.ReadAll(response.Body)
		if err != nil {
			fail(err)
			return
		}
		if len(bytes.TrimSpace(body)) == 0 {
			return
		}
		if parsed.Method == "initialize" {
			var answer struct {
				Result struct {
					ProtocolVersion string `json:"protocolVersion"`
				} `json:"result"`
			}
			if json.Unmarshal(body, &answer) == nil && answer.Result.ProtocolVersion != "" {
				remember("MCP-Protocol-Version", answer.Result.ProtocolVersion)
			}
		}
		writeLine(body)
	}

	reader := bufio.NewReaderSize(input, 1<<20)
	var running sync.WaitGroup
	defer running.Wait()
	for {
		line, err := reader.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			if !json.Valid(trimmed) {
				reply, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": -32700, "message": "not valid JSON"}})
				writeLine(reply)
			} else if isInitialize(trimmed) {
				// The answer has the version the rest should name, so nothing else starts until it is back.
				send(append([]byte(nil), trimmed...))
			} else {
				message := append([]byte(nil), trimmed...)
				running.Add(1)
				go func() {
					defer running.Done()
					send(message)
				}()
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("reading from the client: %w", err)
		}
	}
}

func isInitialize(message []byte) bool {
	var parsed struct {
		Method string `json:"method"`
	}
	return json.Unmarshal(message, &parsed) == nil && parsed.Method == "initialize"
}
