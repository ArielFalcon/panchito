package ui

import (
	"context"
	"fmt"
	"strings"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/events"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const maxFeedLines = 18

// liveModel watches one run's RunEvent stream. E4b renders a simple event feed;
// E4c replaces it with the dedicated PhaseProgress / AgentActivityPane /
// PlanChecklist / TestList components.
type liveModel struct {
	runID   string
	app     string
	step    string
	lines   []string
	verdict string
	done    bool
	closed  bool
	ch      chan events.RunEvent
	cancel  context.CancelFunc
}

func newLiveModel(runID, app string, ch chan events.RunEvent, cancel context.CancelFunc) liveModel {
	return liveModel{runID: runID, app: app, ch: ch, cancel: cancel}
}

func (m liveModel) Update(msg tea.Msg) (liveModel, tea.Cmd) {
	switch msg := msg.(type) {
	case runEventMsg:
		ev := events.RunEvent(msg)
		if b, ok := ev.Body.(events.StepChanged); ok {
			m.step = b.Step
		}
		if b, ok := ev.Body.(events.RunVerdict); ok {
			m.verdict = b.Verdict
			m.done = true
		}
		if line := summarize(ev); line != "" {
			m.lines = append(m.lines, line)
			if len(m.lines) > maxFeedLines {
				m.lines = m.lines[len(m.lines)-maxFeedLines:]
			}
		}
		return m, waitForEventCmd(m.ch) // read the next event
	case streamClosedMsg:
		m.closed = true
		return m, nil
	case tea.KeyMsg:
		if msg.String() == "esc" {
			m.cancel() // stop the stream goroutine
			return m, func() tea.Msg { return backMsg{} }
		}
	}
	return m, nil
}

func (m liveModel) View() string {
	var b strings.Builder
	status := infoStyle.Render("running")
	if m.done {
		status = verdictStyle(m.verdict).Render(m.verdict)
	}
	b.WriteString(titleStyle.Render("run") + "  " + labelStyle.Render(m.app) + "  " + hintStyle.Render(m.runID) + "  " + status + "\n")
	if m.step != "" && !m.done {
		b.WriteString(infoStyle.Render("▸ "+m.step) + "\n")
	}
	b.WriteString("\n")
	for _, ln := range m.lines {
		b.WriteString(ln + "\n")
	}
	if m.closed && !m.done {
		b.WriteString("\n" + hintStyle.Render("stream closed"))
	}
	b.WriteString("\n" + hintStyle.Render("esc back · ctrl+c quit"))
	return screenStyle.Render(b.String())
}

func summarize(ev events.RunEvent) string {
	switch b := ev.Body.(type) {
	case events.StepChanged:
		return infoStyle.Render("▸ " + b.Step)
	case events.AgentActivity:
		return labelStyle.Render("  " + b.Kind + " ") + b.Target
	case events.PlanUpdated:
		return labelStyle.Render(fmt.Sprintf("  plan: %d item(s)", len(b.Todos)))
	case events.SpecWritten:
		return "  " + okStyle.Render("✎ "+b.File)
	case events.TestStarted:
		return infoStyle.Render("  ⟳ " + b.Name)
	case events.TestPassed:
		return okStyle.Render("  ✓ "+b.Name) + " " + labelStyle.Render(fmt.Sprintf("%.0fms", b.DurationMs))
	case events.TestFailed:
		return errorStyle.Render("  ✗ " + b.Name)
	case events.TestFlaky:
		return shadowStyle.Render("  ~ " + b.Name)
	case events.ReviewerVerdict:
		if b.Approved {
			return okStyle.Render("  reviewer: approved")
		}
		return errorStyle.Render("  reviewer: rejected")
	case events.RunVerdict:
		return ""
	case events.AgentError:
		return errorStyle.Render("  ⚠ " + b.Detail)
	case events.LogLine:
		return labelStyle.Render("  " + b.Text)
	default:
		return ""
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
