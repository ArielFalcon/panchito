package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ArielFalcon/panchito/internal/events"
)

func TestStreamRunEventsDecodesAndForwardsLastEventID(t *testing.T) {
	var gotLastEventID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotLastEventID = r.Header.Get("Last-Event-ID")
		w.Header().Set("Content-Type", "text/event-stream")
		fl, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("ResponseWriter is not a Flusher")
		}
		_, _ = w.Write([]byte("id: 0\nevent: step.changed\ndata: {\"seq\":0,\"runId\":\"r1\",\"ts\":1,\"body\":{\"type\":\"step.changed\",\"step\":\"generate\"}}\n\n"))
		fl.Flush()
		_, _ = w.Write([]byte("id: 1\nevent: run.verdict\ndata: {\"seq\":1,\"runId\":\"r1\",\"ts\":1,\"body\":{\"type\":\"run.verdict\",\"verdict\":\"pass\",\"passed\":1,\"failed\":0}}\n\n"))
		fl.Flush()
	}))
	defer srv.Close()

	c := New(srv.URL, "tok")
	var got []events.RunEvent
	if err := c.StreamRunEvents(context.Background(), "r1", 5, func(ev events.RunEvent) { got = append(got, ev) }); err != nil {
		t.Fatalf("StreamRunEvents: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 events, got %d", len(got))
	}
	if got[0].Type != "step.changed" || got[1].Type != "run.verdict" {
		t.Fatalf("event types: %q, %q", got[0].Type, got[1].Type)
	}
	if v, ok := got[1].Body.(events.RunVerdict); !ok || v.Verdict != "pass" {
		t.Fatalf("verdict body: %#v", got[1].Body)
	}
	if gotLastEventID != "5" {
		t.Fatalf("Last-Event-ID forwarded = %q, want 5", gotLastEventID)
	}
}

func TestStreamRunEventsFlushesFinalEventWithoutTrailingBlank(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		// A final event with no trailing blank line, then the connection closes.
		_, _ = w.Write([]byte("data: {\"seq\":0,\"runId\":\"r1\",\"ts\":1,\"body\":{\"type\":\"test.started\",\"name\":\"nav\"}}\n"))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	var got []events.RunEvent
	if err := c.StreamRunEvents(context.Background(), "r1", -1, func(ev events.RunEvent) { got = append(got, ev) }); err != nil {
		t.Fatalf("StreamRunEvents: %v", err)
	}
	if len(got) != 1 || got[0].Type != "test.started" {
		t.Fatalf("final event was not flushed: %+v", got)
	}
}

func TestStreamRunEventsJoinsMultiLineData(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		// One JSON payload split across two data: lines — SSE joins them with \n,
		// which is valid JSON whitespace between tokens.
		_, _ = w.Write([]byte("data: {\"seq\":0,\"runId\":\"r1\",\"ts\":1,\ndata: \"body\":{\"type\":\"test.started\",\"name\":\"nav\"}}\n\n"))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	var got []events.RunEvent
	if err := c.StreamRunEvents(context.Background(), "r1", -1, func(ev events.RunEvent) { got = append(got, ev) }); err != nil {
		t.Fatalf("StreamRunEvents: %v", err)
	}
	if len(got) != 1 || got[0].Type != "test.started" {
		t.Fatalf("multi-line data not joined: %+v", got)
	}
}

func TestStreamRunEventsReconnectStopsOnPermanentError(t *testing.T) {
	connects := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connects++
		w.WriteHeader(http.StatusUnauthorized) // a 401 must not be retried forever
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	err := c.StreamRunEventsReconnect(context.Background(), "r1", func(ev events.RunEvent) {})
	if err == nil {
		t.Fatal("want an error on 401, got nil")
	}
	if connects != 1 {
		t.Fatalf("reconnected %d times on a 401 (want 1)", connects)
	}
}

func TestStreamRunEventsReconnectStopsOnVerdict(t *testing.T) {
	connects := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connects++
		w.Header().Set("Content-Type", "text/event-stream")
		// Immediately deliver a terminal verdict, then close — the reconnect loop
		// must NOT reconnect (or this handler would be hit again).
		_, _ = w.Write([]byte("data: {\"seq\":0,\"runId\":\"r1\",\"ts\":1,\"body\":{\"type\":\"run.verdict\",\"verdict\":\"pass\",\"passed\":0,\"failed\":0}}\n\n"))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	var seen []string
	if err := c.StreamRunEventsReconnect(context.Background(), "r1", func(ev events.RunEvent) { seen = append(seen, ev.Type) }); err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	if connects != 1 {
		t.Fatalf("reconnected %d times after a terminal verdict (want 1)", connects)
	}
	if len(seen) != 1 || seen[0] != "run.verdict" {
		t.Fatalf("events: %v", seen)
	}
}
