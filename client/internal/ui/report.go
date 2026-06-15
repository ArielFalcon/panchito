package ui

// report.go is the dedicated report screen: the TWO analyses the backend ships for a finished run —
// `current` (what this execution did: verdict, case mix, this run's change-coverage/value/duration)
// and `evolution` (the app's period-over-period trends as they stood at that run, present only once
// there is history to compare). Both are the same self-describing ReportView, drawn by charts.go.
// It is opened from the live recap ('r') with the view already preloaded, so it normally makes no
// fetch; the self-fetch path is the documented fallback for opening without a preloaded view.

import (
	"context"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// reportSelectedMsg opens the report screen for a finished run. `preloaded` carries the view when
// the caller already has it (the live summary), so no second fetch is made; nil ⇒ the screen fetches.
type reportSelectedMsg struct {
	runID     string
	app       string
	preloaded *contract.RunReportView
}

// reportBackMsg pops the report screen back to the live recap it was opened from, rather than to the
// dashboard — so esc never strands the user away from the post-run recap.
type reportBackMsg struct{}

// runReportLoadedMsg carries a fetched run report (or its error) back to whichever screen asked —
// the report screen, or the live screen that loads it to show the summary top-K.
type runReportLoadedMsg struct {
	runID string
	view  contract.RunReportView
	err   error
}

type reportModel struct {
	client  *api.Client
	runID   string
	app     string
	view    *contract.RunReportView
	loading bool
	err     string
	tab     int // 0 = current (this execution), 1 = evolution (historical trends)
	width   int
	height  int
	vp      viewport.Model
	ready   bool
}

func newReportModel(client *api.Client, runID, app string, preloaded *contract.RunReportView) reportModel {
	m := reportModel{client: client, runID: runID, app: app}
	if preloaded != nil {
		m.view = preloaded
	} else {
		m.loading = true
	}
	return m
}

func (m reportModel) Init() tea.Cmd {
	if m.view != nil {
		return nil
	}
	return loadRunReportCmd(m.client, m.runID)
}

func loadRunReportCmd(c *api.Client, runID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		v, err := c.GetRunReport(ctx, runID)
		return runReportLoadedMsg{runID: runID, view: v, err: err}
	}
}

// hasEvolution reports whether the evolution analysis is available for this run.
func (m reportModel) hasEvolution() bool {
	return m.view != nil && m.view.Evolution != nil
}

func (m reportModel) Update(msg tea.Msg) (reportModel, tea.Cmd) {
	switch msg := msg.(type) {
	case runReportLoadedMsg:
		if msg.runID != m.runID {
			return m, nil // a stale load for a different run
		}
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		v := msg.view
		m.view = &v
		m.err = ""
		m.refresh()
		return m, nil
	case tea.WindowSizeMsg:
		m.resize(msg.Width, msg.Height)
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return m, func() tea.Msg { return reportBackMsg{} }
		case "left", "h", "right", "l", "tab", "shift+tab":
			if m.hasEvolution() {
				m.tab = 1 - m.tab
				m.refresh()
				m.vp.GotoTop()
			}
			return m, nil
		case "r":
			if !m.loading && m.client != nil {
				m.loading = true
				m.err = ""
				return m, loadRunReportCmd(m.client, m.runID)
			}
		case "up", "k", "down", "j", "pgup", "pgdown":
			if m.ready {
				var cmd tea.Cmd
				m.vp, cmd = m.vp.Update(msg)
				return m, cmd
			}
		}
	}
	return m, nil
}

func (m *reportModel) resize(w, h int) {
	m.width, m.height = w, h
	// header (rule + tab bar + blank) + footer (blank + line) + screen padding.
	vpH := h - 7
	if vpH < 3 {
		vpH = 3
	}
	if !m.ready {
		m.vp = viewport.New(contentWidth(w), vpH)
		m.ready = true
	} else {
		m.vp.Width, m.vp.Height = contentWidth(w), vpH
	}
	m.refresh()
}

func (m *reportModel) refresh() {
	if m.ready {
		m.vp.SetContent(m.body())
	}
}

// activeView is the ReportView for the focused tab — evolution when selected and present, else the
// current-execution report.
func (m reportModel) activeView() *contract.ReportView {
	if m.view == nil {
		return nil
	}
	if m.tab == 1 && m.view.Evolution != nil {
		return m.view.Evolution
	}
	return &m.view.Current
}

func (m reportModel) View() string {
	w := contentWidth(m.width)
	header := accentRule(w, "report", labelStyle.Render(m.app)+hintStyle.Render(" · "+shortRunID(m.runID)))
	tabs := m.tabBar()
	var body string
	switch {
	case m.loading:
		body = infoStyle.Render("loading…")
	case m.err != "":
		body = errorStyle.Render("✗ " + m.err)
	case m.ready:
		body = m.vp.View()
	default:
		body = m.body()
	}
	footer := "↑↓ scroll"
	if m.hasEvolution() {
		footer += " · ←→ current/evolution"
	}
	footer += " · esc back"
	return screenStyle.Render(header + "\n" + tabs + "\n\n" + body + "\n\n" + hintStyle.Render(footer))
}

// tabBar shows the two analyses; the evolution tab appears greyed-as-unavailable until there is
// enough history, so the user always learns both analyses exist.
func (m reportModel) tabBar() string {
	cur := tab("this execution", m.tab == 0)
	var evo string
	if m.hasEvolution() {
		evo = tab("evolution", m.tab == 1)
	} else {
		evo = hintStyle.Render("evolution — not enough history yet")
	}
	return cur + hintStyle.Render("   ·   ") + evo
}

func tab(label string, active bool) string {
	if active {
		return lipgloss.NewStyle().Bold(true).Foreground(colEmber).Render("▸ " + label)
	}
	return labelStyle.Render("  " + label)
}

func (m reportModel) body() string {
	w := contentWidth(m.width)
	v := m.activeView()
	if v == nil {
		return hintStyle.Render("no report for this run")
	}
	return strings.TrimRight(renderReportDetail(*v, w), "\n")
}
