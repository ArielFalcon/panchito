// Package ui is the Bubble Tea client: an Elm root Model that routes to per-screen
// sub-models (connect → home → launcher → live …). Control-plane events arrive as
// tea.Msgs over a channel; nothing here blocks the render loop.
package ui

import (
	"context"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/events"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type screen int

const (
	screenConnect screen = iota
	screenDashboard
	screenLauncher
	screenLive
	screenHistory
	screenAgent
	screenAppAdmin
	screenHelp
	screenSessions
	screenIntelligence
)

type Model struct {
	screen        screen
	client        *api.Client
	serverVersion string // from the connect handshake; shown in the persistent status bar
	width         int
	height        int
	connect       connectModel
	dashboard     dashboardModel
	launcher      launcherModel
	live          liveModel
	history       historyModel
	agent         agentModel
	appAdmin      appAdminModel
	help          helpModel
	sessions      sessionsModel
	intelligence  intelligenceModel

	// sys is the ambient control-plane snapshot the shell polls in the background;
	// the persistent status bar (and the dashboard) read from it.
	sys systemState
}

func New() Model {
	return Model{screen: screenConnect, connect: newConnectModel()}
}

func (m Model) Init() tea.Cmd { return m.connect.Init() }

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	// Window size is handled before the type switch so the persistent chrome can
	// reserve its rows and the focused screen receives the reduced height.
	if ws, ok := msg.(tea.WindowSizeMsg); ok {
		m.width, m.height = ws.Width, ws.Height
		ws.Height -= m.chromeHeight()
		if ws.Height < 1 {
			ws.Height = 1
		}
		msg = ws
	}
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			if m.screen == screenLive && m.live.cancel != nil {
				m.live.cancel()
			}
			return m, tea.Quit
		case "q":
			if (m.screen == screenDashboard && !m.dashboard.paletteActive) || m.screen == screenHistory {
				return m, tea.Quit
			}
		}
	case connectedMsg:
		m.client = msg.client
		m.serverVersion = msg.info.ServerVersion
		m.sys.apps = msg.apps
		m.dashboard = newDashboardModel(m.client)
		m.dashboard.width = m.width
		m.dashboard.sys = m.sys
		m.screen = screenDashboard
		// Start the ambient heartbeat and load the fleet history behind the board.
		return m, tea.Batch(pollSystemCmd(m.client), pollTick(), m.dashboard.Init())
	case pollTickMsg:
		if m.client == nil {
			return m, nil
		}
		return m, tea.Batch(pollSystemCmd(m.client), pollTick())
	case systemLoadedMsg:
		prevRun := runningID(m.sys.queue)
		m.sys = m.sys.fold(msg, time.Now())
		m.dashboard.sys = m.sys
		// Keep the fleet cursor in range if the app set shrank under us.
		if n := len(m.sys.apps); m.dashboard.cursor >= n {
			m.dashboard.cursor = max(0, n-1)
		}
		// When the active run changes (a run started or finished), refresh the fleet so
		// the board's verdicts and trends reflect the new outcome — only while it's shown.
		if m.screen == screenDashboard && runningID(m.sys.queue) != prevRun {
			return m, loadFleetCmd(m.client, appNames(m.sys.apps))
		}
		return m, nil
	case systemPollErrMsg:
		m.sys.lastErr = msg.err.Error()
		m.sys.lastPoll = time.Now()
		return m, nil
	case appSelectedMsg:
		m.launcher = newLauncherModel(msg.app)
		m.launcher.width = m.width
		m.screen = screenLauncher
		return m, nil
	case launchMsg:
		// Carry the app so runCreatedMsg labels the live screen — the launch may come
		// straight from the dashboard FLEET panel, not just the launcher wizard.
		m.launcher.app = msg.input.App
		return m, createRunCmd(m.client, msg.input)
	case runCreatedMsg:
		ch := make(chan events.RunEvent, 64)
		ctx, cancel := context.WithCancel(context.Background())
		m.live = newLiveModel(msg.id, m.launcher.app, ch, cancel, m.width, m.bodyHeight())
		m.live.client = m.client // enables the embedded assistant
		m.screen = screenLive
		return m, tea.Batch(startStreamCmd(ctx, m.client, msg.id, ch), waitForEventCmd(ch), m.live.spin.Tick)
	case continueMsg:
		return m, continueCmd(m.client, m.live.runID, msg.cases)
	case backMsg:
		m.screen = screenDashboard
		return m, nil
	case historySelectedMsg:
		m.history = newHistoryModel(m.client, msg.app)
		m.history.width = m.width
		m.screen = screenHistory
		return m, m.history.Init()
	case agentSelectedMsg:
		m.agent = newAgentModel(m.client)
		m.agent.width = m.width
		m.screen = screenAgent
		return m, m.agent.Init()
	case helpSelectedMsg:
		m.help = newHelpModel(m.client)
		if m.width > 0 && m.height > 0 {
			m.help.resize(m.width, m.bodyHeight())
		}
		m.screen = screenHelp
		return m, m.help.Init()
	case sessionsSelectedMsg:
		m.sessions = newSessionsModel(m.client)
		m.sessions.width = m.width
		m.screen = screenSessions
		return m, m.sessions.Init()
	case intelligenceSelectedMsg:
		m.intelligence = newIntelligenceModel(m.client, msg.app)
		if m.width > 0 && m.height > 0 {
			m.intelligence.resize(m.width, m.bodyHeight())
		}
		m.screen = screenIntelligence
		return m, m.intelligence.Init()
	case onboardSelectedMsg:
		m.appAdmin = newOnboardModel(m.client)
		m.appAdmin.width = m.width
		m.screen = screenAppAdmin
		return m, m.appAdmin.Init()
	case editAppMsg:
		m.appAdmin = newEditAppModel(m.client, msg.app)
		m.appAdmin.width = m.width
		m.screen = screenAppAdmin
		return m, m.appAdmin.Init()
	case deleteAppMsg:
		m.appAdmin = newDeleteAppModel(m.client, msg.app)
		m.appAdmin.width = m.width
		m.screen = screenAppAdmin
		return m, m.appAdmin.Init()
	case appsChangedMsg:
		m.sys.apps = msg.apps
		m.dashboard = newDashboardModel(m.client)
		m.dashboard.width = m.width
		m.dashboard.sys = m.sys
		m.dashboard.status = msg.status
		m.screen = screenDashboard
		return m, m.dashboard.Init()
	case watchRunMsg:
		ch := make(chan events.RunEvent, 64)
		ctx, cancel := context.WithCancel(context.Background())
		m.live = newLiveModel(msg.id, msg.app, ch, cancel, m.width, m.bodyHeight())
		m.live.client = m.client // enables the embedded assistant
		m.screen = screenLive
		return m, tea.Batch(startStreamCmd(ctx, m.client, msg.id, ch), waitForEventCmd(ch), m.live.spin.Tick)
	}

	var cmd tea.Cmd
	switch m.screen {
	case screenConnect:
		m.connect, cmd = m.connect.Update(msg)
	case screenDashboard:
		m.dashboard, cmd = m.dashboard.Update(msg)
	case screenLauncher:
		m.launcher, cmd = m.launcher.Update(msg)
	case screenLive:
		m.live, cmd = m.live.Update(msg)
	case screenHistory:
		m.history, cmd = m.history.Update(msg)
	case screenAgent:
		m.agent, cmd = m.agent.Update(msg)
	case screenAppAdmin:
		m.appAdmin, cmd = m.appAdmin.Update(msg)
	case screenHelp:
		m.help, cmd = m.help.Update(msg)
	case screenSessions:
		m.sessions, cmd = m.sessions.Update(msg)
	case screenIntelligence:
		m.intelligence, cmd = m.intelligence.Update(msg)
	}
	return m, cmd
}

// View composes the persistent shell — the always-present status bar — above the
// focused screen. Before the control plane is reached (connect screen) there is no
// ambient state to show, so the screen renders bare.
func (m Model) View() string {
	body := m.screenView()
	if m.client == nil {
		return body
	}
	bar := lipgloss.NewStyle().Padding(0, 2).Render(statusBar(contentWidth(m.width), m.serverVersion, m.sys, time.Now()))
	return bar + "\n" + body
}

// chromeHeight is the number of terminal rows the persistent shell reserves above the
// focused screen, so the screen can be handed a reduced height. Zero before connect.
func (m Model) chromeHeight() int {
	if m.client == nil {
		return 0
	}
	return 1 // status bar (one line)
}

// bodyHeight is the height left to the focused screen once the chrome is reserved.
func (m Model) bodyHeight() int {
	if h := m.height - m.chromeHeight(); h > 1 {
		return h
	}
	return 1
}

func (m Model) screenView() string {
	switch m.screen {
	case screenDashboard:
		return m.dashboard.View()
	case screenLauncher:
		return m.launcher.View()
	case screenLive:
		return m.live.View()
	case screenHistory:
		return m.history.View()
	case screenAgent:
		return m.agent.View()
	case screenAppAdmin:
		return m.appAdmin.View()
	case screenHelp:
		return m.help.View()
	case screenSessions:
		return m.sessions.View()
	case screenIntelligence:
		return m.intelligence.View()
	default:
		return m.connect.View()
	}
}
