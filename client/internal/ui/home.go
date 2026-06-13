package ui

import (
	"fmt"
	"strings"

	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// homeModel is the dashboard hub: a branded banner + a menu of every feature
// (run, onboard, edit, delete, agent runtime, status, help). "Run QA", "Edit" and
// "Delete" drop into a projects sub-view to pick the app; the rest emit a message
// the root routes to a dedicated screen.
type homeView int

const (
	homeViewMenu homeView = iota
	homeViewProjects
)

type menuItem struct{ icon, label, action, hint string }

var homeMenuItems = []menuItem{
	{"▶", "Run QA", "run", "run the pipeline on a project"},
	{"◳", "Active sessions", "sessions", "resume or stop a live run"},
	{"✚", "Onboard project", "onboard", "add a repo via one yaml"},
	{"✎", "Edit project", "edit", ""},
	{"✖", "Delete project", "delete", ""},
	{"◈", "Agent runtime", "agent", "providers · models · keys"},
	{"⊞", "Status", "status", "queue · projects"},
	{"?", "Help", "help", ""},
	{"⎋", "Quit", "quit", ""},
}

type homeModel struct {
	apps          []contract.AppView
	view          homeView
	menuCursor    int
	cursor        int    // app cursor in the projects sub-view
	intent        string // run | edit | delete — what Enter does in the projects view
	serverVersion string // from the connect handshake; shown in the header when known
	status        string // success line after onboarding/edit/delete (set by the root)
	width         int    // terminal width, for the grid (0 → default via contentWidth)
}

func newHomeModel(apps []contract.AppView) homeModel {
	return homeModel{apps: apps, view: homeViewMenu}
}

func (m homeModel) Update(msg tea.Msg) (homeModel, tea.Cmd) {
	if ws, ok := msg.(tea.WindowSizeMsg); ok {
		m.width = ws.Width
		return m, nil
	}
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return m, nil
	}
	if m.view == homeViewProjects {
		return m.updateProjects(k)
	}
	return m.updateMenu(k)
}

func (m homeModel) updateMenu(k tea.KeyMsg) (homeModel, tea.Cmd) {
	switch k.String() {
	case "up", "k":
		if m.menuCursor > 0 {
			m.menuCursor--
		}
	case "down", "j":
		if m.menuCursor < len(homeMenuItems)-1 {
			m.menuCursor++
		}
	case "enter":
		return m.trigger(homeMenuItems[m.menuCursor].action)
	}
	return m, nil
}

func (m homeModel) trigger(action string) (homeModel, tea.Cmd) {
	switch action {
	case "run", "edit", "delete":
		m.intent = action
		m.cursor = 0
		m.status = ""
		m.view = homeViewProjects
		return m, nil
	case "onboard":
		return m, func() tea.Msg { return onboardSelectedMsg{} }
	case "agent":
		return m, func() tea.Msg { return agentSelectedMsg{} }
	case "sessions":
		return m, func() tea.Msg { return sessionsSelectedMsg{} }
	case "status":
		return m, func() tea.Msg { return statusSelectedMsg{} }
	case "help":
		return m, func() tea.Msg { return helpSelectedMsg{} }
	case "quit":
		return m, tea.Quit
	}
	return m, nil
}

func (m homeModel) updateProjects(k tea.KeyMsg) (homeModel, tea.Cmd) {
	switch k.String() {
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.apps)-1 {
			m.cursor++
		}
	case "esc":
		m.view = homeViewMenu
		return m, nil
	case "enter":
		if len(m.apps) == 0 {
			return m, nil
		}
		app := m.apps[m.cursor]
		switch m.intent {
		case "edit":
			return m, func() tea.Msg { return editAppMsg{app: app} }
		case "delete":
			return m, func() tea.Msg { return deleteAppMsg{app: app} }
		default:
			return m, func() tea.Msg { return appSelectedMsg{app: app.Name} }
		}
	case "h":
		if len(m.apps) > 0 {
			return m, func() tea.Msg { return historySelectedMsg{app: m.apps[m.cursor].Name} }
		}
	case "e":
		if len(m.apps) > 0 {
			return m, func() tea.Msg { return editAppMsg{app: m.apps[m.cursor]} }
		}
	case "d":
		if len(m.apps) > 0 {
			return m, func() tea.Msg { return deleteAppMsg{app: m.apps[m.cursor]} }
		}
	}
	return m, nil
}

// bannerBox is the single boxed element on the dashboard: an ember rounded box with the
// brand mark and tagline. Width is clamped so it never outgrows a narrow terminal.
func bannerBox(width int) string {
	bw := min(48, width)
	inner := renderSegs("", sg("◆ ", colEmber), sgb("panchito", colFg)) + "\n" +
		labelStyle.Render("autonomous e2e qa for every deploy")
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colEmber).
		Padding(0, 2).
		Width(bw).
		Render(inner)
}

func (m homeModel) View() string {
	if m.view == homeViewProjects {
		return m.viewProjects()
	}
	return m.viewMenu()
}

func (m homeModel) viewMenu() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(bannerBox(w) + "\n\n")

	meta := renderSegs("", sg(pluralize(len(m.apps), "project", "projects"), colDim))
	if m.serverVersion != "" {
		meta += renderSegs("", sg("  ·  ", colFaint), sg("server ", colDim), sg(m.serverVersion, colFg))
	}
	b.WriteString(meta + "\n\n")

	b.WriteString(labelRule(w, "menu", hintStyle.Render("↑↓ move  ⏎ select")) + "\n\n")

	for i, it := range homeMenuItems {
		if i == m.menuCursor {
			b.WriteString(selectedRow(w, it.icon, it.label, it.hint) + "\n")
		} else {
			b.WriteString(normalRow(w, it.icon, it.label, it.hint) + "\n")
		}
	}

	if m.status != "" {
		b.WriteString("\n" + okStyle.Render("✓ "+m.status))
	}
	b.WriteString("\n" + hintStyle.Render("↑↓ move · enter select · q quit"))
	return screenStyle.Render(b.String())
}

func (m homeModel) viewProjects() string {
	w := contentWidth(m.width)
	var b strings.Builder
	verb := map[string]string{"run": "run", "edit": "edit", "delete": "delete"}[m.intent]
	b.WriteString(accentRule(w, "select a project to "+verb, hintStyle.Render(pluralize(len(m.apps), "project", "projects"))) + "\n\n")

	if len(m.apps) == 0 {
		b.WriteString(hintStyle.Render("no projects configured — go back and pick Onboard project") + "\n")
		b.WriteString("\n" + hintStyle.Render("esc back"))
		return screenStyle.Render(b.String())
	}

	for i, a := range m.apps {
		where := a.BaseUrl
		if a.Code {
			where = "code mode"
		}
		if a.Shadow {
			where += "  (shadow)"
		}
		if i == m.cursor {
			b.WriteString(selectedRow(w, "", a.Name, where) + "\n")
		} else {
			b.WriteString(normalRow(w, "", a.Name, where) + "\n")
		}
	}
	b.WriteString("\n" + hintStyle.Render("↑↓ move · enter "+verb+" · h history · e edit · d delete · esc back"))
	return screenStyle.Render(b.String())
}

func pluralize(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}
