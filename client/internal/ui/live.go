package ui

import (
	"context"
	"fmt"
	"strings"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/events"
	"github.com/charmbracelet/bubbles/spinner"
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

type testItem struct {
	name       string
	status     string // running | pass | fail | flaky
	durationMs float64
	detail     string
}

// liveModel watches one run and folds its RunEvent stream into structured state,
// each piece rendered by a dedicated component.
type liveModel struct {
	runID    string
	app      string
	phase    string
	activity []activityItem
	plan     []events.PlanTodo
	tests    []testItem
	reviewer *bool
	errs     []string
	verdict  string
	done     bool
	closed   bool
	spin     spinner.Model
	ch       chan events.RunEvent
	cancel   context.CancelFunc
}

func newLiveModel(runID, app string, ch chan events.RunEvent, cancel context.CancelFunc) liveModel {
	sp := spinner.New()
	sp.Spinner = spinner.MiniDot
	sp.Style = infoStyle
	return liveModel{runID: runID, app: app, ch: ch, cancel: cancel, spin: sp}
}

func (m liveModel) Update(msg tea.Msg) (liveModel, tea.Cmd) {
	switch msg := msg.(type) {
	case runEventMsg:
		m.fold(events.RunEvent(msg))
		return m, waitForEventCmd(m.ch) // read the next event
	case streamClosedMsg:
		m.closed = true
		return m, nil
	case spinner.TickMsg:
		if m.done {
			return m, nil // stop animating once the run finished
		}
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd
	case tea.KeyMsg:
		if msg.String() == "esc" {
			m.cancel() // stop the stream goroutine
			return m, func() tea.Msg { return backMsg{} }
		}
	}
	return m, nil
}

func (m *liveModel) fold(ev events.RunEvent) {
	switch b := ev.Body.(type) {
	case events.StepChanged:
		m.phase = b.Step
	case events.AgentActivity:
		m.activity = upsertActivity(m.activity, b)
	case events.PlanUpdated:
		m.plan = b.Todos
	case events.TestStarted:
		m.tests = upsertTest(m.tests, b.Name, "running", 0, "")
	case events.TestPassed:
		m.tests = upsertTest(m.tests, b.Name, "pass", b.DurationMs, "")
	case events.TestFailed:
		m.tests = upsertTest(m.tests, b.Name, "fail", b.DurationMs, b.Detail)
	case events.TestFlaky:
		m.tests = upsertTest(m.tests, b.Name, "flaky", 0, "")
	case events.ReviewerVerdict:
		v := b.Approved
		m.reviewer = &v
	case events.RunVerdict:
		m.verdict = b.Verdict
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

func upsertTest(tests []testItem, name, status string, dur float64, detail string) []testItem {
	for i := range tests {
		if tests[i].name == name {
			tests[i].status = status
			if dur > 0 {
				tests[i].durationMs = dur
			}
			if detail != "" {
				tests[i].detail = detail
			}
			return tests
		}
	}
	return append(tests, testItem{name: name, status: status, durationMs: dur, detail: detail})
}

func (m liveModel) View() string {
	var b strings.Builder

	status := infoStyle.Render("running")
	if m.done {
		status = verdictStyle(m.verdict).Bold(true).Render(m.verdict)
	}
	b.WriteString(titleStyle.Render("run") + "  " + labelStyle.Render(m.app) + "  " + hintStyle.Render(m.runID) + "  " + status + "\n")
	b.WriteString(m.renderPhases() + "\n")

	for _, section := range []string{m.renderActivity(), m.renderPlan(), m.renderTests()} {
		if section != "" {
			b.WriteString("\n" + section)
		}
	}
	if m.reviewer != nil {
		b.WriteString("\n")
		if *m.reviewer {
			b.WriteString(okStyle.Render("reviewer: approved") + "\n")
		} else {
			b.WriteString(errorStyle.Render("reviewer: rejected") + "\n")
		}
	}
	for _, e := range m.errs {
		b.WriteString(errorStyle.Render("⚠ "+truncate(e, 70)) + "\n")
	}
	if m.closed && !m.done {
		b.WriteString("\n" + hintStyle.Render("stream closed"))
	}
	b.WriteString("\n" + hintStyle.Render("esc back · ctrl+c quit"))
	return screenStyle.Render(b.String())
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
	return b.String()
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
	return b.String()
}

func (m liveModel) renderTests() string {
	if len(m.tests) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(infoStyle.Render("tests") + "\n")
	for _, t := range m.tests {
		switch t.status {
		case "running":
			b.WriteString("  " + m.spin.View() + " " + t.name + "\n")
		case "pass":
			b.WriteString("  " + okStyle.Render("✓ "+t.name) + " " + labelStyle.Render(fmt.Sprintf("%.0fms", t.durationMs)) + "\n")
		case "fail":
			b.WriteString("  " + errorStyle.Render("✗ "+t.name) + "\n")
			if t.detail != "" {
				b.WriteString("      " + hintStyle.Render(truncate(t.detail, 64)) + "\n")
			}
		case "flaky":
			b.WriteString("  " + shadowStyle.Render("~ "+t.name) + "\n")
		}
	}
	return b.String()
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
		err := c.StreamRunEventsReconnect(ctx, id, func(ev events.RunEvent) { ch <- ev })
		close(ch)
		return streamClosedMsg{err: err}
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
