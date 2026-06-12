package ui

import (
	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
)

// ── Navigation / lifecycle messages (sub-model → root) ────────────────────────

// connectedMsg: the connect screen reached the control plane.
type connectedMsg struct {
	client *api.Client
	apps   []contract.AppView
}

// appSelectedMsg: the user picked an app on home → open the launcher.
type appSelectedMsg struct{ app string }

// launchMsg: the launcher assembled a run request → the root issues CreateRun.
type launchMsg struct{ input contract.CreateRunInput }

// runCreatedMsg: CreateRun succeeded → open the live screen for this run.
type runCreatedMsg struct{ id string }

// backMsg: pop back to home.
type backMsg struct{}

// errMsg carries a command failure to the active screen for display.
type errMsg struct{ err error }

// ── Live stream messages (SSE goroutine → main loop, via a channel) ───────────

// runEventMsg is one decoded RunEvent crossing from the stream goroutine to the
// Bubble Tea loop. The goroutine only writes to the channel; the model is mutated
// solely in Update (so there is no shared-state race — review note #7).
type runEventMsg events.RunEvent

// streamClosedMsg: the run finished (or the stream gave up).
type streamClosedMsg struct{ err error }
