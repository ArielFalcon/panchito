package ui

import (
	"testing"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

// A poll must keep recentCursor inside the feed (defensive parity with the fleet cursor clamp),
// so the RECENT caret never points past the last run.
func TestRecentCursorClampedOnPoll(t *testing.T) {
	m := New()
	m.client = api.New("http://x", "")
	m.screen = screenDashboard
	m.dashboard = newDashboardModel(m.client)
	p := contract.RunRecordVerdictPass
	m.dashboard.fleet = map[string][]contract.RunRecord{"a": {
		{Id: "r1", App: "a", Verdict: &p, At: "2026-06-14T10:00:00Z"},
		{Id: "r2", App: "a", Verdict: &p, At: "2026-06-14T09:00:00Z"},
	}}
	m.dashboard.recentCursor = 5 // stale, past the 2-run feed

	updated, _ := m.Update(systemLoadedMsg{})

	if c := updated.(Model).dashboard.recentCursor; c >= 2 {
		t.Fatalf("a poll must clamp a stale recentCursor into the feed; got %d want < 2", c)
	}
}

// ↑ from the top of RECENT crosses back into MODELS at its bottom — the inverse of the
// down-crossing, completing the one continuous ↑↓ list.
func TestNavCrossesRecentToModels(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	p := contract.RunRecordVerdictPass
	m.fleet = map[string][]contract.RunRecord{"a": {
		{Id: "r1", App: "a", Verdict: &p, At: "2026-06-14T10:00:00Z"},
	}}
	m.focus = focusRecent
	m.recentCursor = 0

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})

	if m.focus != focusModels {
		t.Fatalf("↑ from the top of RECENT should cross into MODELS; focus=%d", m.focus)
	}
	// MODELS' bottom is now the "all settings" row, which sits one past the role roster.
	if m.modelCursor != len(m.modelRoleList()) {
		t.Fatalf("crossing up into MODELS should land at its bottom; modelCursor=%d", m.modelCursor)
	}
}
