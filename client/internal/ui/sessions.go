package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

// sessionsSelectedMsg: the user picked "Active sessions" from the home menu.
type sessionsSelectedMsg struct{}

// sessionsModel lists the active run (the queue is sequential, so at most one runs
// at a time) plus the pending count, and lets the user RESUME it (re-attach the live
// view) or STOP it. This is the recovery path: detaching with esc or quitting the
// client leaves the server-side run going — here you can find it again and cancel it.
type sessionsModel struct {
	client  *api.Client
	queue   *contract.QueueStatus
	loading bool
	err     string
	status  string
	width   int
}

func newSessionsModel(client *api.Client) sessionsModel {
	return sessionsModel{client: client, loading: true}
}

func (m sessionsModel) Init() tea.Cmd { return loadQueueCmd(m.client) }

type queueLoadedMsg struct{ queue contract.QueueStatus }
type runCanceledMsg struct{}

func (m sessionsModel) Update(msg tea.Msg) (sessionsModel, tea.Cmd) {
	switch msg := msg.(type) {
	case queueLoadedMsg:
		m.loading = false
		q := msg.queue
		m.queue = &q
		m.err = ""
		return m, nil
	case runCanceledMsg:
		m.status = "stop requested — the run will wind down"
		return m, loadQueueCmd(m.client)
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
				return m, loadQueueCmd(m.client)
			}
		case "enter":
			if r := m.running(); r != nil {
				return m, func() tea.Msg { return watchRunMsg{id: r.Id, app: r.App} }
			}
		case "x":
			if r := m.running(); r != nil {
				m.status = ""
				return m, cancelRunCmd(m.client, r.Id)
			}
		}
	}
	return m, nil
}

func (m sessionsModel) running() *struct {
	App string `json:"app"`
	Id  string `json:"id"`
} {
	if m.queue == nil {
		return nil
	}
	return m.queue.Running
}

func (m sessionsModel) View() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(accentRule(w, "active sessions", "") + "\n\n")

	switch {
	case m.loading:
		b.WriteString(infoStyle.Render("loading…") + "\n")
	case m.err != "":
		b.WriteString(errorStyle.Render("✗ "+m.err) + "\n")
	case m.running() != nil:
		r := m.running()
		left := renderSegs("", sg("▌▸ ", colEmber), sg("● running  ", colInfra), sgb(r.App, colFg))
		b.WriteString(spread(w, left, hintStyle.Render(shortSha(r.Id))) + "\n")
		if m.queue.Pending > 0 {
			b.WriteString("\n" + hintStyle.Render(fmt.Sprintf("  %d more queued behind it", m.queue.Pending)) + "\n")
		}
		b.WriteString("\n" + hintStyle.Render("enter resume (re-attach the live view) · x stop the run") + "\n")
	default:
		b.WriteString(hintStyle.Render("no active runs") + "\n")
		if m.queue != nil && m.queue.Pending > 0 {
			b.WriteString(hintStyle.Render(fmt.Sprintf("%d queued", m.queue.Pending)) + "\n")
		}
	}

	if m.status != "" {
		b.WriteString("\n" + okStyle.Render("✓ "+m.status))
	}
	b.WriteString("\n" + hintStyle.Render("r refresh · esc back"))
	return screenStyle.Render(b.String())
}

func loadQueueCmd(c *api.Client) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		q, err := c.Queue(ctx)
		if err != nil {
			return errMsg{err}
		}
		return queueLoadedMsg{queue: q}
	}
}

func cancelRunCmd(c *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := c.Cancel(ctx, id); err != nil {
			return errMsg{err}
		}
		return runCanceledMsg{}
	}
}
