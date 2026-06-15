package ui

import (
	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/auth"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/ArielFalcon/panchito/internal/events"
)

// ── Navigation / lifecycle messages (sub-model → root) ────────────────────────

// connectedMsg: the connect screen reached the control plane (after a successful
// version/capability handshake).
type connectedMsg struct {
	client *api.Client
	apps   []contract.AppView
	info   contract.VersionInfo
}

// appSelectedMsg: the user picked an app on home → open the launcher.
type appSelectedMsg struct{ app string }

// launchMsg: the launcher assembled a run request → the root issues CreateRun.
type launchMsg struct{ input contract.CreateRunInput }

// runCreatedMsg: CreateRun succeeded → open the live screen for this run.
type runCreatedMsg struct{ id string }

// continueMsg: re-run the named failed cases as a continuation.
type continueMsg struct{ cases []string }

// backMsg: pop back to home.
type backMsg struct{}

// errMsg carries a command failure to the active screen for display.
type errMsg struct{ err error }

// savedLoadedMsg carries the connection the screen should start from: the host plus a token
// resolved from the keyring or auto-discovered (env / config/.api_token), with a short source
// label for the UI. Any field may be empty.
type savedLoadedMsg struct{ host, token, source string }

// ── GitHub device-flow login (connect screen) ─────────────────────────────────

// deviceCodeMsg: GitHub issued a device + user code; show it and start polling. clientID is the
// OAuth client id resolved for this login (carried so polling uses the same one).
type deviceCodeMsg struct {
	code     auth.DeviceCode
	clientID string
}

// devicePollTickMsg: the inter-poll wait elapsed — time to poll GitHub once more.
type devicePollTickMsg struct{}

// devicePollMsg: the result of one token-poll attempt (pending / slow_down / done / denied / expired).
type devicePollMsg struct{ result auth.PollResult }

// loginExchangedMsg: the orchestrator accepted the GitHub token and minted a session — the
// connect screen now probes the control plane with it (handshake + apps) to finish signing in.
type loginExchangedMsg struct{ session contract.LoginResponse }

// ── Live stream messages (SSE goroutine → main loop, via a channel) ───────────

// runEventMsg is one decoded RunEvent crossing from the stream goroutine to the
// Bubble Tea loop. The goroutine only writes to the channel; the model is mutated
// solely in Update (so there is no shared-state race — review note #7).
type runEventMsg events.RunEvent

// streamClosedMsg: the run finished (or the stream gave up).
type streamClosedMsg struct{ err error }
