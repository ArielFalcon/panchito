package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

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
	runID      string
	app        string
	sha        string
	target     string
	mode       string
	phase      string
	phaseStart time.Time
	retrying   bool
	activity   []activityItem
	subagents  []subagentItem
	plan       []events.PlanTodo
	specs      []string
	tests      []testItem
	reviewer   *bool
	reasons    []string
	coverage   *events.CoverageComputed
	passed     int
	failed     int
	errs       []string
	agentErr   string
	logs       []string
	verdict    string
	done       bool
	closed     bool
	sumFocus   int    // focused summary section (done view)
	sumOpen    string // currently expanded summary section id
	exported   string // path of the exported JSON, once 'e' is pressed
	spin       spinner.Model
	vp         viewport.Model
	ready      bool // a terminal size is known → the viewport is active
	width      int
	height     int
	ch         chan events.RunEvent
	cancel     context.CancelFunc
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
		case "e":
			if m.done {
				if path, err := m.exportJSON(); err == nil {
					m.exported = path
				} else {
					m.exported = "(export failed: " + err.Error() + ")"
				}
				m.refresh()
				return m, nil
			}
		case "enter":
			if m.done {
				m.toggleSummary()
				return m, nil
			}
		case "up", "k":
			if m.done {
				m.moveSummary(-1)
				return m, nil
			}
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		case "down", "j":
			if m.done {
				m.moveSummary(1)
				return m, nil
			}
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		case "pgup", "pgdown":
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		}
	}
	return m, nil
}

func (m *liveModel) moveSummary(delta int) {
	secs := m.summarySections()
	if len(secs) == 0 {
		return
	}
	m.sumFocus = (m.sumFocus + delta + len(secs)) % len(secs)
	m.refresh()
}

func (m *liveModel) toggleSummary() {
	secs := m.summarySections()
	if m.sumFocus < 0 || m.sumFocus >= len(secs) {
		return
	}
	id := secs[m.sumFocus].id
	if m.sumOpen == id {
		m.sumOpen = ""
	} else {
		m.sumOpen = id
	}
	m.refresh()
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
	case events.RunStarted:
		m.sha, m.target, m.mode = b.Sha, b.Target, b.Mode
	case events.StepChanged:
		if b.Step != m.phase {
			m.phaseStart = time.Now() // reset the elapsed clock when the phase advances
		}
		m.phase = b.Step
		if b.Step == "retry" {
			m.retrying = true
		}
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
		if m.sumOpen == "" {
			m.sumOpen = "results" // open the test results by default, like the Ink summary
		}
	case events.LogLine:
		if b.Text != "" {
			m.logs = append(m.logs, b.Text)
			if len(m.logs) > 200 {
				m.logs = m.logs[len(m.logs)-200:]
			}
		}
	case events.AgentError:
		// A failed tool call (e.g. a read that the agent retries) is routine and NOT
		// part of the verdict. The Ink TUI never surfaced these in the live view — it
		// showed forward progress, not every hiccup. Keep only the last one, to explain
		// a fail/infra-error in the SUMMARY; never as a live red banner.
		m.agentErr = b.Detail
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
		status = verdictStyle(m.verdict).Bold(true).Render(strings.ToUpper(m.verdict))
	}
	top := titleStyle.Render("run") + "  " + lipgloss.NewStyle().Bold(true).Render(m.app)
	if m.sha != "" {
		top += "  " + hintStyle.Render(shortSha(m.sha))
	}
	if m.target != "" {
		tgt := infoStyle.Render(m.target)
		if m.target == "code" {
			tgt = shadowStyle.Render(m.target)
		}
		top += "  " + tgt + hintStyle.Render("/"+m.mode)
	}
	if m.retrying && !m.done {
		top += "  " + shadowStyle.Render("↻ retrying")
	}
	top += "  " + status
	return top + "\n" + m.renderPhases()
}

func shortSha(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

func (m liveModel) footer() string {
	if m.done {
		actions := "↑↓ sections · ↵ expand · e export · a ask"
		if len(m.failedTests()) > 0 {
			actions += " · c continue"
		}
		return hintStyle.Render(actions + " · esc back")
	}
	footer := "esc back · ctrl+c quit"
	if m.ready {
		footer = "↑↓ scroll · " + footer
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
	view := m.deriveActivity()
	sections := []string{
		m.renderFocusCard(view),
		m.renderFeed(view),
		m.renderSubagents(),
		m.renderSpecs(),
		m.renderTests(),
		m.renderCoverage(),
		m.renderReviewer(),
		m.renderErrs(),
	}
	return joinSections(sections)
}

type sumSection struct{ id, label string }

// summarySections is the ordered, data-driven list of collapsible recap sections.
func (m liveModel) summarySections() []sumSection {
	failedTxt := ""
	if m.failed > 0 {
		failedTxt = fmt.Sprintf(", %d failed", m.failed)
	}
	secs := []sumSection{
		{"pipeline", "Pipeline"},
		{"results", fmt.Sprintf("Test results (%d passed%s)", m.passed, failedTxt)},
	}
	if len(m.specs) > 0 {
		secs = append(secs, sumSection{"specs", fmt.Sprintf("Specs (%d)", len(m.specs))})
	}
	if m.coverage != nil && m.coverage.ChangedLines > 0 {
		secs = append(secs, sumSection{"coverage", "Coverage"})
	}
	if m.reviewer != nil {
		secs = append(secs, sumSection{"reviewer", "Reviewer"})
	}
	if len(m.logs) > 0 {
		secs = append(secs, sumSection{"logs", fmt.Sprintf("Execution logs (%d)", len(m.logs))})
	}
	if m.agentErr != "" && m.verdict != "pass" && m.verdict != "skipped" {
		secs = append(secs, sumSection{"note", "Agent note"})
	}
	return secs
}

func (m liveModel) summaryBody() string {
	var b strings.Builder
	icon, vs := verdictBadge(m.verdict)
	b.WriteString(vs.Bold(true).Render(icon + " " + strings.ToUpper(m.verdict)))
	counts := okStyle.Render(fmt.Sprintf("%d passed", m.passed))
	if m.failed > 0 {
		counts += labelStyle.Render(" · ") + errorStyle.Render(fmt.Sprintf("%d failed", m.failed))
	}
	if fl := countTests(m.tests).flaky; fl > 0 {
		counts += labelStyle.Render(" · ") + shadowStyle.Render(fmt.Sprintf("%d flaky", fl))
	}
	b.WriteString("   " + counts + "\n\n")

	for i, s := range m.summarySections() {
		arrow := "▸"
		if s.id == m.sumOpen {
			arrow = "▾"
		}
		head := arrow + " " + s.label
		if i == m.sumFocus {
			head = lipgloss.NewStyle().Foreground(colInfo).Bold(true).Render(head)
		} else {
			head = labelStyle.Render(head)
		}
		b.WriteString(head + "\n")
		if s.id == m.sumOpen {
			if body := m.renderSummarySection(s.id); body != "" {
				b.WriteString(indentLines(body, "    ") + "\n")
			}
		}
	}
	if m.exported != "" {
		b.WriteString("\n" + okStyle.Render("✓ exported → "+m.exported))
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m liveModel) renderSummarySection(id string) string {
	switch id {
	case "pipeline":
		return okStyle.Render("✓ ") + labelStyle.Render(strings.Join(pipelinePhases, " · "))
	case "results":
		return m.renderTests()
	case "specs":
		return m.renderSpecs()
	case "coverage":
		return m.renderCoverage()
	case "reviewer":
		return m.renderReviewer()
	case "logs":
		return m.renderLogs()
	case "note":
		return hintStyle.Render(truncate(m.agentErr, 88))
	}
	return ""
}

func (m liveModel) renderLogs() string {
	var b strings.Builder
	for _, l := range lastN(m.logs, 12) {
		b.WriteString(hintStyle.Render(truncate(strings.TrimPrefix(l, "[qa] "), 90)) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func indentLines(s, pad string) string {
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = pad + lines[i]
	}
	return strings.Join(lines, "\n")
}

// ── JSON export (the 'e' key on a finished run) ─────────────────────────────────

type testExport struct {
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	DurationMs float64 `json:"durationMs,omitempty"`
	Detail     string  `json:"detail,omitempty"`
	Attempts   int     `json:"attempts,omitempty"`
}

type runExport struct {
	RunID    string                   `json:"runId"`
	App      string                   `json:"app"`
	Sha      string                   `json:"sha,omitempty"`
	Target   string                   `json:"target,omitempty"`
	Mode     string                   `json:"mode,omitempty"`
	Verdict  string                   `json:"verdict"`
	Passed   int                      `json:"passed"`
	Failed   int                      `json:"failed"`
	Specs    []string                 `json:"specs,omitempty"`
	Tests    []testExport             `json:"tests,omitempty"`
	Coverage *events.CoverageComputed `json:"coverage,omitempty"`
	Reviewer *bool                    `json:"reviewerApproved,omitempty"`
	Reasons  []string                 `json:"reviewerReasons,omitempty"`
}

func (m liveModel) exportJSON() (string, error) {
	exp := runExport{
		RunID: m.runID, App: m.app, Sha: m.sha, Target: m.target, Mode: m.mode,
		Verdict: m.verdict, Passed: m.passed, Failed: m.failed,
		Specs: m.specs, Coverage: m.coverage, Reviewer: m.reviewer, Reasons: m.reasons,
	}
	for _, t := range m.tests {
		exp.Tests = append(exp.Tests, testExport{t.name, t.status, t.durationMs, t.detail, t.attempts})
	}
	data, err := json.MarshalIndent(exp, "", "  ")
	if err != nil {
		return "", err
	}
	id := m.runID
	if len(id) > 24 {
		id = id[:24]
	}
	path := "qa-run-" + id + ".json"
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
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
	line := wrapJoin(parts, hintStyle.Render(" · "), m.width-4) // -4: screenStyle horizontal padding
	// A transient/unknown phase (e.g. "retry") matches no canonical step, so cur==-1
	// and nothing would be highlighted — surface it explicitly instead of going blank.
	if cur < 0 && m.phase != "" && !m.done {
		line += "  " + titleStyle.Render("("+m.phase+")")
	}
	return line
}

// wrapJoin joins styled parts with sep, breaking to a new line whenever the next
// part would exceed width (measured in display cells, so ANSI styling is ignored).
// width <= 0 disables wrapping — used before a terminal size is known. Keeps the 8
// pipeline phases readable on terminals narrower than 80 columns.
func wrapJoin(parts []string, sep string, width int) string {
	if len(parts) == 0 {
		return ""
	}
	if width <= 0 {
		return strings.Join(parts, sep)
	}
	sepW := lipgloss.Width(sep)
	var b strings.Builder
	lineW := 0
	for i, p := range parts {
		pw := lipgloss.Width(p)
		switch {
		case i == 0:
			b.WriteString(p)
			lineW = pw
		case lineW+sepW+pw > width:
			b.WriteString("\n" + p)
			lineW = pw
		default:
			b.WriteString(sep + p)
			lineW += sepW + pw
		}
	}
	return b.String()
}

// ── Live activity: the FocusCard ("now") + the plan/wrote/ran feed ──────────────
// Ported from the Ink dashboard (FocusCard + LiveActivity): a bordered card with the
// current unit of work, then the agent's plan checklist, files written and commands
// run. Derived from the folded state, never invented.

type focusItem struct {
	title    string
	progress string // e.g. "3/8" of the plan todos
	lastFile string
	lastCmd  string
}

type activityView struct {
	focus *focusItem
	plan  []events.PlanTodo
	wrote []string
	ran   []string
}

func (m liveModel) deriveActivity() activityView {
	var wrote, ran []string
	var lastFile, lastCmd, lastRunning string
	for _, a := range m.activity {
		switch a.kind {
		case "writing":
			wrote = appendUnique(wrote, a.target)
			lastFile = a.target
		case "command":
			ran = appendUnique(ran, a.target)
			lastCmd = a.target
		}
		if a.status == "running" && a.target != "" {
			lastRunning = a.target
		}
	}
	title, completed := "", 0
	for _, t := range m.plan {
		if t.Status == "completed" {
			completed++
		}
		if t.Status == "in_progress" && title == "" {
			title = t.Content
		}
	}
	if title == "" {
		title = lastRunning
	}
	var focus *focusItem
	if title != "" {
		f := focusItem{title: title, lastFile: lastFile, lastCmd: lastCmd}
		if len(m.plan) > 0 {
			f.progress = fmt.Sprintf("%d/%d", completed, len(m.plan))
		}
		focus = &f
	}
	return activityView{focus: focus, plan: m.plan, wrote: wrote, ran: ran}
}

func (m liveModel) renderFocusCard(v activityView) string {
	if v.focus == nil || m.done {
		return ""
	}
	f := v.focus
	head := infoStyle.Render("now") + "  " + m.spin.View() + "  " + lipgloss.NewStyle().Bold(true).Render(truncate(f.title, 48))
	if f.progress != "" {
		head += "   " + hintStyle.Render(f.progress)
	}
	if !m.phaseStart.IsZero() {
		head += "   " + labelStyle.Render(formatElapsed(time.Since(m.phaseStart)))
	}
	var b strings.Builder
	b.WriteString(head)
	if f.lastFile != "" {
		b.WriteString("\n" + hintStyle.Render("✎ "+truncate(f.lastFile, 46)))
	}
	if f.lastCmd != "" {
		b.WriteString("\n" + hintStyle.Render("⚙ "+truncate(f.lastCmd, 46)))
	}
	return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(colInfo).Padding(0, 1).Render(b.String())
}

const feedGutter = 7

func gutterLabel(s string) string {
	if len(s) >= feedGutter {
		return s[:feedGutter]
	}
	return s + strings.Repeat(" ", feedGutter-len(s))
}

func (m liveModel) renderFeed(v activityView) string {
	if len(v.plan) == 0 && len(v.wrote) == 0 && len(v.ran) == 0 {
		return ""
	}
	var b strings.Builder
	for i, t := range v.plan {
		label := ""
		if i == 0 {
			label = "plan"
		}
		icon, text := hintStyle.Render("·"), labelStyle
		switch t.Status {
		case "completed":
			icon = okStyle.Render("✓")
		case "in_progress":
			icon, text = m.spin.View(), lipgloss.NewStyle()
		case "cancelled":
			icon = hintStyle.Render("✗")
		}
		b.WriteString(labelStyle.Render(gutterLabel(label)) + icon + " " + text.Render(truncate(t.Content, 52)) + "\n")
	}
	if len(v.wrote) > 0 {
		shown := lastN(v.wrote, 3)
		line := strings.Join(shown, " · ")
		if extra := len(v.wrote) - len(shown); extra > 0 {
			line += fmt.Sprintf("   +%d", extra)
		}
		b.WriteString(labelStyle.Render(gutterLabel("wrote")) + hintStyle.Render(truncate(line, 60)) + "\n")
	}
	if len(v.ran) > 0 {
		var parts []string
		for _, c := range lastN(v.ran, 2) {
			parts = append(parts, truncate(c, 40))
		}
		b.WriteString(labelStyle.Render(gutterLabel("ran")) + hintStyle.Render(strings.Join(parts, " · ")) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func lastN(xs []string, n int) []string {
	if len(xs) > n {
		return xs[len(xs)-n:]
	}
	return xs
}

func formatElapsed(d time.Duration) string {
	s := int(d.Seconds())
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	if s < 3600 {
		return fmt.Sprintf("%dm %ds", s/60, s%60)
	}
	return fmt.Sprintf("%dh %dm", s/3600, (s%3600)/60)
}

// progressBar is the Ink-style filled/empty block bar (green filled, muted empty).
func progressBar(done, total, width int) string {
	if total <= 0 {
		return hintStyle.Render(strings.Repeat("░", width))
	}
	filled := done * width / total
	if filled > width {
		filled = width
	}
	if filled < 0 {
		filled = 0
	}
	return okStyle.Render(strings.Repeat("▓", filled)) + hintStyle.Render(strings.Repeat("░", width-filled))
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
		b.WriteString(line + truncate(s.target, 56) + "\n")
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
	if total := len(m.tests); total > 0 && (counts.passed+counts.failed+counts.flaky) > 0 {
		b.WriteString("  " + progressBar(counts.passed, total, 24) + " " + hintStyle.Render(fmt.Sprintf("%d/%d", counts.passed, total)) + "\n")
	}

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
		b.WriteString(m.summaryTestDetail())
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
	var parts []string
	if c.passed > 0 {
		parts = append(parts, fmt.Sprintf("%d passed", c.passed))
	}
	if c.failed > 0 {
		parts = append(parts, fmt.Sprintf("%d failed", c.failed))
	}
	if c.flaky > 0 {
		parts = append(parts, fmt.Sprintf("%d flaky", c.flaky))
	}
	if c.running > 0 {
		parts = append(parts, fmt.Sprintf("%d running", c.running))
	}
	if c.queued > 0 {
		parts = append(parts, fmt.Sprintf("%d queued", c.queued))
	}
	if len(parts) == 0 {
		return "history: none yet"
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

// summaryTestDetail is the recap-only block (rendered under "finished"): flaky
// cases with their retry count, then the slowest cases with durations. Both are
// bounded so an 80-test suite never overflows the summary.
func (m liveModel) summaryTestDetail() string {
	var b strings.Builder
	if flaky := flakyTests(m.tests); len(flaky) > 0 {
		b.WriteString("  " + shadowStyle.Render("flaky") + "\n")
		for i, t := range flaky {
			if i >= 5 {
				b.WriteString("    " + hintStyle.Render(fmt.Sprintf("+%d more", len(flaky)-5)) + "\n")
				break
			}
			line := "~ " + truncate(t.name, 56)
			if t.attempts > 0 {
				line += fmt.Sprintf(" (%d attempts)", t.attempts)
			}
			b.WriteString("    " + shadowStyle.Render(line) + "\n")
		}
	}
	if slow := slowestTests(m.tests, 3); len(slow) > 0 {
		b.WriteString("  " + labelStyle.Render("slowest") + "\n")
		for _, t := range slow {
			b.WriteString("    " + labelStyle.Render(truncate(t.name, 56)) + " " + hintStyle.Render(formatDuration(t.durationMs)) + "\n")
		}
	}
	return b.String()
}

func flakyTests(tests []testItem) []testItem {
	var out []testItem
	for _, t := range tests {
		if t.status == "flaky" {
			out = append(out, t)
		}
	}
	return out
}

// slowestTests returns the n cases with the longest recorded duration, descending.
func slowestTests(tests []testItem, n int) []testItem {
	withDur := make([]testItem, 0, len(tests))
	for _, t := range tests {
		if t.durationMs > 0 {
			withDur = append(withDur, t)
		}
	}
	sort.SliceStable(withDur, func(i, j int) bool { return withDur[i].durationMs > withDur[j].durationMs })
	if len(withDur) > n {
		withDur = withDur[:n]
	}
	return withDur
}

func formatDuration(ms float64) string {
	if ms <= 0 {
		return ""
	}
	if ms < 1000 {
		return fmt.Sprintf("%dms", int(ms))
	}
	return fmt.Sprintf("%.1fs", ms/1000)
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

func verdictStyle(v string) lipgloss.Style {
	switch v {
	case "pass":
		return okStyle
	case "skipped":
		return infoStyle // a clean no-op is neutral, not a success — don't read as green "pass"
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
		return "•", infoStyle
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

// truncate clamps to n RUNES (not bytes): test names use " › " (U+203A) and files
// may be unicode, so byte-slicing would cut mid-rune into mojibake.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
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
