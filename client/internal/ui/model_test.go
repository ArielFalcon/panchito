package ui

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
	tea "github.com/charmbracelet/bubbletea"
)

func TestConnectedMsgSwitchesToDashboard(t *testing.T) {
	m := New()
	updated, _ := m.Update(connectedMsg{client: api.New("http://x", ""), apps: []contract.AppView{{Name: "portfolio"}}})
	m = updated.(Model)
	if m.screen != screenDashboard {
		t.Fatalf("screen = %v, want dashboard", m.screen)
	}
	if len(m.dashboard.sys.apps) != 1 || m.dashboard.sys.apps[0].Name != "portfolio" {
		t.Fatalf("dashboard apps: %+v", m.dashboard.sys.apps)
	}
}

func TestAppSelectedOpensLauncher(t *testing.T) {
	m := Model{screen: screenDashboard}
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

func TestLauncherDiffCommitsAdjustableWithArrows(t *testing.T) {
	m := newLauncherModel("portfolio")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // target → e2e, now stepMode (cursor on diff)
	if m.step != stepMode || m.diffCommits != 1 {
		t.Fatalf("want stepMode + diffCommits 1, got step=%d commits=%d", m.step, m.diffCommits)
	}
	// ← at the floor stays 1
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyLeft})
	if m.diffCommits != 1 {
		t.Fatalf("left at floor: diffCommits=%d want 1", m.diffCommits)
	}
	// → → → widens the diff window to 4
	for i := 0; i < 3; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRight})
	}
	if m.diffCommits != 4 {
		t.Fatalf("after 3×right: diffCommits=%d want 4", m.diffCommits)
	}
	// arrows only adjust on the diff option — move to 'complete' and → is a no-op
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRight})
	if m.diffCommits != 4 {
		t.Fatalf("→ on a non-diff option must not change commits: %d", m.diffCommits)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp}) // back to diff
	// choose diff → shadow → launch; the launch input carries commits=4
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})    // mode diff → stepShadow
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}) // shadow false → launch
	lm, ok := cmd().(launchMsg)
	if !ok {
		t.Fatalf("expected launchMsg, got %T", cmd())
	}
	if lm.input.Commits == nil || *lm.input.Commits != 4 {
		t.Fatalf("launch input commits = %v, want 4", lm.input.Commits)
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

func TestLauncherManualCollectsGuidance(t *testing.T) {
	m := newLauncherModel("portfolio")
	enter := tea.KeyMsg{Type: tea.KeyEnter}
	m, _ = m.Update(enter) // target → e2e
	for i := 0; i < 3; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown}) // mode cursor → manual (index 3)
	}
	m, _ = m.Update(enter) // select manual → enters the guidance step
	if m.step != stepGuidance {
		t.Fatalf("manual mode must enter the guidance step, got step %d", m.step)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("test the contact form")})
	m, _ = m.Update(enter) // submit guidance → shadow
	if m.step != stepShadow || m.guidance != "test the contact form" {
		t.Fatalf("guidance=%q step=%d", m.guidance, m.step)
	}
	_, cmd := m.Update(enter) // shadow → false → launch
	lm, ok := cmd().(launchMsg)
	if !ok {
		t.Fatalf("expected launchMsg, got %T", cmd())
	}
	if lm.input.Mode != "manual" || lm.input.Guidance == nil || *lm.input.Guidance != "test the contact form" {
		t.Fatalf("launch input mode=%v guidance=%v", lm.input.Mode, lm.input.Guidance)
	}
}

func TestLiveFoldsEventsIntoStructuredState(t *testing.T) {
	ch := make(chan events.RunEvent, 8)
	m := newLiveModel("run_1", "portfolio", ch, func() {}, 0, 0)

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
	if !strings.Contains(out, "1 passed") || !strings.Contains(out, "TESTS") {
		t.Fatalf("view missing test section:\n%s", out)
	}
}

func TestLiveExecutionViewFocusesCurrentTestAndKeepsLargeSuitesCompact(t *testing.T) {
	m := newLiveModel("run_1", "portfolio", make(chan events.RunEvent, 1), func() {}, 100, 30)

	for i := 1; i <= 80; i++ {
		name := fmt.Sprintf("case-%02d", i)
		m, _ = m.Update(runEventMsg(events.RunEvent{
			Type: "test.discovered",
			Body: events.TestDiscovered{Name: name, File: fmt.Sprintf("e2e/case-%02d.spec.ts", i)},
		}))
	}
	for i := 1; i <= 40; i++ {
		name := fmt.Sprintf("case-%02d", i)
		m, _ = m.Update(runEventMsg(events.RunEvent{
			Type: "test.passed",
			Body: events.TestPassed{Name: name, DurationMs: float64(100 + i)},
		}))
	}
	m, _ = m.Update(runEventMsg(events.RunEvent{
		Type: "test.started",
		Body: events.TestStarted{Name: "case-41"},
	}))

	out := m.renderTests()
	// The current case is now shown as a focus card (readable spec/flow, NOT the raw file path).
	for _, want := range []string{"TESTS", "history", "40 passed", "NOW RUNNING", "case-41", "next", "case-42"} {
		if !strings.Contains(out, want) {
			t.Fatalf("renderTests() missing %q:\n%s", want, out)
		}
	}
	// The absolute path is deliberately no longer surfaced, and non-focused tests stay hidden.
	for _, hidden := range []string{"case-01", "case-80", "e2e/case-80.spec.ts", "e2e/case-41.spec.ts"} {
		if strings.Contains(out, hidden) {
			t.Fatalf("renderTests() should not show %q:\n%s", hidden, out)
		}
	}
	// The card gives the current case more presence, so the compact ceiling is higher than before.
	if lines := strings.Count(out, "\n"); lines > 13 {
		t.Fatalf("renderTests() too tall for a large suite: %d lines\n%s", lines, out)
	}
}

func TestLiveRendersDedicatedComponentsAndSummary(t *testing.T) {
	m := newLiveModel("r", "portfolio", make(chan events.RunEvent, 1), func() {}, 0, 0)

	for _, ev := range []events.RunEvent{
		{Type: "spec.written", Body: events.SpecWritten{File: "flows/contact.spec.ts"}},
		{Type: "agent.activity", Body: events.AgentActivity{Kind: "subagent", Target: "explore checkout", Status: "running"}},
		{Type: "coverage.computed", Body: events.CoverageComputed{ChangedLines: 10, CoveredLines: 7}},
		{Type: "reviewer.verdict", Body: events.ReviewerVerdict{Approved: false, Reasons: []string{"scope the selector to the header"}}},
	} {
		m, _ = m.Update(runEventMsg(ev))
	}

	live := m.View()
	for _, want := range []string{"SPECS", "flows/contact.spec.ts", "written", "SUBAGENTS", "explore checkout", "COVERAGE", "70%", "REVIEWER", "rejected", "scope the selector"} {
		if !strings.Contains(live, want) {
			t.Fatalf("live view missing %q:\n%s", want, live)
		}
	}

	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "run.verdict", Body: events.RunVerdict{Verdict: "fail", Passed: 2, Failed: 1}}))
	summary := m.View()
	// The recap is at-a-glance: verdict, counts, a plain-English outcome, and an
	// always-visible "what happened" block (specs, reviewer + reasons, coverage) — no
	// digging through collapsed accordions.
	for _, want := range []string{
		"FAIL", "2 passed", "1 failed", "GitHub Issue", // verdict + outcome line
		"WHAT HAPPENED", "contact.spec.ts", "rejected", "scope the selector", "70%",
	} {
		if !strings.Contains(summary, want) {
			t.Fatalf("summary view missing %q:\n%s", want, summary)
		}
	}
}

func TestSummarySurfacesInfraErrorNote(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 0, 0)
	// Simulate an infra-error run: note is populated before the verdict fires.
	m.agentErr = "git add failed: node_modules in .gitignore"
	m, _ = m.Update(runEventMsg(events.RunEvent{
		Type: "run.verdict",
		Body: events.RunVerdict{Verdict: "infra-error", Passed: 0, Failed: 0},
	}))
	// The note must be visible in the recap (outcome line + "what happened"), not buried.
	out := m.View()
	if !strings.Contains(out, "infrastructure error") || !strings.Contains(out, "git add failed") {
		t.Fatalf("infra-error recap must surface the note:\n%s", out)
	}
}

// A code/context run carries no Playwright test list, so the recap's substance is the
// files it wrote and commands it ran — these must be listed BY NAME, not as bare counts.
func TestSummaryListsWrittenFilesByNameForCodeRun(t *testing.T) {
	m := newLiveModel("r", "panchito", make(chan events.RunEvent, 1), func() {}, 0, 0)
	for _, ev := range []events.RunEvent{
		{Type: "run.started", Body: events.RunStarted{Sha: "abc", Target: "code", Mode: "context"}},
		{Type: "agent.activity", Body: events.AgentActivity{Kind: "writing", Target: "e2e/.qa/context.json", Status: "completed"}},
		{Type: "agent.activity", Body: events.AgentActivity{Kind: "writing", Target: "src/auth/login.test.ts", Status: "completed"}},
		{Type: "agent.activity", Body: events.AgentActivity{Kind: "command", Target: "npm test", Status: "completed"}},
	} {
		m, _ = m.Update(runEventMsg(ev))
	}
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "run.verdict", Body: events.RunVerdict{Verdict: "pass"}}))

	out := m.View()
	for _, want := range []string{"WHAT HAPPENED", "context.json", "login.test.ts", "npm test"} {
		if !strings.Contains(out, want) {
			t.Fatalf("code-run recap must list what it produced by name, missing %q:\n%s", want, out)
		}
	}
}

// Item navigation belongs to the CLOSED chat; once the chat is focused (via 'a'), the arrows scroll
// the conversation and letters type into the question — they no longer move the item cursor.
func TestLiveChatFocusScrollsAndNavigationIsForClosedChat(t *testing.T) {
	m := newLiveModel("r", "portfolio", make(chan events.RunEvent, 1), func() {}, 0, 0)
	m.client = api.New("http://x", "")
	m.done = true
	m.verdict = "pass"
	m.tests = []testItem{{name: "t1", status: "pass"}, {name: "t2", status: "fail", detail: "boom"}}
	m.passed = 1

	// Chat CLOSED → ↑↓ navigate the item list.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if m.sumFocus != 1 {
		t.Fatalf("with chat closed, ↓ must advance sumFocus; got %d", m.sumFocus)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	if m.sumFocus != 0 {
		t.Fatalf("with chat closed, ↑ must go back; got %d", m.sumFocus)
	}

	// Open the chat with 'a'.
	var cmd tea.Cmd
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	if !m.chatActive || cmd == nil {
		t.Fatalf("'a' must open the chat; active=%v cmd=%v", m.chatActive, cmd)
	}

	// Chat FOCUSED → the arrows scroll the conversation; they must NOT move the item cursor.
	before := m.sumFocus
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyUp})
	if m.sumFocus != before {
		t.Fatalf("with chat focused, arrows must scroll (not navigate); sumFocus %d→%d", before, m.sumFocus)
	}

	// j/k are letters here — they type the question, they do not navigate.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if m.sumFocus != before {
		t.Fatalf("'j' with chat focused must type, not navigate; sumFocus=%d", m.sumFocus)
	}
	if m.chatInput.Value() != "j" {
		t.Fatalf("'j' must reach the chat input; got %q", m.chatInput.Value())
	}

	// More typing still routes to the input.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	if m.chatInput.Value() != "jhi" {
		t.Fatalf("typing must reach chat input: got %q", m.chatInput.Value())
	}

	// esc closes the chat.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if m.chatActive {
		t.Fatal("esc must close the chat")
	}
}

func TestLiveSummaryShowsRealOutcomeFromBackend(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 0, 0)
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "run.verdict", Body: events.RunVerdict{
		Verdict: "pass", Passed: 3, Outcome: "suite PR merged · https://github.com/org/app/pull/7",
	}}))
	out := m.View()
	// The recap shows the ACTUAL outcome (PR URL) from the backend, not a generic guess.
	if !strings.Contains(out, "suite PR merged") || !strings.Contains(out, "pull/7") {
		t.Fatalf("summary must show the backend outcome:\n%s", out)
	}
}

func TestLiveSummaryChatEnterSendsMessageNotToggle(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 0, 0)
	m.client = api.New("http://x", "")
	m.done = true
	m.verdict = "fail"
	m.tests = []testItem{{name: "t1", status: "fail", detail: "boom"}}

	// Focus the chat and type a question.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("why did it fail")})
	openBefore := m.sumOpen

	// Enter with text must SEND the message — not expand the focused test (the reported bug).
	var cmd tea.Cmd
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !m.chatLoading || cmd == nil {
		t.Fatalf("enter with text must send the chat message (loading=%v cmd=%v)", m.chatLoading, cmd)
	}
	if m.sumOpen != openBefore {
		t.Fatalf("enter with text must NOT toggle a test; sumOpen changed %q→%q", openBefore, m.sumOpen)
	}
	if last := m.chatEntries[len(m.chatEntries)-1]; last.role != "q" || last.raw != "why did it fail" {
		t.Fatalf("the question must be recorded; got %+v", last)
	}
}

func TestLiveSummaryNavigatesSectionsAndExportsJSON(t *testing.T) {
	m := newLiveModel("exp_test_run", "portfolio", make(chan events.RunEvent, 1), func() {}, 0, 0)
	for _, ev := range []events.RunEvent{
		{Type: "spec.written", Body: events.SpecWritten{File: "flows/a.spec.ts"}},
		{Type: "test.passed", Body: events.TestPassed{Name: "t1", DurationMs: 100}},
		{Type: "run.verdict", Body: events.RunVerdict{Verdict: "pass", Passed: 1}},
	} {
		m, _ = m.Update(runEventMsg(ev))
	}
	// A passing run expands nothing by default (only a failure pre-opens its detail).
	if m.sumOpen != "" {
		t.Fatalf("passing run should not auto-expand a test; sumOpen=%q", m.sumOpen)
	}
	// Enter expands the focused test's detail.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.sumOpen != "t1" {
		t.Fatalf("after Enter, expanded test = %q, want t1", m.sumOpen)
	}

	// 'e' exports the run as JSON.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}})
	path := "qa-run-exp_test_run.json"
	defer os.Remove(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("export did not write %s: %v", path, err)
	}
	if !strings.Contains(string(data), `"verdict": "pass"`) || !strings.Contains(string(data), "flows/a.spec.ts") {
		t.Fatalf("exported JSON missing expected content:\n%s", data)
	}
}

func TestSendRunEventStopsAfterCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ch := make(chan events.RunEvent)

	done := make(chan bool, 1)
	go func() {
		done <- sendRunEvent(ctx, ch, events.RunEvent{Type: "step.changed"})
	}()

	select {
	case ok := <-done:
		if ok {
			t.Fatal("sendRunEvent should report false after cancellation")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("sendRunEvent blocked after cancellation")
	}
}

func TestLiveEscCancelsAndGoesBack(t *testing.T) {
	cancelled := false
	m := newLiveModel("r", "a", make(chan events.RunEvent, 1), func() { cancelled = true }, 0, 0)
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

// A failed stop on the live screen must surface as a run-control error, never as a fake
// assistant chat entry. Regression: live.go treated EVERY errMsg as an assistant error, so a
// cancel rejection (409/500/timeout) was misrendered as a chat bubble — invisible if the chat
// pane was closed. cancelRunCmd now reports failures as cancelErrMsg so the origin is unambiguous.
func TestLiveStopFailureSurfacesAsRunControlError(t *testing.T) {
	m := newLiveModel("r", "a", make(chan events.RunEvent, 1), func() {}, 0, 0)
	m.stopArmed = true
	before := len(m.chatEntries)
	m, _ = m.Update(cancelErrMsg{err: fmt.Errorf("run is no longer the active run")})
	if len(m.chatEntries) != before {
		t.Fatalf("a stop failure must NOT become a chat entry; chatEntries grew by %d", len(m.chatEntries)-before)
	}
	if m.stopArmed {
		t.Fatal("a stop failure must disarm the stop confirmation")
	}
	if out := m.View(); !strings.Contains(out, "run is no longer the active run") {
		t.Fatalf("the stop failure must surface in the live view as a run-control error; got:\n%s", out)
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

func TestQDoesNotQuitOnConnect(t *testing.T) {
	m := New() // connect screen
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if cmd != nil {
		if _, ok := cmd().(tea.QuitMsg); ok {
			t.Fatal("q on the connect screen must not quit")
		}
	}
}

func TestLiveEmbeddedChatAndContinue(t *testing.T) {
	m := newLiveModel("r", "portfolio", make(chan events.RunEvent, 1), func() {}, 0, 0)

	// Without a client, 'a' is inert.
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}}); cmd != nil {
		t.Fatal("'a' without a client must do nothing")
	}

	// With a client, 'a' opens the inline assistant (works mid-run, not only when done).
	m.client = api.New("http://x", "")
	var cmd tea.Cmd
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	if !m.chatActive || cmd == nil {
		t.Fatalf("'a' with a client must open the chat; active=%v cmd=%v", m.chatActive, cmd)
	}
	// Keystrokes route to the input; esc closes the chat without leaving the screen.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("hi")})
	if m.chatInput.Value() != "hi" {
		t.Fatalf("chat input = %q, want hi", m.chatInput.Value())
	}
	if m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc}); m.chatActive {
		t.Fatal("esc must close the chat")
	}

	// 'c' on a finished run with failures continues them.
	m.done = true
	m.tests = []testItem{{name: "checkout", status: "fail"}, {name: "nav", status: "pass"}}
	_, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'c'}})
	cm, ok := cmd().(continueMsg)
	if !ok || len(cm.cases) != 1 || cm.cases[0] != "checkout" {
		t.Fatalf("continue cases = %#v", cmd())
	}
}

func TestHistoryRendersLoadingEmptyAndErrorStates(t *testing.T) {
	m := newHistoryModel(nil, "portfolio")
	if !m.loading {
		t.Fatal("new history model must start in loading")
	}
	out := m.View()
	if !strings.Contains(out, "loading") {
		t.Fatalf("loading view missing 'loading':\n%s", out)
	}

	m.loading = false
	m.err = "network error"
	out = m.View()
	if !strings.Contains(out, "network error") {
		t.Fatalf("error view:\n%s", out)
	}

	m.err = ""
	m.loading = false
	out = m.View()
	if !strings.Contains(out, "no runs yet") {
		t.Fatalf("empty view:\n%s", out)
	}
}

func TestHistoryEscGoesBack(t *testing.T) {
	m := newHistoryModel(nil, "portfolio")
	m.loading = false
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd == nil {
		t.Fatal("esc must emit a command")
	}
	if _, ok := cmd().(backMsg); !ok {
		t.Fatalf("expected backMsg, got %T", cmd())
	}
}

func TestHistoryQQuits(t *testing.T) {
	m := Model{screen: screenHistory, history: newHistoryModel(nil, "x")}
	m.history.loading = false
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if cmd == nil {
		t.Fatal("'q' on history must return a command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("'q' on history must quit, got %T", cmd())
	}
}

func TestVerdictIconAndRelativeTime(t *testing.T) {
	pass := contract.RunRecordVerdictPass
	if runVerdictIcon(&pass) != "✓" {
		t.Fatalf("pass icon: %q", runVerdictIcon(&pass))
	}
	fail := contract.RunRecordVerdictFail
	if runVerdictIcon(&fail) != "✗" {
		t.Fatalf("fail icon: %q", runVerdictIcon(&fail))
	}
	if runVerdictIcon(nil) != "○" {
		t.Fatalf("nil verdict icon: %q", runVerdictIcon(nil))
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if relativeTime(now) != "now" {
		t.Fatalf("now time: %q", relativeTime(now))
	}
}

func TestHistoryEnterEmitsWatchRun(t *testing.T) {
	passed := 2
	failed := 1
	verdict := contract.RunRecordVerdictPass
	m := newHistoryModel(nil, "portfolio")
	m.loading = false
	m.runs = []contract.RunRecord{{
		Id:      "abc12345",
		Mode:    "diff",
		Verdict: &verdict,
		Passed:  &passed,
		Failed:  &failed,
		At:      "2026-06-11T10:30:00Z",
	}}
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter must emit a command")
	}
	msg, ok := cmd().(watchRunMsg)
	if !ok || msg.id != "abc12345" || msg.app != "portfolio" {
		t.Fatalf("expected watchRunMsg{id:abc12345, app:portfolio}, got %T %+v", cmd(), cmd())
	}
}

func TestWatchRunMsgOpensLiveScreen(t *testing.T) {
	m := Model{screen: screenHistory, client: api.New("http://x", "")}
	updated, cmd := m.Update(watchRunMsg{id: "run_1", app: "portfolio"})
	if cmd == nil {
		t.Fatal("watchRunMsg must produce commands")
	}
	m = updated.(Model)
	if m.screen != screenLive {
		t.Fatal("watchRunMsg must switch to live screen")
	}
}

func TestOnboardOwnerOffersMeAndInput(t *testing.T) {
	m := newOnboardModel(api.New("http://x", ""))
	if m.ownerCursor != 0 {
		t.Fatalf("owner step must default to @me (cursor 0), got %d", m.ownerCursor)
	}
	// Enter on @me loads the token user's repos.
	if _, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd == nil {
		t.Fatal("enter on @me must emit a list-repos command")
	}
	// Move to the text input; an empty owner errors instead of loading.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	if m.ownerCursor != 1 {
		t.Fatalf("down must focus the owner input, cursor=%d", m.ownerCursor)
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil || m.err == "" {
		t.Fatalf("empty owner input must error, cmd=%v err=%q", cmd, m.err)
	}
}

func TestAppAdminRepoSelectionPrefillsCreateForm(t *testing.T) {
	m := newOnboardModel(nil)
	m, _ = m.Update(reposLoadedMsg{repos: []contract.RepoListItem{{FullName: "org/shop_front", Private: false}}})
	if m.step != appStepRepo {
		t.Fatalf("step=%v, want repo", m.step)
	}

	// Multi-select repo step (Task B2): space selects the cursor repo (the first pick
	// defaults to the "frontend" role) before enter commits the selection.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeySpace})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.step != appStepForm {
		t.Fatalf("step=%v, want form", m.step)
	}
	if m.repo != "org/shop_front" || m.nameInput.Value() != "shop-front" {
		t.Fatalf("prefill repo=%q name=%q", m.repo, m.nameInput.Value())
	}
}

func TestAppAdminFormTogglesAndValidates(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepForm
	m.repo = "org/shop"
	m.nameInput.SetValue("shop")
	m.baseInput.SetValue("")
	m.formCursor = fTarget
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{' '}})
	if m.target != "code" {
		t.Fatalf("target=%q, want code", m.target)
	}
	m.formCursor = fSave
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("code app save should produce command even without base url")
	}

	m.target = "e2e"
	m.baseInput.SetValue("")
	m.formCursor = fSave
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil || !strings.Contains(m.err, "base url") {
		t.Fatalf("expected base url validation, cmd=%v err=%q", cmd, m.err)
	}
}

func TestAppAdminEditKeepsNameReadOnly(t *testing.T) {
	app := contract.AppView{Name: "portfolio", Repo: "org/portfolio", BaseUrl: "https://dev", VersionUrl: "", Services: []contract.AppService{}}
	m := newEditAppModel(nil, app)
	if m.formCursor != 1 {
		t.Fatalf("edit cursor=%d, want base url first", m.formCursor)
	}

	m.formCursor = fName
	m.nameInput.SetValue("")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	if got := m.nameInput.Value(); got != "" {
		t.Fatalf("edit name input mutated: %q", got)
	}

	m.formCursor = fSave
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil || m.err != "" {
		t.Fatalf("edit save should use original name, cmd=%v err=%q", cmd, m.err)
	}
}

func TestAgentRendersLoadingAndConfig(t *testing.T) {
	m := newAgentModel(nil)
	if !m.loading {
		t.Fatal("new agent model must start in loading")
	}
	out := m.View()
	if !strings.Contains(out, "loading") {
		t.Fatalf("loading view missing 'loading':\n%s", out)
	}

	healthCodex := contract.AgentProviderHealth{
		Provider:   "codex",
		Status:     "needs_config",
		Configured: false,
	}
	cfg := contract.PublicAgentConfig{
		Mode:           "single",
		SingleProvider: "opencode",
	}
	cfg.Keys.Opencode = true
	cfg.Keys.Codex = false
	cfg.Health = &struct {
		Codex    *contract.AgentProviderHealth `json:"codex,omitempty"`
		Opencode *contract.AgentProviderHealth `json:"opencode,omitempty"`
	}{Codex: &healthCodex}
	cfg.Assignments.Primary = contract.RoleAssignment{Provider: "opencode", Model: "deepseek-v4-pro"}
	cfg.Assignments.Reviewer = contract.RoleAssignment{Provider: "opencode", Model: "qwen3.7-max"}
	cfg.Assignments.Chat = contract.RoleAssignment{Provider: "opencode", Model: "deepseek-v4-flash"}
	m.loading = false
	m.config = &cfg
	out = m.View()
	if !strings.Contains(out, "AGENT RUNTIME") || !strings.Contains(out, "single") {
		t.Fatalf("config view missing mode:\n%s", out)
	}
	if !strings.Contains(out, "deepseek-v4-pro") {
		t.Fatalf("config view missing model:\n%s", out)
	}
	if !strings.Contains(out, "needs_config") {
		t.Fatalf("config view missing health:\n%s", out)
	}
}

func TestAgentEscGoesBack(t *testing.T) {
	m := newAgentModel(nil)
	m.loading = false
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd == nil {
		t.Fatal("esc must emit a command")
	}
	if _, ok := cmd().(backMsg); !ok {
		t.Fatalf("expected backMsg, got %T", cmd())
	}
}

func TestAgentCursorNavigation(t *testing.T) {
	m := newAgentModel(nil)
	m.loading = false
	cfg := sampleAgentConfig()
	m.config = &cfg
	draft := cfg
	m.draft = &draft

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if m.cursor != 1 {
		t.Fatalf("down: cursor = %d, want 1", m.cursor)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	if m.cursor != 0 {
		t.Fatalf("up: cursor = %d, want 0", m.cursor)
	}
	for i := 0; i < 10; i++ {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	}
	want := len(m.menuItems()) - 1
	if m.cursor != want {
		t.Fatalf("cursor clamped: %d, want %d", m.cursor, want)
	}
}

func TestAgentApiKeyInputStagesSecretForApply(t *testing.T) {
	m := agentModelWithConfig(sampleAgentConfig())
	m.cursor = cursorForAgentAction(m, agentActionSetOpenKey)

	var cmd tea.Cmd
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter on set api key must start textinput blink")
	}
	if m.screen != agentScreenKey || m.keyProvider != "opencode" {
		t.Fatalf("screen=%v provider=%q", m.screen, m.keyProvider)
	}

	m.keyInput.SetValue("opencode-secret")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.screen != agentScreenMenu {
		t.Fatalf("screen after submit = %v, want menu", m.screen)
	}
	update := m.agentConfigUpdate(false)
	if update.ApiKeys == nil || update.ApiKeys.Opencode == nil || *update.ApiKeys.Opencode != "opencode-secret" {
		t.Fatalf("opencode key was not staged in update: %+v", update.ApiKeys)
	}
}

func TestAgentRoleModelSelectionUsesOnlySingleProviderModels(t *testing.T) {
	m := agentModelWithConfig(sampleAgentConfig())
	m.openModels = []contract.AgentModelInfo{{Id: "opencode-go/deepseek-v4-pro"}, {Id: "opencode-go/qwen3.7-max"}}
	m.codexModels = []contract.AgentModelInfo{{Id: "gpt-5.4"}}
	m.cursor = cursorForAgentAction(m, agentActionEditReviewer)

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.screen != agentScreenRole {
		t.Fatalf("screen=%v, want role selector", m.screen)
	}
	for _, opt := range m.roleOptions("reviewer") {
		if opt.provider != "opencode" {
			t.Fatalf("single mode exposed non-selected provider: %+v", opt)
		}
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if got := m.draft.Assignments.Reviewer.Model; got != "opencode-go/qwen3.7-max" {
		t.Fatalf("reviewer model = %q", got)
	}
}

func TestAgentDualApplyWithOneProviderRequiresConfirmation(t *testing.T) {
	cfg := sampleAgentConfig()
	cfg.Mode = "dual"
	cfg.Assignments.Primary.Provider = "opencode"
	cfg.Assignments.Reviewer.Provider = "opencode"
	cfg.Assignments.Chat.Provider = "opencode"
	m := agentModelWithConfig(cfg)
	m.cursor = cursorForAgentAction(m, agentActionApply)

	var cmd tea.Cmd
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Fatal("single-provider dual apply must wait for confirmation before issuing API command")
	}
	if m.screen != agentScreenConfirmDowngrade {
		t.Fatalf("screen=%v, want confirm downgrade", m.screen)
	}
	update := m.agentConfigUpdate(true)
	if update.ConfirmSingleDowngrade == nil || !*update.ConfirmSingleDowngrade {
		t.Fatalf("confirm flag missing: %+v", update.ConfirmSingleDowngrade)
	}
}

func TestAgentToggleDualAssignsReviewerToOppositeProvider(t *testing.T) {
	m := agentModelWithConfig(sampleAgentConfig())
	m.codexModels = []contract.AgentModelInfo{{Id: "gpt-5.4"}}
	m.cursor = cursorForAgentAction(m, agentActionToggleMode)

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if m.draft.Mode != "dual" {
		t.Fatalf("mode = %q, want dual", m.draft.Mode)
	}
	if m.draft.Assignments.Reviewer.Provider != "codex" || m.draft.Assignments.Reviewer.Model != "gpt-5.4" {
		t.Fatalf("reviewer assignment = %+v", m.draft.Assignments.Reviewer)
	}
}

func sampleAgentConfig() contract.PublicAgentConfig {
	cfg := contract.PublicAgentConfig{
		Mode:           "single",
		SingleProvider: "opencode",
	}
	cfg.Keys.Opencode = true
	cfg.Keys.Codex = false
	cfg.Validation.Ok = true
	cfg.Assignments.Primary = contract.RoleAssignment{Provider: "opencode", Model: "opencode-go/deepseek-v4-pro"}
	cfg.Assignments.Reviewer = contract.RoleAssignment{Provider: "opencode", Model: "opencode-go/deepseek-v4-pro"}
	cfg.Assignments.Chat = contract.RoleAssignment{Provider: "opencode", Model: "opencode-go/deepseek-v4-flash"}
	return cfg
}

func agentModelWithConfig(cfg contract.PublicAgentConfig) agentModel {
	m := newAgentModel(nil)
	m.loading = false
	m.config = &cfg
	draft := cfg
	m.draft = &draft
	return m
}

func cursorForAgentAction(m agentModel, action agentMenuAction) int {
	for i, item := range m.menuItems() {
		if item.action == action {
			return i
		}
	}
	panic("agent action not found: " + string(action))
}

func TestPipelinePhasesIncludesCoverage(t *testing.T) {
	if !hasString(pipelinePhases, "coverage") {
		t.Fatalf("pipelinePhases must include 'coverage': got %v", pipelinePhases)
	}
}

func TestCoveragePhaseDescription(t *testing.T) {
	got := phaseDescription("coverage")
	if got == "coverage" {
		t.Fatalf("phaseDescription(coverage) must return a human label, not the raw string %q", got)
	}
}

func TestCoveragePhaseIndexIsValid(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 0, 0)
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "step.changed", Body: events.StepChanged{Step: "coverage"}}))
	idx := m.phaseIndex()
	if idx < 0 {
		t.Fatalf("phaseIndex() for 'coverage' = %d, want >= 0; pipelinePhases = %v", idx, pipelinePhases)
	}
	if got := m.phaseFraction(); got <= 0 {
		t.Fatalf("phaseFraction() for 'coverage' = %v, must be > 0", got)
	}
}

func hasString(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}
