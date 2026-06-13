package ui

import (
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func setRunning(m *dashboardModel, app, id string) {
	m.sys.queue.Running = &struct {
		App string `json:"app"`
		Id  string `json:"id"`
	}{App: app, Id: id}
}

func keyRune(r string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(r)} }

// At the top of FLEET, ↑ crosses up into the NOW panel when a run is active — the operator
// can reach the live run with arrows alone, no Tab.
func TestNavUpFromFleetTopFocusesNow(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}, {Name: "b"}})
	setRunning(&m, "a", "r1")
	m.focus = focusFleet
	m.cursor = 0

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})

	if m.focus != focusNow {
		t.Fatalf("↑ at FLEET top with a running run should focus NOW; focus=%d", m.focus)
	}
}

// When idle (no running run) there is nothing to focus above FLEET, so ↑ at the top stays put.
func TestNavUpFromFleetTopStaysWhenIdle(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	m.focus = focusFleet
	m.cursor = 0

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})

	if m.focus != focusFleet || m.cursor != 0 {
		t.Fatalf("↑ at FLEET top when idle should stay; focus=%d cursor=%d", m.focus, m.cursor)
	}
}

// ↓ past the last project lands on the "+ onboard" row (cursor == len(apps)), then continues
// into MODELS — so the onboard action is reachable by arrows, not only the global 'o'.
func TestNavDownReachesOnboardRowThenModels(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	m.focus = focusFleet
	m.cursor = 0

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown}) // → onboard row
	if m.focus != focusFleet || m.cursor != 1 {
		t.Fatalf("↓ past last project should land on the onboard row (cursor=len(apps)); focus=%d cursor=%d", m.focus, m.cursor)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown}) // → models
	if m.focus != focusModels {
		t.Fatalf("↓ from the onboard row should enter MODELS; focus=%d", m.focus)
	}
}

// ↵ on the onboard row onboards a project.
func TestEnterOnOnboardRowOnboards(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	m.focus = focusFleet
	m.cursor = 1 // the onboard row

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if cmd == nil {
		t.Fatal("enter on the onboard row must emit a command")
	}
	if _, ok := cmd().(onboardSelectedMsg); !ok {
		t.Fatalf("enter on the onboard row should onboard; got %#v", cmd())
	}
}

// ↵ on the focused NOW panel resumes (re-attaches) the active run.
func TestNowEnterWatchesRun(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	setRunning(&m, "a", "run_7")
	m.focus = focusNow

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if cmd == nil {
		t.Fatal("enter on NOW must emit a command")
	}
	if msg, ok := cmd().(watchRunMsg); !ok || msg.id != "run_7" {
		t.Fatalf("enter on NOW should watch the running run; got %#v", cmd())
	}
}

// Stopping the active run from NOW is destructive → two-press confirm (first x arms, second
// x issues the cancel), reusing the established stopArmed pattern.
func TestNowStopRequiresTwoPress(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	setRunning(&m, "a", "run_7")
	m.focus = focusNow

	m, cmd := m.Update(keyRune("x"))
	if cmd != nil {
		t.Fatalf("first x should only arm the stop, no command; got %#v", cmd())
	}
	if !m.stopArmed {
		t.Fatal("first x should arm the stop confirmation")
	}
	_, cmd = m.Update(keyRune("x"))
	if cmd == nil {
		t.Fatal("second x should issue the cancel command")
	}
}
