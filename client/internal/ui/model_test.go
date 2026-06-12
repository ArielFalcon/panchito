package ui

import (
	"strings"
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

func TestLiveFoldsEventsIntoStructuredState(t *testing.T) {
	ch := make(chan events.RunEvent, 8)
	m := newLiveModel("run_1", "portfolio", ch, func() {})

	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "step.changed", Body: events.StepChanged{Step: "generate"}}))
	if m.phase != "generate" {
		t.Fatalf("phase = %q", m.phase)
	}

	// A test goes running → pass, keyed by name (one row, not two).
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "test.started", Body: events.TestStarted{Name: "login"}}))
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "test.passed", Body: events.TestPassed{Name: "login", DurationMs: 1200}}))
	if len(m.tests) != 1 || m.tests[0].status != "pass" || m.tests[0].durationMs != 1200 {
		t.Fatalf("tests: %+v", m.tests)
	}

	// A running tool then its completion update the SAME activity row (by callID).
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "agent.activity", Body: events.AgentActivity{Kind: "analyzing", Target: "Header.astro", Status: "running", CallID: "c1"}}))
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "agent.activity", Body: events.AgentActivity{Kind: "analyzing", Target: "Header.astro", Status: "completed", CallID: "c1"}}))
	if len(m.activity) != 1 || m.activity[0].status != "completed" {
		t.Fatalf("activity: %+v", m.activity)
	}

	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "plan.updated", Body: events.PlanUpdated{Todos: []events.PlanTodo{{Content: "a", Status: "in_progress"}}}}))
	if len(m.plan) != 1 {
		t.Fatalf("plan: %+v", m.plan)
	}

	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "run.verdict", Body: events.RunVerdict{Verdict: "pass"}}))
	if !m.done || m.verdict != "pass" {
		t.Fatalf("done=%v verdict=%q", m.done, m.verdict)
	}
	// View renders without panicking and shows the dedicated sections.
	out := m.View()
	if !strings.Contains(out, "login") || !strings.Contains(out, "tests") {
		t.Fatalf("view missing test section:\n%s", out)
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
