package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
)

// Resuming a run that finished while detached lands on the recap. Like the live RunVerdict
// path, the recap must open with the cursor on (and expanding) the first failing test, so the
// problem is front-and-center instead of buried under a passing case.
func TestLiveSeedDoneRunLandsCursorOnFirstFailure(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 100, 30)
	verdict := contract.RunRecordVerdictFail
	failed := 1
	rec := contract.RunRecord{
		Id: "r", App: "app", Status: "done", Verdict: &verdict, Failed: &failed,
		Cases: []contract.QaCase{
			{Name: "login", Status: contract.QaCaseStatusPass},
			{Name: "checkout", Status: contract.QaCaseStatusFail},
		},
	}

	m, _ = m.Update(runSnapshotMsg{rec: rec})

	if !m.done {
		t.Fatal("a finished-run snapshot must mark the live view done")
	}
	if m.sumOpen != "checkout" {
		t.Fatalf("recap must land expanded on the first failure; sumOpen=%q want %q", m.sumOpen, "checkout")
	}
}

// The snapshot is fetched once and can land AFTER the stream has already written fresher
// focus-card values. Seeding the sticky lastFile/lastCmd must never regress them.
func TestLiveSeedDoesNotRegressStreamFocusCard(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 100, 30)
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "agent.activity", Body: events.AgentActivity{
		CallID: "c1", Kind: "writing", Target: "fresh.spec.ts", Status: "completed"}}))

	rec := contract.RunRecord{
		Id: "r", App: "app", Status: "running",
		Activity: &[]contract.AgentActivity{{Kind: contract.File, Text: "stale.spec.ts"}},
	}
	m, _ = m.Update(runSnapshotMsg{rec: rec})

	if m.lastFile != "fresh.spec.ts" {
		t.Fatalf("snapshot must not clobber a fresher stream file; lastFile=%q want %q", m.lastFile, "fresh.spec.ts")
	}
}

// A run at the first pipeline phase ("gate") has fraction 0. The running FLEET row must not
// print a bare "0%" — that is the very digit P0-2 set out to remove. Show the phase alone.
func TestFleetRunningRowAtGateHidesZeroPercent(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "petclinic"}})
	m.sys.queue.Running = &struct {
		App string `json:"app"`
		Id  string `json:"id"`
	}{App: "petclinic", Id: "r1"}
	step := "gate"
	m.sys.running = &contract.RunRecord{App: "petclinic", Step: &step}

	out := m.renderFleet(90)

	if !strings.Contains(out, "gate") {
		t.Fatalf("running row should show the gate phase; got:\n%s", out)
	}
	if strings.Contains(out, "0%") {
		t.Fatalf("a 0%% fraction (gate) must not render a bare 0%% on the running row; got:\n%s", out)
	}
}

// The snapshot anchors the elapsed clock from the run's start time so the header shows real
// time-on-task immediately on resume (regression guard for seedFromRecord).
func TestLiveSeedAnchorsElapsedClock(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 100, 30)
	step := "generate"
	rec := contract.RunRecord{Id: "r", App: "app", Status: "running", At: "2026-06-14T00:00:00Z", Step: &step}

	m, _ = m.Update(runSnapshotMsg{rec: rec})

	if d, ok := m.runElapsed(); !ok || d < 0 {
		t.Fatalf("snapshot should anchor the elapsed clock; runElapsed() = (%v, %v)", d, ok)
	}
}
