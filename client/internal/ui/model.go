// Package ui is the Bubble Tea client: an Elm root Model that routes to per-screen
// sub-models (connect → home → launcher → live …). Control-plane events arrive as
// tea.Msgs over a channel; nothing here blocks the render loop.
package ui

import (
	"context"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/events"
	tea "github.com/charmbracelet/bubbletea"
)

type screen int

const (
	screenConnect screen = iota
	screenHome
	screenLauncher
	screenLive
)

type Model struct {
	screen   screen
	client   *api.Client
	connect  connectModel
	home     homeModel
	launcher launcherModel
	live     liveModel
}

func New() Model {
	return Model{screen: screenConnect, connect: newConnectModel()}
}

func (m Model) Init() tea.Cmd { return m.connect.Init() }

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			if m.screen == screenLive && m.live.cancel != nil {
				m.live.cancel()
			}
			return m, tea.Quit
		case "q":
			if m.screen == screenHome {
				return m, tea.Quit
			}
		}
	case connectedMsg:
		m.client = msg.client
		m.home = newHomeModel(msg.apps)
		m.screen = screenHome
		return m, nil
	case appSelectedMsg:
		m.launcher = newLauncherModel(msg.app)
		m.screen = screenLauncher
		return m, nil
	case launchMsg:
		return m, createRunCmd(m.client, msg.input)
	case runCreatedMsg:
		ch := make(chan events.RunEvent, 64)
		ctx, cancel := context.WithCancel(context.Background())
		m.live = newLiveModel(msg.id, m.launcher.app, ch, cancel)
		m.screen = screenLive
		return m, tea.Batch(startStreamCmd(ctx, m.client, msg.id, ch), waitForEventCmd(ch))
	case backMsg:
		m.screen = screenHome
		return m, nil
	}

	var cmd tea.Cmd
	switch m.screen {
	case screenConnect:
		m.connect, cmd = m.connect.Update(msg)
	case screenHome:
		m.home, cmd = m.home.Update(msg)
	case screenLauncher:
		m.launcher, cmd = m.launcher.Update(msg)
	case screenLive:
		m.live, cmd = m.live.Update(msg)
	}
	return m, cmd
}

func (m Model) View() string {
	switch m.screen {
	case screenHome:
		return m.home.View()
	case screenLauncher:
		return m.launcher.View()
	case screenLive:
		return m.live.View()
	default:
		return m.connect.View()
	}
}
