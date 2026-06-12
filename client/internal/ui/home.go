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

type menuItem struct{ icon, label, action string }

var homeMenuItems = []menuItem{
	{"▶", "Run QA", "run"},
	{"✚", "Onboard project", "onboard"},
	{"✎", "Edit project", "edit"},
	{"✖", "Delete project", "delete"},
	{"◈", "Agent runtime", "agent"},
	{"⊞", "Status", "status"},
	{"?", "Help", "help"},
	{"⎋", "Quit", "quit"},
}

type homeModel struct {
	apps          []contract.AppView
	view          homeView
	menuCursor    int
	cursor        int    // app cursor in the projects sub-view
	intent        string // run | edit | delete — what Enter does in the projects view
	serverVersion string // from the connect handshake; shown in the header when known
	status        string // success line after onboarding/edit/delete (set by the root)
}

func newHomeModel(apps []contract.AppView) homeModel {
	return homeModel{apps: apps, view: homeViewMenu}
}

func (m homeModel) Update(msg tea.Msg) (homeModel, tea.Cmd) {
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

func bannerBox() string {
	inner := titleStyle.Render("◇  panchito") + "\n" + hintStyle.Render("Autonomous E2E QA for every deploy")
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colAccent).
		Padding(0, 4).
		Render(inner)
}

func (m homeModel) View() string {
	if m.view == homeViewProjects {
		return m.viewProjects()
	}
	return m.viewMenu()
}

func (m homeModel) viewMenu() string {
	var b strings.Builder
	b.WriteString(bannerBox() + "\n\n")

	meta := hintStyle.Render(pluralize(len(m.apps), "project", "projects"))
	if m.serverVersion != "" {
		meta += hintStyle.Render("  ·  server " + m.serverVersion)
	}
	b.WriteString(meta + "\n\n")

	for i, it := range homeMenuItems {
		if i == m.menuCursor {
			b.WriteString(okStyle.Render("▸ ") + lipgloss.NewStyle().Bold(true).Render(it.icon+"  "+it.label) + "\n")
		} else {
			b.WriteString("  " + labelStyle.Render(it.icon) + "  " + it.label + "\n")
		}
	}

	if m.status != "" {
		b.WriteString("\n" + okStyle.Render("✓ "+m.status))
	}
	b.WriteString("\n" + hintStyle.Render("↑↓ move · enter select · q quit"))
	return screenStyle.Render(b.String())
}

func (m homeModel) viewProjects() string {
	var b strings.Builder
	verb := map[string]string{"run": "run", "edit": "edit", "delete": "delete"}[m.intent]
	b.WriteString(titleStyle.Render("select a project to "+verb) + "\n\n")

	if len(m.apps) == 0 {
		b.WriteString(hintStyle.Render("no projects configured — go back and pick Onboard project") + "\n")
		b.WriteString("\n" + hintStyle.Render("esc back"))
		return screenStyle.Render(b.String())
	}

	for i, a := range m.apps {
		marker := "  "
		name := a.Name
		if i == m.cursor {
			marker = okStyle.Render("▸ ")
			name = lipgloss.NewStyle().Bold(true).Render(name)
		}
		where := a.BaseUrl
		if a.Code {
			where = "code mode"
		}
		line := marker + name + "  " + labelStyle.Render(where)
		if a.Shadow {
			line += "  " + shadowStyle.Render("(shadow)")
		}
		b.WriteString(line + "\n")
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
