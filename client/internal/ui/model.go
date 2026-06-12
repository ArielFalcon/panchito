// Package ui is the Bubble Tea client: an Elm root Model that routes to per-screen
// sub-models (connect, home, … launcher/live/summary/chat to come). Events from the
// control plane arrive as tea.Msgs; nothing here blocks the render loop.
package ui

import tea "github.com/charmbracelet/bubbletea"

type screen int

const (
	screenConnect screen = iota
	screenHome
)

type Model struct {
	screen  screen
	connect connectModel
	home    homeModel
}

func New() Model {
	return Model{screen: screenConnect, connect: newConnectModel()}
}

func (m Model) Init() tea.Cmd { return m.connect.Init() }

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	// Global keys. `q` quits only outside text-entry screens (so typing it into the
	// connect inputs is just a character); ctrl+c always quits.
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "q":
			if m.screen == screenHome {
				return m, tea.Quit
			}
		}
	}

	if c, ok := msg.(connectedMsg); ok {
		m.screen = screenHome
		m.home = newHomeModel(c.client, c.apps)
		return m, nil
	}

	var cmd tea.Cmd
	switch m.screen {
	case screenConnect:
		m.connect, cmd = m.connect.Update(msg)
	case screenHome:
		m.home, cmd = m.home.Update(msg)
	}
	return m, cmd
}

func (m Model) View() string {
	switch m.screen {
	case screenHome:
		return m.home.View()
	default:
		return m.connect.View()
	}
}
