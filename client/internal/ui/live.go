package ui

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/events"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const maxActivity = 6

// Canonical pipeline phases for the PhaseProgress stepper (mirrors RunStepSchema;
// the transient "retry" is folded into the current phase by simply not matching).
var pipelinePhases = []string{"gate", "classify", "setup", "generate", "validate", "health", "execute", "decide"}

type activityItem struct {
	callID string
	kind   string
	target string
	status string // running | completed
}

type subagentItem struct {
	key    string // workerId, or the target when no workerId
	worker string // workerId, if any
	target string
	status string // running | completed
}

type testItem struct {
	name       string
	file       string
	status     string // discovered | running | pass | fail | flaky
	durationMs float64
	detail     string
	attempts   int
}

// liveModel watches one run and folds its RunEvent stream into structured state,
// each piece rendered by a dedicated component. While running it shows the live
// view; once a verdict arrives it renders a Summary recap. A viewport scrolls the
// body and absorbs terminal resizes.
type liveModel struct {
	runID     string
	app       string
	phase     string
	activity  []activityItem
	subagents []subagentItem
	plan      []events.PlanTodo
	specs     []string
	tests     []testItem
	reviewer  *bool
	reasons   []string
	coverage  *events.CoverageComputed
	passed    int
	failed    int
	errs      []string
	verdict   string
	done      bool
	closed    bool
	spin      spinner.Model
	vp        viewport.Model
	ready     bool // a terminal size is known → the viewport is active
	width     int
	height    int
	ch        chan events.RunEvent
	cancel    context.CancelFunc
}

func newLiveModel(runID, app string, ch chan events.RunEvent, cancel context.CancelFunc, width, height int) liveModel {
	sp := spinner.New()
	sp.Spinner = spinner.MiniDot
	sp.Style = infoStyle
	m := liveModel{runID: runID, app: app, ch: ch, cancel: cancel, spin: sp}
	if width > 0 && height > 0 {
		m.resize(width, height)
	}
	return m
}

func (m liveModel) Update(msg tea.Msg) (liveModel, tea.Cmd) {
	switch msg := msg.(type) {
	case runEventMsg:
		m.fold(events.RunEvent(msg))
		m.refresh()
		return m, waitForEventCmd(m.ch) // read the next event
	case streamClosedMsg:
		m.closed = true
		if msg.err != nil && !errors.Is(msg.err, context.Canceled) && !m.done {
			m.errs = append(m.errs, msg.err.Error())
		}
		m.refresh()
		return m, nil
	case tea.WindowSizeMsg:
		m.resize(msg.Width, msg.Height)
		return m, nil
	case spinner.TickMsg:
		if m.done {
			return m, nil // stop animating once the run finished
		}
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		m.refresh() // re-render so the new spinner frame reaches the viewport
		return m, cmd
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			m.cancel() // stop the stream goroutine
			return m, func() tea.Msg { return backMsg{} }
		case "a":
			if m.done {
				return m, func() tea.Msg { return askMsg{} }
			}
		case "c":
			if m.done {
				if failed := m.failedTests(); len(failed) > 0 {
					return m, func() tea.Msg { return continueMsg{cases: failed} }
				}
			}
		case "up", "down", "pgup", "pgdown", "k", "j":
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		}
	}
	return m, nil
}

func (m liveModel) failedTests() []string {
	var out []string
	for _, t := range m.tests {
		if t.status == "fail" {
			out = append(out, t.name)
		}
	}
	return out
}

func (m *liveModel) fold(ev events.RunEvent) {
	switch b := ev.Body.(type) {
	case events.StepChanged:
		m.phase = b.Step
	case events.AgentActivity:
		if b.Kind == "subagent" {
			m.subagents = upsertSubagent(m.subagents, b)
		} else {
			m.activity = upsertActivity(m.activity, b)
		}
	case events.PlanUpdated:
		m.plan = b.Todos
	case events.SpecWritten:
		m.specs = appendUnique(m.specs, b.File)
	case events.TestDiscovered:
		m.tests = upsertDiscoveredTest(m.tests, b.Name, b.File)
	case events.TestStarted:
		m.tests = upsertTest(m.tests, b.Name, "running", 0, "", 0)
	case events.TestPassed:
		m.tests = upsertTest(m.tests, b.Name, "pass", b.DurationMs, "", 0)
	case events.TestFailed:
		m.tests = upsertTest(m.tests, b.Name, "fail", b.DurationMs, b.Detail, 0)
	case events.TestFlaky:
		m.tests = upsertTest(m.tests, b.Name, "flaky", 0, "", b.Attempts)
	case events.ReviewerVerdict:
		v := b.Approved
		m.reviewer = &v
		m.reasons = b.Reasons
	case events.CoverageComputed:
		c := b
		m.coverage = &c
	case events.RunVerdict:
		m.verdict = b.Verdict
		m.passed = b.Passed
		m.failed = b.Failed
		m.done = true
	case events.AgentError:
		m.errs = append(m.errs, b.Detail)
	}
}

func upsertActivity(items []activityItem, a events.AgentActivity) []activityItem {
	if a.CallID != "" {
		for i := range items {
			if items[i].callID == a.CallID {
				items[i].status, items[i].target, items[i].kind = a.Status, a.Target, a.Kind
				return items
			}
		}
	}
	items = append(items, activityItem{callID: a.CallID, kind: a.Kind, target: a.Target, status: a.Status})
	if len(items) > maxActivity {
		items = items[len(items)-maxActivity:]
	}
	return items
}

func upsertSubagent(items []subagentItem, a events.AgentActivity) []subagentItem {
	key := a.WorkerID
	if key == "" {
		key = a.Target
	}
	for i := range items {
		if items[i].key == key {
			items[i].status, items[i].target, items[i].worker = a.Status, a.Target, a.WorkerID
			return items
		}
	}
	return append(items, subagentItem{key: key, worker: a.WorkerID, target: a.Target, status: a.Status})
}

func upsertDiscoveredTest(tests []testItem, name, file string) []testItem {
	for i := range tests {
		if tests[i].name == name {
			if file != "" {
				tests[i].file = file
			}
			if tests[i].status == "" {
				tests[i].status = "discovered"
			}
			return tests
		}
	}
	return append(tests, testItem{name: name, file: file, status: "discovered"})
}

func upsertTest(tests []testItem, name, status string, dur float64, detail string, attempts int) []testItem {
	for i := range tests {
		if tests[i].name == name {
			tests[i].status = status
			if dur > 0 {
				tests[i].durationMs = dur
			}
			if detail != "" {
				tests[i].detail = detail
			}
			if attempts > 0 {
				tests[i].attempts = attempts
			}
			return tests
		}
	}
	return append(tests, testItem{name: name, status: status, durationMs: dur, detail: detail, attempts: attempts})
}

func appendUnique(xs []string, s string) []string {
	for _, x := range xs {
		if x == s {
			return xs
		}
	}
	return append(xs, s)
}

// ── Layout ────────────────────────────────────────────────────────────────────

func (m *liveModel) resize(w, h int) {
	m.width, m.height = w, h
	vpHeight := h - lipgloss.Height(m.header()) - lipgloss.Height(m.footer()) - 4 // padding + join lines
	if vpHeight < 3 {
		vpHeight = 3
	}
	vpWidth := w - 4
	if vpWidth < 10 {
		vpWidth = 10
	}
	if !m.ready {
		m.vp = viewport.New(vpWidth, vpHeight)
		m.ready = true
	} else {
		m.vp.Width, m.vp.Height = vpWidth, vpHeight
	}
	m.vp.SetContent(m.body())
}

// refresh re-renders the body into the viewport after a state or spinner change.
func (m *liveModel) refresh() {
	if m.ready {
		m.vp.SetContent(m.body())
	}
}

func (m liveModel) View() string {
	if !m.ready {
		// No terminal size yet → render everything without scroll (fallback).
		return screenStyle.Render(m.header() + "\n" + m.body() + "\n" + m.footer())
	}
	return screenStyle.Render(m.header() + "\n" + m.vp.View() + "\n" + m.footer())
}

func (m liveModel) header() string {
	status := infoStyle.Render("running")
	if m.done {
		status = verdictStyle(m.verdict).Bold(true).Render(m.verdict)
	}
	top := titleStyle.Render("run") + "  " + labelStyle.Render(m.app) + "  " + hintStyle.Render(m.runID) + "  " + status
	return top + "\n" + m.renderPhases()
}

func (m liveModel) footer() string {
	footer := "esc back · ctrl+c quit"
	if m.ready {
		footer = "↑↓ scroll · " + footer
	}
	if m.done {
		actions := "a ask"
		if len(m.failedTests()) > 0 {
			actions += " · c continue failed"
		}
		footer = actions + " · " + footer
	}
	return hintStyle.Render(footer)
}

func (m liveModel) body() string {
	if m.done {
		return m.summaryBody()
	}
	return m.liveBody()
}

func (m liveModel) liveBody() string {
	sections := []string{
		m.renderActivity(),
		m.renderSubagents(),
		m.renderPlan(),
		m.renderSpecs(),
		m.renderTests(),
		m.renderCoverage(),
		m.renderReviewer(),
		m.renderErrs(),
	}
	return joinSections(sections)
}

func (m liveModel) summaryBody() string {
	var b strings.Builder
	icon, vs := verdictBadge(m.verdict)
	b.WriteString(vs.Bold(true).Render(icon+" "+strings.ToUpper(m.verdict)) + "\n")
	counts := okStyle.Render(fmt.Sprintf("%d passed", m.passed))
	if m.failed > 0 {
		counts += labelStyle.Render(" · ") + errorStyle.Render(fmt.Sprintf("%d failed", m.failed))
	}
	b.WriteString(counts + "\n")

	sections := []string{
		m.renderSpecs(),
		m.renderTests(),
		m.renderCoverage(),
		m.renderReviewer(),
		m.renderErrs(),
	}
	body := joinSections(sections)
	if body != "" {
		b.WriteString("\n" + body)
	}
	return b.String()
}

func joinSections(sections []string) string {
	var out []string
	for _, s := range sections {
		if s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, "\n")
}

func (m liveModel) renderPhases() string {
	cur := indexOf(pipelinePhases, m.phase)
	parts := make([]string, len(pipelinePhases))
	for i, p := range pipelinePhases {
		switch {
		case m.done:
			parts[i] = hintStyle.Render(p)
		case i == cur:
			parts[i] = okStyle.Bold(true).Render(p)
		case cur >= 0 && i < cur:
			parts[i] = labelStyle.Render(p)
		default:
			parts[i] = hintStyle.Render(p)
		}
	}
	return strings.Join(parts, hintStyle.Render(" · "))
}

func (m liveModel) renderActivity() string {
	if len(m.activity) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(infoStyle.Render("agent") + "\n")
	for _, a := range m.activity {
		marker := okStyle.Render("✓")
		if a.status == "running" {
			marker = m.spin.View()
		}
		b.WriteString("  " + marker + " " + labelStyle.Render(activityVerb(a.kind)) + " " + a.target + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m liveModel) renderSubagents() string {
	if len(m.subagents) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(infoStyle.Render("subagents") + "\n")
	for _, s := range m.subagents {
		marker := okStyle.Render("✓")
		if s.status == "running" {
			marker = m.spin.View()
		}
		line := "  " + marker + " "
		if s.worker != "" {
			line += shadowStyle.Render("[" + s.worker + "] ")
		}
		b.WriteString(line + s.target + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m liveModel) renderPlan() string {
	if len(m.plan) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(infoStyle.Render("plan") + "\n")
	for _, t := range m.plan {
		box, st := "☐", labelStyle
		switch t.Status {
		case "in_progress":
			box, st = "◐", infoStyle
		case "completed":
			box, st = "☑", okStyle
		case "cancelled":
			box, st = "✗", hintStyle
		}
		b.WriteString("  " + st.Render(box+" "+t.Content) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m liveModel) renderSpecs() string {
	if len(m.specs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(infoStyle.Render("specs") + "\n")
	for _, f := range m.specs {
		b.WriteString("  " + okStyle.Render("✎ ") + f + "  " + labelStyle.Render("written") + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m liveModel) renderTests() string {
	if len(m.tests) == 0 {
		return ""
	}
	counts := countTests(m.tests)
	current, currentIdx, hasCurrent := currentTest(m.tests)
	next, hasNext := nextQueuedTest(m.tests, currentIdx)

	var b strings.Builder
	b.WriteString(infoStyle.Render("tests") + "\n")
	b.WriteString("  " + labelStyle.Render(formatTestHistory(counts)) + "\n")

	if hasCurrent {
		b.WriteString("  " + infoStyle.Bold(true).Render(m.spin.View()+" now "+current.name) + "\n")
		detail := current.file
		if detail == "" {
			detail = "executing current Playwright case"
		}
		b.WriteString("    " + hintStyle.Render(truncate(detail, 76)) + "\n")
	} else if m.done {
		b.WriteString("  " + verdictStyle(m.verdict).Render("finished") + "\n")
		if failed, ok := firstFailedTest(m.tests); ok {
			b.WriteString("    " + errorStyle.Render("first failed: "+failed.name) + "\n")
			if failed.detail != "" {
				b.WriteString("    " + hintStyle.Render(truncate(failed.detail, 76)) + "\n")
			}
		}
	} else {
		b.WriteString("  " + hintStyle.Render("waiting for test runner") + "\n")
	}

	if hasNext {
		line := "next " + next.name
		if next.file != "" {
			line += "  " + truncate(next.file, 64)
		}
		b.WriteString("  " + hintStyle.Render(line) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

type testCounts struct {
	passed  int
	failed  int
	flaky   int
	running int
	queued  int
}

func countTests(tests []testItem) testCounts {
	var c testCounts
	for _, t := range tests {
		switch t.status {
		case "pass":
			c.passed++
		case "fail":
			c.failed++
		case "flaky":
			c.flaky++
		case "running":
			c.running++
		case "discovered":
			c.queued++
		}
	}
	return c
}

func formatTestHistory(c testCounts) string {
	parts := []string{
		fmt.Sprintf("%d passed", c.passed),
		fmt.Sprintf("%d failed", c.failed),
		fmt.Sprintf("%d flaky", c.flaky),
	}
	if c.running > 0 {
		parts = append(parts, fmt.Sprintf("%d running", c.running))
	}
	if c.queued > 0 {
		parts = append(parts, fmt.Sprintf("%d queued", c.queued))
	}
	return "history: " + strings.Join(parts, " · ")
}

func currentTest(tests []testItem) (testItem, int, bool) {
	for i := len(tests) - 1; i >= 0; i-- {
		if tests[i].status == "running" {
			return tests[i], i, true
		}
	}
	return testItem{}, -1, false
}

func nextQueuedTest(tests []testItem, currentIdx int) (testItem, bool) {
	start := currentIdx + 1
	if start < 0 {
		start = 0
	}
	for i := start; i < len(tests); i++ {
		if tests[i].status == "discovered" {
			return tests[i], true
		}
	}
	for i := 0; i < start && i < len(tests); i++ {
		if tests[i].status == "discovered" {
			return tests[i], true
		}
	}
	return testItem{}, false
}

func firstFailedTest(tests []testItem) (testItem, bool) {
	for _, t := range tests {
		if t.status == "fail" {
			return t, true
		}
	}
	return testItem{}, false
}

func (m liveModel) renderCoverage() string {
	if m.coverage == nil || m.coverage.ChangedLines == 0 {
		return ""
	}
	pct := float64(m.coverage.CoveredLines) / float64(m.coverage.ChangedLines) * 100
	st := okStyle
	if pct < 100 {
		st = shadowStyle
	}
	line := fmt.Sprintf("%d/%d changed lines covered (%.0f%%)", m.coverage.CoveredLines, m.coverage.ChangedLines, pct)
	return infoStyle.Render("coverage") + "\n  " + st.Render(line)
}

func (m liveModel) renderReviewer() string {
	if m.reviewer == nil {
		return ""
	}
	var b strings.Builder
	if *m.reviewer {
		b.WriteString(okStyle.Render("reviewer: approved"))
	} else {
		b.WriteString(errorStyle.Render("reviewer: rejected"))
	}
	for _, r := range m.reasons {
		b.WriteString("\n  " + hintStyle.Render("- "+truncate(r, 68)))
	}
	return b.String()
}

func (m liveModel) renderErrs() string {
	if len(m.errs) == 0 {
		return ""
	}
	var b strings.Builder
	for _, e := range m.errs {
		b.WriteString(errorStyle.Render("⚠ "+truncate(e, 70)) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func activityVerb(kind string) string {
	switch kind {
	case "analyzing":
		return "analyzing"
	case "writing":
		return "writing"
	case "command":
		return "$"
	case "subagent":
		return "subagent"
	default:
		return kind
	}
}

func verdictStyle(v string) lipgloss.Style {
	switch v {
	case "pass", "skipped":
		return okStyle
	case "fail", "invalid":
		return errorStyle
	default:
		return shadowStyle
	}
}

func verdictBadge(v string) (string, lipgloss.Style) {
	switch v {
	case "pass":
		return "✓", okStyle
	case "skipped":
		return "•", okStyle
	case "fail", "invalid":
		return "✗", errorStyle
	default:
		return "⚠", shadowStyle
	}
}

func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// ── Stream plumbing: a goroutine reads the SSE stream and pushes events onto a
// channel; a read-next tea.Cmd hands each one to the main loop. The model is
// mutated only in Update — the goroutine never touches it (review note #7).

func startStreamCmd(ctx context.Context, c *api.Client, id string, ch chan events.RunEvent) tea.Cmd {
	return func() tea.Msg {
		err := c.StreamRunEventsReconnect(ctx, id, func(ev events.RunEvent) {
			sendRunEvent(ctx, ch, ev)
		})
		close(ch)
		return streamClosedMsg{err: err}
	}
}

func sendRunEvent(ctx context.Context, ch chan events.RunEvent, ev events.RunEvent) bool {
	select {
	case ch <- ev:
		return true
	case <-ctx.Done():
		return false
	}
}

func waitForEventCmd(ch chan events.RunEvent) tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return nil // channel closed; streamClosedMsg already signalled the end
		}
		return runEventMsg(ev)
	}
}
