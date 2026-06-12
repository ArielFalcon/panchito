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
	screenChat
	screenHistory
	screenAgent
	screenAppAdmin
	screenStatus
	screenHelp
)

type Model struct {
	screen        screen
	client        *api.Client
	serverVersion string // from the connect handshake; carried to re-rendered home screens
	width         int
	height        int
	connect       connectModel
	home          homeModel
	launcher      launcherModel
	live          liveModel
	chat          chatModel
	history       historyModel
	agent         agentModel
	appAdmin      appAdminModel
	status        statusModel
	help          helpModel
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
			if m.screen == screenHome || m.screen == screenHistory {
				return m, tea.Quit
			}
		}
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case connectedMsg:
		m.client = msg.client
		m.serverVersion = msg.info.ServerVersion
		m.home = newHomeModel(msg.apps)
		m.home.serverVersion = m.serverVersion
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
		m.live = newLiveModel(msg.id, m.launcher.app, ch, cancel, m.width, m.height)
		m.screen = screenLive
		return m, tea.Batch(startStreamCmd(ctx, m.client, msg.id, ch), waitForEventCmd(ch), m.live.spin.Tick)
	case askMsg:
		m.chat = newChatModel(m.client, m.live.runID)
		m.screen = screenChat
		return m, m.chat.Init()
	case continueMsg:
		return m, continueCmd(m.client, m.live.runID, msg.cases)
	case backMsg:
		m.screen = screenHome
		return m, nil
	case historySelectedMsg:
		m.history = newHistoryModel(m.client, msg.app)
		m.screen = screenHistory
		return m, m.history.Init()
	case agentSelectedMsg:
		m.agent = newAgentModel(m.client)
		m.screen = screenAgent
		return m, m.agent.Init()
	case statusSelectedMsg:
		m.status = newStatusModel(m.client)
		m.screen = screenStatus
		return m, m.status.Init()
	case helpSelectedMsg:
		m.help = newHelpModel(m.client)
		m.screen = screenHelp
		return m, m.help.Init()
	case onboardSelectedMsg:
		m.appAdmin = newOnboardModel(m.client)
		m.screen = screenAppAdmin
		return m, m.appAdmin.Init()
	case editAppMsg:
		m.appAdmin = newEditAppModel(m.client, msg.app)
		m.screen = screenAppAdmin
		return m, m.appAdmin.Init()
	case deleteAppMsg:
		m.appAdmin = newDeleteAppModel(m.client, msg.app)
		m.screen = screenAppAdmin
		return m, m.appAdmin.Init()
	case appsChangedMsg:
		m.home = newHomeModel(msg.apps)
		m.home.serverVersion = m.serverVersion
		m.home.status = msg.status
		m.screen = screenHome
		return m, nil
	case watchRunMsg:
		ch := make(chan events.RunEvent, 64)
		ctx, cancel := context.WithCancel(context.Background())
		m.live = newLiveModel(msg.id, msg.app, ch, cancel, m.width, m.height)
		m.screen = screenLive
		return m, tea.Batch(startStreamCmd(ctx, m.client, msg.id, ch), waitForEventCmd(ch), m.live.spin.Tick)
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
	case screenChat:
		m.chat, cmd = m.chat.Update(msg)
	case screenHistory:
		m.history, cmd = m.history.Update(msg)
	case screenAgent:
		m.agent, cmd = m.agent.Update(msg)
	case screenAppAdmin:
		m.appAdmin, cmd = m.appAdmin.Update(msg)
	case screenStatus:
		m.status, cmd = m.status.Update(msg)
	case screenHelp:
		m.help, cmd = m.help.Update(msg)
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
	case screenChat:
		return m.chat.View()
	case screenHistory:
		return m.history.View()
	case screenAgent:
		return m.agent.View()
	case screenAppAdmin:
		return m.appAdmin.View()
	case screenStatus:
		return m.status.View()
	case screenHelp:
		return m.help.View()
	default:
		return m.connect.View()
	}
}
