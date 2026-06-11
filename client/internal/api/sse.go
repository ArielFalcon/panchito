package api

import (
	"bufio"
	"context"
	"net/http"
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/v1/runs/"+id+"/events", nil)
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
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "": // blank line = event boundary → dispatch
			if data.Len() > 0 {
				if ev, err := events.Decode([]byte(data.String())); err == nil {
					onEvent(ev)
				}
				data.Reset()
			}
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n') // SSE joins multiple data: lines with newline
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		default:
			// id: / event: / comment lines — the seq lives in the JSON envelope, ignore
		}
	}
	return sc.Err()
}

// StreamRunEventsReconnect keeps the SSE stream alive across disconnects, resuming
// from the last seen seq (Last-Event-ID) with capped backoff. It returns nil once a
// terminal run.verdict event is seen (the run finished), or ctx's error on cancel.
func (c *Client) StreamRunEventsReconnect(ctx context.Context, id string, onEvent func(events.RunEvent)) error {
	lastSeq := -1
	done := false
	backoff := 500 * time.Millisecond
	const maxBackoff = 10 * time.Second

	for !done {
		_ = c.StreamRunEvents(ctx, id, lastSeq, func(ev events.RunEvent) {
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
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
	return nil
}
