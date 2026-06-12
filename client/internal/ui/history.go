package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// historyModel lists recent runs for one app. Opened from home with 'h'. Enter
// opens a run in the live screen; esc goes back; r refreshes.
type historyModel struct {
	client  *api.Client
	app     string
	runs    []contract.RunRecord
	cursor  int
	loading bool
	err     string
}

func newHistoryModel(client *api.Client, app string) historyModel {
	return historyModel{client: client, app: app, loading: true}
}

func (m historyModel) Init() tea.Cmd {
	return listHistoryCmd(m.client, m.app)
}

func (m historyModel) Update(msg tea.Msg) (historyModel, tea.Cmd) {
	switch msg := msg.(type) {
	case runsLoadedMsg:
		m.loading = false
		m.runs = msg.runs
		m.err = ""
		return m, nil
	case errMsg:
		m.loading = false
		m.err = msg.err.Error()
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.runs)-1 {
				m.cursor++
			}
		case "enter":
			if len(m.runs) > 0 && m.cursor < len(m.runs) {
				run := m.runs[m.cursor]
				return m, func() tea.Msg { return watchRunMsg{id: run.Id, app: m.app} }
			}
		case "r":
			if !m.loading {
				m.loading = true
				m.err = ""
				m.cursor = 0
				return m, listHistoryCmd(m.client, m.app)
			}
		case "esc":
			return m, func() tea.Msg { return backMsg{} }
		}
	}
	return m, nil
}

func (m historyModel) View() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("history") + "  " + labelStyle.Render(m.app) + "\n\n")

	switch {
	case m.loading:
		b.WriteString(infoStyle.Render("loading…") + "\n")
	case m.err != "":
		b.WriteString(errorStyle.Render("✗ "+m.err) + "\n")
	case len(m.runs) == 0:
		b.WriteString(hintStyle.Render("no runs yet — launch one from home") + "\n")
	default:
		for i, r := range m.runs {
			marker := "  "
			line := formatRunLine(r)
			if i == m.cursor {
				marker = okStyle.Render("▸ ")
				line = lipgloss.NewStyle().Bold(true).Render(line)
			}
			b.WriteString(marker + line + "\n")
		}
	}
	b.WriteString("\n" + hintStyle.Render("↑↓ move · enter watch · r refresh · esc back · q quit"))
	return screenStyle.Render(b.String())
}

func formatRunLine(r contract.RunRecord) string {
	icon := runVerdictIcon(r.Verdict)
	st := runVerdictStyle(r.Verdict)
	mode := string(r.Mode)
	shortID := r.Id
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	counts := ""
	if r.Passed != nil || r.Failed != nil {
		p, f := 0, 0
		if r.Passed != nil {
			p = *r.Passed
		}
		if r.Failed != nil {
			f = *r.Failed
		}
		counts = fmt.Sprintf(" %s/%s",
			okStyle.Render(fmt.Sprintf("%d✓", p)),
			errorStyle.Render(fmt.Sprintf("%d✗", f)),
		)
	}
	verdictText := "…"
	if r.Verdict != nil {
		verdictText = string(*r.Verdict)
	}
	when := relativeTime(r.At)
	return fmt.Sprintf("%s  %s  %s  %s  %s%s",
		st.Render(icon),
		labelStyle.Render(shortID),
		labelStyle.Render(mode),
		hintStyle.Render(when),
		st.Render(verdictText),
		counts,
	)
}

func runVerdictIcon(v *contract.RunRecordVerdict) string {
	if v == nil {
		return "○"
	}
	switch *v {
	case contract.RunRecordVerdictPass:
		return "✓"
	case contract.RunRecordVerdictFail:
		return "✗"
	case contract.RunRecordVerdictFlaky:
		return "~"
	case contract.RunRecordVerdictInvalid:
		return "⚠"
	case contract.RunRecordVerdictInfraError:
		return "⚡"
	case contract.RunRecordVerdictSkipped:
		return "→"
	default:
		return "?"
	}
}

func runVerdictStyle(v *contract.RunRecordVerdict) lipgloss.Style {
	if v == nil {
		return hintStyle
	}
	switch *v {
	case contract.RunRecordVerdictPass:
		return okStyle
	case contract.RunRecordVerdictFail:
		return errorStyle
	case contract.RunRecordVerdictFlaky:
		return shadowStyle
	default:
		return hintStyle
	}
}

func relativeTime(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// ── Messages ─────────────────────────────────────────────────────────────────

// historySelectedMsg: the user pressed 'h' on home → open the history screen.
type historySelectedMsg struct{ app string }

// watchRunMsg: the user picked a run from history → re-open it in the live screen.
type watchRunMsg struct {
	id  string
	app string
}

// runsLoadedMsg carries the result of ListRuns to the history screen.
type runsLoadedMsg struct{ runs []contract.RunRecord }

// listHistoryCmd fetches recent runs for an app (up to 30) and reports the
// result back as runsLoadedMsg or errMsg.
func listHistoryCmd(c *api.Client, app string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		runs, err := c.ListRuns(ctx, app, 30)
		if err != nil {
			return errMsg{err}
		}
		return runsLoadedMsg{runs: runs}
	}
}
