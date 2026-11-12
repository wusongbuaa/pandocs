package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	settleDelay   = 300 * time.Millisecond
	maxBackoff    = 30 * time.Second
	dirPollPeriod = 2 * time.Second
)

var (
	// The server says something at least every 25 seconds. A connection quiet for longer has died somewhere on the way
	// without saying so, as one through a sleeping laptop's network does, and is given up for a new one.
	quietLimit = 90 * time.Second
	// After a round that failed, how long until the next try, which doubles up to the most.
	firstRetry = 10 * time.Second
	mostRetry  = 5 * time.Minute
)

// serverEvent is one frame of the server's live stream.
type serverEvent struct {
	id    string
	event string
	data  string
}

// readEvents reads Server-Sent Events until the stream ends. Comments and the keep-alive lines are not events. As the
// format says, the space after a field's colon is optional, an event with only data is a "message", and the lines of
// data in one event are one text, line by line.
func readEvents(stream io.Reader, onEvent func(serverEvent)) error {
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	var current serverEvent
	hasData := false
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if current.event != "" || hasData {
				if current.event == "" {
					current.event = "message"
				}
				onEvent(current)
			}
			current, hasData = serverEvent{}, false
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "id":
			current.id = value
		case "event":
			current.event = value
		case "data":
			if hasData {
				current.data += "\n" + value
			} else {
				current.data, hasData = value, true
			}
		}
	}
	return scanner.Err()
}

// heard tells whenever something arrives.
type heard struct {
	io.Reader
	onRead func()
}

func (h heard) Read(p []byte) (int, error) {
	n, err := h.Reader.Read(p)
	if n > 0 {
		h.onRead()
	}
	return n, err
}

// wakesFromServer signals `wake` when a space's files may have changed, and reconnects until told to stop. The server
// fills in what it missed from the last event seen. Refusals such as a revoked token stop it, as retrying cannot help.
func wakesFromServer(ctx context.Context, client *Client, space, position string, wake chan<- struct{}) error {
	lastID := position
	backoff := time.Second
	signal := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	for {
		headers := map[string]string{"Accept": "text/event-stream"}
		if lastID != "" {
			headers["Last-Event-ID"] = lastID
		}
		connection, hangUp := context.WithCancel(ctx)
		response, err := client.open(connection, http.MethodGet, apiBase+"events?space="+url.QueryEscape(space), requestOptions{headers: headers})
		if err != nil {
			hangUp()
			var apiErr *APIError
			if errors.As(err, &apiErr) && apiErr.Status < 500 && apiErr.Status != http.StatusTooManyRequests {
				return err
			}
		} else {
			backoff = time.Second
			// Whatever happened while disconnected is covered by comparing everything.
			signal()
			quiet := time.AfterFunc(quietLimit, hangUp)
			_ = readEvents(heard{response.Body, func() { quiet.Reset(quietLimit) }}, func(frame serverEvent) {
				if frame.id != "" {
					lastID = frame.id
				}
				switch frame.event {
				case "reset":
					signal()
				case "change":
					var change struct {
						Kind string `json:"kind"`
					}
					// Comments do not change any file.
					if json.Unmarshal([]byte(frame.data), &change) == nil && change.Kind != "discussion" {
						signal()
					}
				}
			})
			quiet.Stop()
			response.Body.Close()
			hangUp()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// wakesFromDir polls the one small file that changes with everything else. Watching for file events does not work
// across NFS clients: in testing, none ever arrived.
func wakesFromDir(ctx context.Context, src *dirSource, wake chan<- struct{}) error {
	last := src.current()
	ticker := time.NewTicker(dirPollPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if now := src.current(); now != last {
				last = now
				select {
				case wake <- struct{}{}:
				default:
				}
			}
		}
	}
}

// watchLoop runs a round whenever woken. A round that failed is tried again after a while, and after longer each time
// it fails again, without waiting for another change: the copy should not stay behind because the network once did.
func watchLoop(ctx context.Context, wake <-chan struct{}, failed <-chan error, round func() error, report func(error)) error {
	delay := firstRetry
	var retry <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-failed:
			if ctx.Err() != nil {
				return nil
			}
			return err
		case <-retry:
		case <-wake:
			// Many changes in a row are one round.
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(settleDelay):
			}
			select {
			case <-wake:
			default:
			}
		}
		if err := round(); err != nil {
			report(fmt.Errorf("sync failed, will try again in %s: %w", delay, err))
			retry = time.After(delay)
			delay = min(delay*2, mostRetry)
		} else {
			retry, delay = nil, firstRetry
		}
	}
}
