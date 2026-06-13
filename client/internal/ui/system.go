package ui

import (
	"context"
	"errors"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

// pollInterval is the ambient heartbeat: how often the shell refreshes control-plane
// state in the background while connected. Short enough that the console feels live,
// long enough that three cheap GETs never strain the orchestrator.
const pollInterval = 3 * time.Second

var errNotConnected = errors.New("not connected")

// systemState is the ambient control-plane snapshot the persistent shell keeps fresh
// in the background, independent of the focused screen. It is what lets the console
// feel alive when idle: the status bar — and, later, the dashboard — read from it
// rather than each screen fetching on demand.
type systemState struct {
	queue    contract.QueueStatus
	running  *contract.RunRecord // the active run's record (step, counts), when one is running
	apps     []contract.AppView
	agent    contract.PublicAgentConfig
	loaded   bool   // at least one successful poll has landed
	lastErr  string // most recent poll error (surfaced subtly; never fatal)
	lastPoll time.Time
}

// runningID is the id of the active run, or "" when the queue is idle.
func runningID(q contract.QueueStatus) string {
	if q.Running == nil {
		return ""
	}
	return q.Running.Id
}

// fold applies a successful ambient poll to the state.
func (s systemState) fold(msg systemLoadedMsg, now time.Time) systemState {
	s.queue = msg.queue
	s.running = msg.running
	s.apps = msg.apps
	s.agent = msg.agent
	s.loaded = true
	s.lastErr = ""
	s.lastPoll = now
	return s
}

// ── Messages ─────────────────────────────────────────────────────────────────

// systemLoadedMsg carries one successful ambient poll back to the shell.
type systemLoadedMsg struct {
	queue   contract.QueueStatus
	running *contract.RunRecord
	apps    []contract.AppView
	agent   contract.PublicAgentConfig
}

// systemPollErrMsg carries a failed ambient poll. It is deliberately non-fatal: the
// shell keeps its last good snapshot and only notes the error, so a transient blip
// never blanks the console.
type systemPollErrMsg struct{ err error }

// pollTickMsg fires on the ambient heartbeat; the shell answers by polling again.
type pollTickMsg struct{}

// pollTick schedules the next ambient heartbeat.
func pollTick() tea.Cmd {
	return tea.Tick(pollInterval, func(time.Time) tea.Msg { return pollTickMsg{} })
}

// pollSystemCmd fetches the ambient snapshot — queue, apps and agent runtime — under a
// short deadline. These three are cheap, always-available control-plane reads; per-app
// run history (for the dashboard's fleet sparklines) is fetched separately so a slow
// history query never delays the heartbeat.
func pollSystemCmd(c *api.Client) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return systemPollErrMsg{err: errNotConnected}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		q, err := c.Queue(ctx)
		if err != nil {
			return systemPollErrMsg{err: err}
		}
		// When a run is in flight, fetch its record so the dashboard can show its step
		// and progress. A failure here is non-fatal — the queue summary still stands.
		var running *contract.RunRecord
		if q.Running != nil {
			if rec, rerr := c.GetRun(ctx, q.Running.Id); rerr == nil {
				running = &rec
			}
		}
		apps, err := c.ListApps(ctx)
		if err != nil {
			return systemPollErrMsg{err: err}
		}
		agent, err := c.GetAgentConfig(ctx)
		if err != nil {
			return systemPollErrMsg{err: err}
		}
		return systemLoadedMsg{queue: q, running: running, apps: apps, agent: agent}
	}
}
