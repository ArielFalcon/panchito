package ui

import (
	"fmt"
	"strings"

	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// homeModel lists the configured apps; Enter opens the launcher for one.
type homeModel struct {
	apps          []contract.AppView
	cursor        int
	serverVersion string // from the connect handshake; shown in the header when known
}

func newHomeModel(apps []contract.AppView) homeModel {
	return homeModel{apps: apps}
}

func (m homeModel) Update(msg tea.Msg) (homeModel, tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.apps)-1 {
				m.cursor++
			}
		case "enter":
			if len(m.apps) > 0 {
				app := m.apps[m.cursor].Name
				return m, func() tea.Msg { return appSelectedMsg{app: app} }
			}
		case "h":
			if len(m.apps) > 0 {
				app := m.apps[m.cursor].Name
				return m, func() tea.Msg { return historySelectedMsg{app: app} }
			}
		case "a":
			return m, func() tea.Msg { return agentSelectedMsg{} }
		case "o":
			return m, func() tea.Msg { return onboardSelectedMsg{} }
		case "e":
			if len(m.apps) > 0 {
				app := m.apps[m.cursor]
				return m, func() tea.Msg { return editAppMsg{app: app} }
			}
		case "d":
			if len(m.apps) > 0 {
				app := m.apps[m.cursor]
				return m, func() tea.Msg { return deleteAppMsg{app: app} }
			}
		}
	}
	return m, nil
}

func (m homeModel) View() string {
	var b strings.Builder
	header := titleStyle.Render("panchito") + "  " + hintStyle.Render(fmt.Sprintf("%d app(s)", len(m.apps)))
	if m.serverVersion != "" {
		header += "  " + hintStyle.Render("· server "+m.serverVersion)
	}
	b.WriteString(header + "\n\n")
	if len(m.apps) == 0 {
		b.WriteString(hintStyle.Render("no apps configured — press o to onboard one") + "\n")
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
	b.WriteString("\n" + hintStyle.Render("↑↓ move · enter launch · h history · o onboard · e edit · d delete · a agent · q quit"))
	return screenStyle.Render(b.String())
}
