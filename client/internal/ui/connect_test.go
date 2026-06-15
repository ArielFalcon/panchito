package ui

import (
	"errors"
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/auth"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

// A 404 on the HANDSHAKE means the host answered but is not a panchito control plane — the
// classic "pointed at the app's port, not the orchestrator".
func TestDiagnoseHandshake404IsWrongServer(t *testing.T) {
	got := diagnoseConnectError("localhost:8080", &api.APIError{Status: 404, Msg: "Not Found"}, true)
	low := strings.ToLower(got)
	if !strings.Contains(low, "not a panchito") {
		t.Fatalf("a handshake 404 should say it is not a panchito control plane; got %q", got)
	}
	if !strings.Contains(low, "port") {
		t.Fatalf("a handshake 404 should hint at the host/port; got %q", got)
	}
	if !strings.Contains(got, "/api/v1/version") {
		t.Fatalf("the diagnosis must cite the path the client actually requested (/api/v1/version); got %q", got)
	}
}

// A 404 AFTER a successful handshake is NOT "wrong server" — the handshake already proved the
// server is panchito; saying "not a panchito control plane" here would misdirect the operator.
func TestDiagnoseProbe404IsNotWrongServer(t *testing.T) {
	got := diagnoseConnectError("localhost:8088", &api.APIError{Status: 404, Msg: "Not Found"}, false)
	if strings.Contains(strings.ToLower(got), "not a panchito") {
		t.Fatalf("a post-handshake 404 must NOT claim the server is not panchito; got %q", got)
	}
}

func TestDiagnose401IsAuth(t *testing.T) {
	got := diagnoseConnectError("h", &api.APIError{Status: 401, Msg: "unauthorized"}, false)
	if !strings.Contains(strings.ToLower(got), "auth") {
		t.Fatalf("401 should explain an auth failure; got %q", got)
	}
}

func TestDiagnoseTransportIsUnreachable(t *testing.T) {
	got := diagnoseConnectError("h", errors.New("dial tcp 127.0.0.1:8088: connect: connection refused"), true)
	low := strings.ToLower(got)
	if !strings.Contains(low, "reach") || !strings.Contains(low, "running") {
		t.Fatalf("a transport error should say the host is unreachable / orchestrator may be down; got %q", got)
	}
}

// A resolved (auto-discovered or saved) token for the current host auto-connects and records
// where it came from for the UI.
func TestConnectSavedTokenAutoConnects(t *testing.T) {
	m := newConnectModel() // host defaults to localhost:8080

	m, cmd := m.Update(savedLoadedMsg{host: "localhost:8080", token: "secret", source: "config/.api_token"})

	if m.phase != phaseConnecting || cmd == nil {
		t.Fatalf("a resolved token should auto-connect (phase=%v, cmd!=nil=%v)", m.phase, cmd != nil)
	}
	if !m.prefilled {
		t.Fatal("the screen should record that a token was auto-loaded")
	}
	if m.tokenSource != "config/.api_token" {
		t.Fatalf("the token source should be recorded for the UI; got %q", m.tokenSource)
	}
}

// A session saved under a NON-default host (e.g. the operator connected to :8088) must restore
// that host into the field AND auto-connect with its token — otherwise the saved session is
// orphaned because startup only ever looked at the default host. This is the persistence
// regression: close the TUI, reopen it, and it should reconnect, not ask to log in again.
func TestConnectRestoresSavedHost(t *testing.T) {
	m := newConnectModel() // host defaults to localhost:8080

	m, cmd := m.Update(savedLoadedMsg{host: "localhost:8088", token: "sess.jwt", source: "saved for localhost:8088"})

	if m.host.Value() != "localhost:8088" {
		t.Fatalf("the remembered host should be restored into the field; got %q", m.host.Value())
	}
	if m.phase != phaseConnecting || cmd == nil {
		t.Fatalf("a saved session for the remembered host should auto-connect (phase=%v cmd!=nil=%v)", m.phase, cmd != nil)
	}
	if !m.prefilled {
		t.Fatal("the restored session should be marked prefilled")
	}
}

// If the operator has already typed a different host (the keyring/file read raced behind their
// input), a token resolved for the original host must not be applied or auto-connected.
func TestConnectSavedTokenNotAppliedToTypedHost(t *testing.T) {
	m := newConnectModel()
	m.host.SetValue("localhost:9090") // user typed a different host before the read returned

	m, cmd := m.Update(savedLoadedMsg{host: "localhost:8080", token: "secret", source: "config/.api_token"})

	if m.prefilled || cmd != nil {
		t.Fatalf("a token resolved for a different host must not be applied/auto-connected; prefilled=%v cmd!=nil=%v", m.prefilled, cmd != nil)
	}
	if m.token.Value() != "" {
		t.Fatalf("the token field should stay empty for a non-matching host; got %q", m.token.Value())
	}
}

// The note tells the operator exactly where the token came from (so it is never a mystery).
// (Shown in token/advanced mode, which a prefilled-but-failed connection drops back to.)
func TestConnectShowsTokenSource(t *testing.T) {
	m := newConnectModel()
	m.width = 80
	m.advanced = true
	m.prefilled = true
	m.tokenSource = "config/.api_token"
	m.token.SetValue("x")

	if !strings.Contains(m.View(), "config/.api_token") {
		t.Fatalf("the note should show where the token came from; got:\n%s", m.View())
	}
}

// ^X clears the token, its source label, and the saved flag together (no stale source can
// linger to mislabel a later token).
func TestConnectForgetClearsTokenAndSource(t *testing.T) {
	m := newConnectModel()
	m.advanced = true
	m.prefilled = true
	m.tokenSource = "config/.api_token"
	m.token.SetValue("x")

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlX})

	if m.prefilled || m.tokenSource != "" || m.token.Value() != "" {
		t.Fatalf("forget must clear token+source+flag; prefilled=%v source=%q token=%q", m.prefilled, m.tokenSource, m.token.Value())
	}
}

// On a failed connect with a saved token, the view surfaces the diagnosis AND offers to forget
// the token.
func TestConnectViewShowsDiagnosisAndForget(t *testing.T) {
	m := newConnectModel()
	m.width = 80
	m.advanced = true
	m.prefilled = true
	m.token.SetValue("x")
	m.err = diagnoseConnectError("localhost:8080", &api.APIError{Status: 404, Msg: "Not Found"}, true)

	out := strings.ToLower(m.View())

	if !strings.Contains(out, "not a panchito") {
		t.Fatalf("the view should surface the diagnosis; got:\n%s", out)
	}
	if !strings.Contains(out, "forget") {
		t.Fatalf("with a saved token in use, the view should offer to forget it; got:\n%s", out)
	}
}

// ── GitHub device-flow login ──────────────────────────────────────────────────

// By default the screen presents "Log in with GitHub" as the primary action.
func TestConnectGitHubModeIsPrimary(t *testing.T) {
	m := newConnectModel()
	m.width = 80
	m.advanced = false // force GitHub mode regardless of the build's client_id

	out := m.View()
	if !strings.Contains(out, "Log in with GitHub") {
		t.Fatalf("the default screen should offer GitHub login; got:\n%s", out)
	}
}

// Pressing enter in GitHub mode first contacts the server (handshake) to learn its OAuth client
// id — so the id need not be baked into the binary. The screen shows the "contacting…" phase.
func TestConnectLoginStartsWithHandshake(t *testing.T) {
	m := newConnectModel() // defaults to GitHub mode

	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})

	if m.phase != phaseStarting || cmd == nil {
		t.Fatalf("enter should begin the handshake-first login (phase=%v cmd!=nil=%v)", m.phase, cmd != nil)
	}
}

// A device code moves the screen into the waiting phase, shows the user code + verify URL, and
// remembers the resolved client id so the subsequent polls use the same one.
func TestConnectDeviceCodeShowsUserCode(t *testing.T) {
	m := newConnectModel()
	m.width = 80

	m, cmd := m.Update(deviceCodeMsg{
		code:     auth.DeviceCode{UserCode: "WDJB-MJHT", VerificationURI: "https://github.com/login/device", Interval: 5},
		clientID: "Ov23cid",
	})

	if m.phase != phaseDevice || cmd == nil {
		t.Fatalf("a device code should enter phaseDevice and schedule work; phase=%v cmd!=nil=%v", m.phase, cmd != nil)
	}
	if m.clientID != "Ov23cid" {
		t.Fatalf("the resolved client id should be remembered for polling; got %q", m.clientID)
	}
	out := m.View()
	if !strings.Contains(out, "WDJB-MJHT") || !strings.Contains(out, "github.com/login/device") {
		t.Fatalf("the waiting screen must show the user code and verification URL; got:\n%s", out)
	}
}

// A completed poll (the user approved) advances to the session exchange.
func TestConnectPollDoneExchanges(t *testing.T) {
	m := newConnectModel()
	m.phase = phaseDevice

	m, cmd := m.Update(devicePollMsg{result: auth.PollResult{Status: auth.StatusDone, Token: "gho_x"}})

	if m.phase != phaseExchanging || cmd == nil {
		t.Fatalf("a done poll should exchange the token; phase=%v cmd!=nil=%v", m.phase, cmd != nil)
	}
}

// A denied / expired poll returns to the login screen with a clear, distinct reason.
func TestConnectPollTerminalReturnsToLogin(t *testing.T) {
	for _, tc := range []struct {
		status auth.PollStatus
		want   string
	}{
		{auth.StatusDenied, "declined"},
		{auth.StatusExpired, "expired"},
	} {
		m := newConnectModel()
		m.phase = phaseDevice
		m, _ = m.Update(devicePollMsg{result: auth.PollResult{Status: tc.status}})
		if m.phase != phaseLogin {
			t.Fatalf("%v should return to phaseLogin; got %v", tc.status, m.phase)
		}
		if !strings.Contains(strings.ToLower(m.err), tc.want) {
			t.Fatalf("%v error should mention %q; got %q", tc.status, tc.want, m.err)
		}
	}
}

// slow_down must raise the poll-interval floor for ALL subsequent polls (RFC 8628 §3.5), so a
// following pending-poll keeps the slower cadence instead of reverting to the original.
func TestConnectSlowDownPersistsInterval(t *testing.T) {
	m := newConnectModel()
	m.phase = phaseDevice
	m.device = auth.DeviceCode{DeviceCode: "dc", Interval: 5}

	m, _ = m.Update(devicePollMsg{result: auth.PollResult{Status: auth.StatusSlowDown, Interval: 12}})

	if m.device.Interval != 12 {
		t.Fatalf("slow_down must raise the interval floor to 12; got %d", m.device.Interval)
	}
}

// A minted session records the username and probes the control plane with the session token.
func TestConnectLoginExchangedConnects(t *testing.T) {
	m := newConnectModel()
	m.phase = phaseExchanging

	m, cmd := m.Update(loginExchangedMsg{session: contract.LoginResponse{Token: "sess.jwt", Username: "alice"}})

	if m.phase != phaseConnecting || cmd == nil {
		t.Fatalf("a minted session should connect; phase=%v cmd!=nil=%v", m.phase, cmd != nil)
	}
	if m.username != "alice" {
		t.Fatalf("the username should be recorded for the connecting note; got %q", m.username)
	}
}

// ^T toggles into token-paste (advanced) mode, revealing the token field.
func TestConnectToggleToTokenMode(t *testing.T) {
	m := newConnectModel()
	m.width = 80
	m.advanced = false

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlT})

	if !m.advanced {
		t.Fatal("^T should switch to token-paste mode")
	}
	if !strings.Contains(m.View(), "token") {
		t.Fatalf("token mode should show the token field; got:\n%s", m.View())
	}
}

// An error mid-flow (e.g. GitHub unreachable, or login rejected) returns to the login screen
// with the diagnosis, never stranding the user on a spinner.
func TestConnectErrorReturnsToLogin(t *testing.T) {
	m := newConnectModel()
	m.phase = phaseDevice

	m, _ = m.Update(errMsg{err: errors.New("boom")})

	if m.phase != phaseLogin || !strings.Contains(m.err, "boom") {
		t.Fatalf("an error should return to login with the message; phase=%v err=%q", m.phase, m.err)
	}
}

// A 403 at the login exchange is diagnosed as "not a collaborator", distinct from a generic auth failure.
func TestDiagnoseLogin403IsNotCollaborator(t *testing.T) {
	got := strings.ToLower(diagnoseLoginError("localhost:8080", &api.APIError{Status: 403, Msg: "forbidden"}))
	if !strings.Contains(got, "collaborator") {
		t.Fatalf("a 403 login should mention collaborator access; got %q", got)
	}
}
