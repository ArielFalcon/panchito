package ui

import (
	"testing"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
	tea "github.com/charmbracelet/bubbletea"
)

func TestConnectedMsgSwitchesToHome(t *testing.T) {
	m := New()
	updated, _ := m.Update(connectedMsg{client: api.New("http://x", ""), apps: []contract.AppView{{Name: "portfolio"}}})
	m = updated.(Model)
	if m.screen != screenHome {
		t.Fatalf("screen = %v, want home", m.screen)
	}
	if len(m.home.apps) != 1 || m.home.apps[0].Name != "portfolio" {
		t.Fatalf("home apps: %+v", m.home.apps)
	}
}

func TestAppSelectedOpensLauncher(t *testing.T) {
	m := Model{screen: screenHome, home: newHomeModel([]contract.AppView{{Name: "portfolio"}})}
	updated, _ := m.Update(appSelectedMsg{app: "portfolio"})
	m = updated.(Model)
	if m.screen != screenLauncher || m.launcher.app != "portfolio" {
		t.Fatalf("screen=%v app=%q", m.screen, m.launcher.app)
	}
}

func TestLauncherWalksToLaunchMsg(t *testing.T) {
	m := newLauncherModel("portfolio")
	enter := tea.KeyMsg{Type: tea.KeyEnter}

	m, _ = m.Update(enter) // target → e2e
	if m.step != stepMode || m.target != "e2e" {
		t.Fatalf("after target: step=%d target=%q", m.step, m.target)
	}
	m, _ = m.Update(enter) // mode → diff
	if m.step != stepShadow || m.mode != "diff" {
		t.Fatalf("after mode: step=%d mode=%q", m.step, m.mode)
	}
	_, cmd := m.Update(enter) // shadow → false → launch
	if cmd == nil {
		t.Fatal("expected a launch command")
	}
	lm, ok := cmd().(launchMsg)
	if !ok {
		t.Fatalf("expected launchMsg, got %T", cmd())
	}
	if lm.input.App != "portfolio" || lm.input.Target != "e2e" || lm.input.Mode != "diff" {
		t.Fatalf("launch input: %+v", lm.input)
	}
	if lm.input.Shadow == nil || *lm.input.Shadow {
		t.Fatalf("shadow = %v, want false", lm.input.Shadow)
	}
}

func TestLauncherEscStepsBackThenLeaves(t *testing.T) {
	m := newLauncherModel("portfolio")
	enter := tea.KeyMsg{Type: tea.KeyEnter}
	esc := tea.KeyMsg{Type: tea.KeyEsc}
	m, _ = m.Update(enter) // → stepMode
	m, _ = m.Update(esc)   // back to stepTarget
	if m.step != stepTarget {
		t.Fatalf("esc did not step back: step=%d", m.step)
	}
	_, cmd := m.Update(esc) // at step 0 → leave
	if cmd == nil {
		t.Fatal("esc at first step must emit backMsg")
	}
	if _, ok := cmd().(backMsg); !ok {
		t.Fatalf("expected backMsg, got %T", cmd())
	}
}

func TestLiveFoldsEventsAndVerdict(t *testing.T) {
	ch := make(chan events.RunEvent, 4)
	m := newLiveModel("run_1", "portfolio", ch, func() {})

	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "step.changed", Body: events.StepChanged{Step: "generate"}}))
	if m.step != "generate" {
		t.Fatalf("step = %q", m.step)
	}
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "test.passed", Body: events.TestPassed{Name: "login", DurationMs: 1200}}))
	if len(m.lines) < 2 {
		t.Fatalf("want >=2 feed lines, got %d", len(m.lines))
	}
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "run.verdict", Body: events.RunVerdict{Verdict: "pass"}}))
	if !m.done || m.verdict != "pass" {
		t.Fatalf("done=%v verdict=%q", m.done, m.verdict)
	}
}

func TestLiveEscCancelsAndGoesBack(t *testing.T) {
	cancelled := false
	m := newLiveModel("r", "a", make(chan events.RunEvent, 1), func() { cancelled = true })
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if !cancelled {
		t.Fatal("esc must cancel the stream")
	}
	if cmd == nil {
		t.Fatal("esc must emit a command")
	}
	if _, ok := cmd().(backMsg); !ok {
		t.Fatalf("expected backMsg, got %T", cmd())
	}
}

func TestCtrlCQuits(t *testing.T) {
	m := New()
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("ctrl+c must return a command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("ctrl+c command must be tea.Quit")
	}
}

func TestQOnlyQuitsOnHome(t *testing.T) {
	m := New() // connect screen
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if cmd != nil {
		if _, ok := cmd().(tea.QuitMsg); ok {
			t.Fatal("q on the connect screen must not quit")
		}
	}
}
