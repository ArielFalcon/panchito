package ui

import (
	"testing"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
)

// The stop-ack handler must follow the same nil-client discipline as every other root poll
// caller: with no client there is nothing to poll, so it must not enqueue a guaranteed-fail
// poll that would falsely flip the status bar to "stale" right after a successful stop.
func TestRunCanceledWithNilClientDoesNotPoll(t *testing.T) {
	m := New()
	m.screen = screenDashboard
	m.dashboard = newDashboardModel(nil)
	m.dashboard.stopArmed = true

	updated, cmd := m.Update(runCanceledMsg{})
	m = updated.(Model)

	if cmd != nil {
		t.Fatalf("with no client, a stop ack must not enqueue a poll; got cmd=%v", cmd())
	}
	if m.dashboard.stopArmed {
		t.Fatal("a stop ack must still clear the armed confirmation, client or not")
	}
}

// The transient "stop requested" status must not stick: once the run actually ends (a poll
// shows no running run), it has to clear — even if the operator stopped from the live screen
// and only later returns to the dashboard.
func TestStatusClearsWhenRunEnds(t *testing.T) {
	m := New()
	m.client = api.New("http://x", "")
	m.screen = screenLive // stopped from the live screen; not on the dashboard
	m.dashboard = newDashboardModel(m.client)
	m.dashboard.status = "stop requested — the run is winding down"
	m.sys.queue.Running = &struct {
		App string `json:"app"`
		Id  string `json:"id"`
	}{App: "a", Id: "r1"}

	// A poll lands showing the run has ended (empty queue).
	updated, _ := m.Update(systemLoadedMsg{})
	m = updated.(Model)

	if m.dashboard.status != "" {
		t.Fatalf("a stale stop-status must clear once the run ends; got %q", m.dashboard.status)
	}
}

// Shift+Tab from a stale (non-actionable) focus should land on the LAST actionable panel, not
// always the first — the not-found fallback must respect direction.
func TestCycleFocusBackwardFromStaleNowFocus(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}}) // idle → focusOrder is [fleet, models]
	m.focus = focusNow

	m.cycleFocus(-1)

	if m.focus != focusModels {
		t.Fatalf("Shift+Tab from a stale NOW focus should land on MODELS (last actionable); got %d", m.focus)
	}
}
