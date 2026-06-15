package ui

import (
	"errors"
	"testing"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
)

func runningLiveModel() liveModel {
	return newLiveModel("run_1", "petclinic", make(chan events.RunEvent, 1), func() {}, 100, 30)
}

// The watchdog re-seeds from the record only when the live stream has gone silent (no events
// for streamStaleAfter) and the run is still in flight — never when the run is done or when
// events are flowing.
func TestWatchdogShouldReseedWhenStreamIsStale(t *testing.T) {
	m := runningLiveModel()
	m.client = api.New("http://x", "")

	m.lastActivity = time.Now().Add(-streamStaleAfter - time.Second)
	if !m.watchdogShouldReseed(time.Now()) {
		t.Fatal("a stale stream on a running run must trigger a re-seed")
	}

	m.lastActivity = time.Now()
	if m.watchdogShouldReseed(time.Now()) {
		t.Fatal("a fresh stream must NOT trigger a re-seed")
	}

	m.lastActivity = time.Now().Add(-streamStaleAfter - time.Second)
	m.done = true
	if m.watchdogShouldReseed(time.Now()) {
		t.Fatal("a finished run must NOT trigger a re-seed")
	}

	m.done = false
	m.client = nil
	if m.watchdogShouldReseed(time.Now()) {
		t.Fatal("without a client there is no way to fetch a snapshot — must not re-seed")
	}
}

// A live stream event resets the staleness clock, so an actively-streaming run never polls.
func TestRunEventResetsStaleness(t *testing.T) {
	m := runningLiveModel()
	m.lastActivity = time.Now().Add(-time.Hour)
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "step.changed", Body: events.StepChanged{Step: "generate"}}))
	if time.Since(m.lastActivity) > time.Second {
		t.Fatalf("a stream event must refresh lastActivity; got %v ago", time.Since(m.lastActivity))
	}
}

// The watchdog tick re-arms while the run is live and stops once it is done.
func TestWatchdogTickReArmsWhileLiveStopsWhenDone(t *testing.T) {
	m := runningLiveModel()
	_, cmd := m.Update(watchdogTickMsg{})
	if cmd == nil {
		t.Fatal("watchdog must re-arm while the run is live")
	}
	m.done = true
	_, cmd = m.Update(watchdogTickMsg{})
	if cmd != nil {
		t.Fatal("watchdog must stop (no re-arm) once the run is done")
	}
}

// When the stream closes with no verdict (the run was produced out-of-process, so run.verdict
// never crossed this server's bus), the client pulls the authoritative record instead of
// freezing on the last live frame.
func TestStreamClosedFetchesSnapshotWhenNotDone(t *testing.T) {
	m := runningLiveModel()
	m.client = api.New("http://x", "")
	_, cmd := m.Update(streamClosedMsg{err: errors.New("stream gave up")})
	if cmd == nil {
		t.Fatal("a stream that closed before a verdict must trigger a snapshot re-seed")
	}

	m.done = true
	_, cmd = m.Update(streamClosedMsg{err: nil})
	if cmd != nil {
		t.Fatal("a finished run needs no re-seed on stream close")
	}
}

// A snapshot that reveals the run finished (while we were attached to a run executing in another
// process) must cancel the background stream so it stops reconnecting.
func TestTerminalSnapshotCancelsStream(t *testing.T) {
	cancelled := false
	m := newLiveModel("run_1", "app", make(chan events.RunEvent, 1), func() { cancelled = true }, 100, 30)
	verdict := contract.RunRecordVerdict("pass")
	rec := contract.RunRecord{Id: "run_1", App: "app", Status: "done", Verdict: &verdict}
	m, _ = m.Update(runSnapshotMsg{rec: rec})
	if !m.done {
		t.Fatal("a terminal snapshot must mark the run done")
	}
	if !cancelled {
		t.Fatal("a terminal snapshot must cancel the background stream (stop reconnecting)")
	}
}

// The watchdog re-seed advances the phase FORWARD from a record further along than the stream
// has shown, but never regresses a fresher live phase.
func TestReseedAdvancesPhaseForwardOnly(t *testing.T) {
	m := runningLiveModel()
	gen := "generate"
	m, _ = m.Update(runSnapshotMsg{rec: contract.RunRecord{Id: "run_1", Status: "running", Step: &gen}})
	if m.phase != "generate" {
		t.Fatalf("phase = %q, want generate", m.phase)
	}
	exec := "execute"
	m, _ = m.Update(runSnapshotMsg{rec: contract.RunRecord{Id: "run_1", Status: "running", Step: &exec}})
	if m.phase != "execute" {
		t.Fatalf("phase = %q, want execute (forward advance on re-seed)", m.phase)
	}
	m, _ = m.Update(runSnapshotMsg{rec: contract.RunRecord{Id: "run_1", Status: "running", Step: &gen}})
	if m.phase != "execute" {
		t.Fatalf("phase = %q, want execute (must not regress)", m.phase)
	}
}
