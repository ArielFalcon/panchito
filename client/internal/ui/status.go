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

// statusSelectedMsg: the user picked "Status" from the home menu.
type statusSelectedMsg struct{}

// statusModel is the at-a-glance control-plane view: the run queue (pending +
// currently running) and the configured projects as a table.
type statusModel struct {
	client  *api.Client
	queue   *contract.QueueStatus
	apps    []contract.AppView
	loading bool
	err     string
	width   int
}

func newStatusModel(client *api.Client) statusModel {
	return statusModel{client: client, loading: true}
}

func (m statusModel) Init() tea.Cmd { return loadStatusCmd(m.client) }

type statusLoadedMsg struct {
	queue contract.QueueStatus
	apps  []contract.AppView
}

func (m statusModel) Update(msg tea.Msg) (statusModel, tea.Cmd) {
	switch msg := msg.(type) {
	case statusLoadedMsg:
		m.loading = false
		q := msg.queue
		m.queue = &q
		m.apps = msg.apps
		m.err = ""
		return m, nil
	case errMsg:
		m.loading = false
		m.err = msg.err.Error()
		return m, nil
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return m, func() tea.Msg { return backMsg{} }
		case "r":
			if !m.loading {
				m.loading = true
				m.err = ""
				return m, loadStatusCmd(m.client)
			}
		}
	}
	return m, nil
}

func (m statusModel) View() string {
	w := contentWidth(m.width)
	var b strings.Builder

	switch {
	case m.loading:
		b.WriteString(accentRule(w, "status", "") + "\n\n")
		b.WriteString(infoStyle.Render("loading…") + "\n")
	case m.err != "":
		b.WriteString(accentRule(w, "status", "") + "\n\n")
		b.WriteString(errorStyle.Render("✗ "+m.err) + "\n")
		b.WriteString(hintStyle.Render("is the orchestrator running?  docker compose up") + "\n")
	default:
		q := m.queue
		qright := okStyle.Render("idle")
		if q.Running != nil {
			qright = renderSegs("", sg("● running ", colInfra), sg(q.Running.App+" ", colFg), sg(shortSha(q.Running.Id), colFaint))
		}
		if q.Pending > 0 {
			qright = renderSegs("", sg(fmt.Sprintf("%d pending", q.Pending), colFlaky), sg("  ·  ", colFaint)) + qright
		}
		b.WriteString(accentRule(w, "status", qright) + "\n\n")

		b.WriteString(labelRule(w, "projects", hintStyle.Render(pluralize(len(m.apps), "project", "projects"))) + "\n")
		for _, a := range m.apps {
			where := a.BaseUrl
			if a.Code {
				where = "code mode"
			}
			row := "  " + lipgloss.NewStyle().Foreground(colFg).Render(padRight(a.Name, 16)) + "  " + labelStyle.Render(padRight(a.Repo, 28)) + "  " + hintStyle.Render(where)
			if a.Shadow {
				row += "  " + shadowStyle.Render("(shadow)")
			}
			b.WriteString(row + "\n")
		}
		if len(m.apps) == 0 {
			b.WriteString(hintStyle.Render("  no projects configured") + "\n")
		}
	}

	b.WriteString("\n" + hintStyle.Render("r refresh · esc back"))
	return screenStyle.Render(b.String())
}

func loadStatusCmd(c *api.Client) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		q, err := c.Queue(ctx)
		if err != nil {
			return errMsg{err}
		}
		apps, err := c.ListApps(ctx)
		if err != nil {
			return errMsg{err}
		}
		return statusLoadedMsg{queue: q, apps: apps}
	}
}

// padRight pads s with spaces to n display runes (no-op if already wider).
func padRight(s string, n int) string {
	r := []rune(s)
	if len(r) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(r))
}
