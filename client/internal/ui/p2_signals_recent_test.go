package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

// P2-2: the integrity panel must frame, in plain words, what it measures — otherwise the
// numbers read as inert decoration.
func TestSignalsFramesItsPurpose(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})

	out := m.renderSignals(90)
	low := strings.ToLower(out)

	if !strings.Contains(low, "integrity") {
		t.Fatalf("the panel title should convey purpose (integrity); got:\n%s", out)
	}
	if !strings.Contains(low, "catch real bugs") {
		t.Fatalf("the panel should frame in plain words what it measures; got:\n%s", out)
	}
}

// P2-3: RECENT is interactive — ↵ on a recent run opens it (the live screen, which shows the
// recap for a finished run via the snapshot seed).
func TestRecentEnterOpensRun(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	p := contract.RunRecordVerdictPass
	m.fleet = map[string][]contract.RunRecord{"portfolio": {
		{Id: "run_5", App: "portfolio", Verdict: &p, At: "2026-06-14T10:00:00Z"},
	}}
	m.focus = focusRecent
	m.recentCursor = 0

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if cmd == nil {
		t.Fatal("enter on a recent run must emit a command")
	}
	if msg, ok := cmd().(watchRunMsg); !ok || msg.id != "run_5" {
		t.Fatalf("enter on RECENT should open that run; got %#v", cmd())
	}
}

// ↓ flows from the last model role into RECENT, so the feed joins the one ↑↓ list.
func TestNavCrossesModelsToRecent(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	p := contract.RunRecordVerdictPass
	m.fleet = map[string][]contract.RunRecord{"a": {
		{Id: "r1", App: "a", Verdict: &p, At: "2026-06-14T10:00:00Z"},
	}}
	m.focus = focusModels
	m.modelCursor = len(m.modelRoleList()) // the all-settings row — MODELS' last navigable item

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})

	if m.focus != focusRecent {
		t.Fatalf("↓ from the bottom of MODELS should enter RECENT; focus=%d", m.focus)
	}
}
