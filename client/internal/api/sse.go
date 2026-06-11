package api

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/events"
)

// StreamRunEvents opens the SSE stream for a run and calls onEvent for each decoded
// RunEvent, until the stream ends (the server closes it when the run finishes), ctx
// is cancelled, or an error occurs. lastEventID >= 0 resumes from that seq via the
// Last-Event-ID header; pass -1 for the full replay + live tail. Malformed events
// are skipped (the server validates on egress, so this is belt-and-suspenders).
func (c *Client) StreamRunEvents(ctx context.Context, id string, lastEventID int, onEvent func(events.RunEvent)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/v1/runs/"+url.PathEscape(id)+"/events", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if lastEventID >= 0 {
		req.Header.Set("Last-Event-ID", strconv.Itoa(lastEventID))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &APIError{Status: resp.StatusCode, Msg: "event stream failed"}
	}

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024) // tolerate large data lines
	var data strings.Builder
	dispatch := func() {
		if data.Len() == 0 {
			return
		}
		if ev, err := events.Decode([]byte(data.String())); err == nil {
			onEvent(ev)
		}
		data.Reset()
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "": // blank line = event boundary → dispatch
			dispatch()
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n') // SSE joins multiple data: lines with newline
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		default:
			// id: / event: / comment lines — the seq lives in the JSON envelope, ignore
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	// Flush a final event that arrived without a trailing blank line (SSE spec:
	// the last event need not be terminated, e.g. on an abrupt connection close).
	dispatch()
	return nil
}

// StreamRunEventsReconnect keeps the SSE stream alive across disconnects, resuming
// from the last seen seq (Last-Event-ID) with capped backoff. It returns nil once a
// terminal run.verdict event is seen (the run finished), or ctx's error on cancel.
func (c *Client) StreamRunEventsReconnect(ctx context.Context, id string, onEvent func(events.RunEvent)) error {
	const initialBackoff = 500 * time.Millisecond
	const maxBackoff = 10 * time.Second
	lastSeq := -1
	done := false
	backoff := initialBackoff

	for !done {
		prevSeq := lastSeq
		streamErr := c.StreamRunEvents(ctx, id, lastSeq, func(ev events.RunEvent) {
			if ev.Seq > lastSeq {
				lastSeq = ev.Seq
			}
			if ev.Type == "run.verdict" {
				done = true // the run finished — stop reconnecting (server closed the stream)
			}
			onEvent(ev)
		})
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if done {
			return nil
		}
		// Permanent server errors must not be retried forever (else a 401/404 is an
		// infinite busy-loop). Surface them; only transient failures reconnect.
		var apiErr *APIError
		if errors.As(streamErr, &apiErr) {
			switch apiErr.Status {
			case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
				return streamErr
			}
		}
		// A productive connection (the cursor advanced) resets the backoff, so a
		// long healthy stream that drops reconnects fast; only repeated unproductive
		// failures grow the delay.
		if lastSeq > prevSeq {
			backoff = initialBackoff
		} else {
			backoff = min(backoff*2, maxBackoff)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
	}
	return nil
}
