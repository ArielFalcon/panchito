package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
)

// On resume, the live view must paint the run's current state from the record snapshot
// BEFORE any SSE event is folded — otherwise a mid-run re-attach shows an empty rail and
// 0% during a quiet phase (the photo-2 "broken on resume" bug).
func TestLiveSeedFromRecordPaintsPhaseBeforeEvents(t *testing.T) {
	m := newLiveModel("run_1", "petclinic", make(chan events.RunEvent, 1), func() {}, 100, 30)
	step := "generate"
	started := "2026-06-14T00:00:00Z"
	rec := contract.RunRecord{
		Id: "run_1", App: "petclinic", Sha: "abc1234def", Status: "running",
		Target: contract.RunRecordTarget("e2e"), Mode: contract.RunRecordMode("manual"),
		Step: &step, StepStartedAt: &started,
	}

	m, _ = m.Update(runSnapshotMsg{rec: rec})

	if m.phase != "generate" {
		t.Fatalf("phase = %q, want %q (snapshot must seed the phase)", m.phase, "generate")
	}
	if m.phaseFraction() <= 0 {
		t.Fatalf("phaseFraction = %v, want > 0 (the rail/progress must not read 0%% on resume)", m.phaseFraction())
	}
	out := m.View()
	if !strings.Contains(out, "generating tests") {
		t.Fatalf("resumed live view should show the generate phase status; got:\n%s", out)
	}
}

// The snapshot can be staler than the live stream (it is fetched once on attach while the
// stream keeps advancing). Seeding must never regress a phase the stream already moved past.
func TestLiveSeedDoesNotRegressStreamPhase(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 100, 30)
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "step.changed", Body: events.StepChanged{Step: "validate"}}))

	step := "generate"
	rec := contract.RunRecord{Id: "r", App: "app", Status: "running", Step: &step}
	m, _ = m.Update(runSnapshotMsg{rec: rec})

	if m.phase != "validate" {
		t.Fatalf("phase = %q, want %q (snapshot must not regress a fresher stream phase)", m.phase, "validate")
	}
}
