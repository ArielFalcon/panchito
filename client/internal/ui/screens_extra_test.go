package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
)

// The live body must carry the one-line "what's happening now" status (the horizontal
// rail in the header is the only pipeline view — no second, vertical copy).
func TestLivePhaseStatusNoDuplicateSpine(t *testing.T) {
	m := newLiveModel("r", "portfolio", make(chan events.RunEvent, 1), func() {}, 100, 30)
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "step.changed", Body: events.StepChanged{Step: "generate"}}))

	body := m.liveBody()
	if !strings.Contains(body, "the agent is generating tests") {
		t.Fatalf("live body missing the active-phase status line:\n%s", body)
	}
	// The vertical pipeline checklist (its own "pipeline" rule) must be gone — the rail
	// in the header is the single source of pipeline truth.
	if strings.Contains(body, "PIPELINE") {
		t.Fatalf("live body must not duplicate the pipeline as a vertical spine:\n%s", body)
	}

	// Once the run is done the recap takes over — no live status line.
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "run.verdict", Body: events.RunVerdict{Verdict: "pass"}}))
	if m.renderPhaseStatus() != "" {
		t.Fatal("phase status must be empty once the run is done")
	}
}

// Stopping the active run from the NOW panel disarms if any other key intervenes between the
// two x presses (the stop is folded into NOW now that the separate sessions screen is gone).
func TestNowStopDisarmsOnOtherKey(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	setRunning(&m, "portfolio", "run_1")
	m.focus = focusNow

	m, _ = m.Update(keyRune("x")) // arm
	if !m.stopArmed {
		t.Fatal("first x must arm the stop confirmation")
	}
	m, _ = m.Update(keyRune("r")) // any other key disarms
	if m.stopArmed {
		t.Fatal("a non-x key must disarm the stop confirmation")
	}
}

func TestHistoryTrendHeader(t *testing.T) {
	m := newHistoryModel(nil, "portfolio")
	m.loading = false
	m.runs = []contract.RunRecord{
		{Id: "r1", Verdict: vptr(contract.RunRecordVerdictPass), At: "2026-06-13T14:00:00Z"},
		{Id: "r2", Verdict: vptr(contract.RunRecordVerdictFail), At: "2026-06-13T13:00:00Z"},
	}
	out := m.View()
	if !strings.Contains(out, "TREND") || !strings.Contains(out, "pass") {
		t.Fatalf("history trend header missing:\n%s", out)
	}
}
