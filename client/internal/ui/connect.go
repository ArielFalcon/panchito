package ui

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/auth"
	"github.com/ArielFalcon/panchito/internal/store"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const defaultConnectHost = "localhost:8080"

// connectPhase is the connect screen's state machine. The default path is GitHub login:
// phaseLogin → (enter) → phaseStarting (handshake: learn the OAuth client id) → phaseDevice
// (approve at github.com) → phaseExchanging (token→session) → phaseConnecting (handshake + apps)
// → connected. A prefilled/saved token shortcuts straight to phaseConnecting; the token-paste
// mode (advanced) connects from phaseLogin.
type connectPhase int

const (
	phaseLogin      connectPhase = iota // showing the sign-in options
	phaseStarting                       // contacting the server to learn its OAuth client id
	phaseDevice                         // device code shown; polling GitHub for approval
	phaseExchanging                     // GitHub token obtained; exchanging it for a session
	phaseConnecting                     // probing the control plane with a token (handshake + apps)
)

// connectModel is the first screen: sign in to the control plane. The primary path is
// "Log in with GitHub" (OAuth device flow — the operator approves this terminal at
// github.com and never handles a shared secret); an advanced token-paste mode covers
// machines/CI and self-hosted operators whose token is auto-discovered locally.
type connectModel struct {
	host  textinput.Model
	token textinput.Model
	width int

	phase connectPhase
	spin  spinner.Model

	advanced bool // token-paste mode instead of GitHub login

	prefilled   bool   // a token was auto-loaded (saved or discovered) — shown + ^X forgettable
	tokenSource string // where the prefilled token came from (for the UI note)

	device   auth.DeviceCode // the active device-flow code (phaseDevice)
	clientID string          // the OAuth client id resolved for this login (server-advertised/env/baked)
	username string          // the GitHub login, once a session is minted (for the connecting note)

	err    string // diagnosed failure
	status string // transient note (e.g. "forgot the saved token")
}

func newConnectModel() connectModel {
	host := textinput.New()
	host.Placeholder = defaultConnectHost
	host.Prompt = "" // the field draws its own ember caret
	host.SetValue(defaultConnectHost)
	host.CharLimit = 200
	host.Width = 34
	host.Focus()

	token := textinput.New()
	token.Placeholder = "paste a control-plane token"
	token.Prompt = ""
	token.EchoMode = textinput.EchoPassword
	token.CharLimit = 400
	token.Width = 34

	sp := spinner.New()
	sp.Spinner = spinner.MiniDot
	sp.Style = lipgloss.NewStyle().Foreground(colEmber)

	return connectModel{
		host:  host,
		token: token,
		spin:  sp,
		// Default to GitHub login. Whether the server actually offers it (advertises a client id)
		// is resolved when the operator presses enter — the handshake there decides, so we don't
		// need to know it up front. With no client id anywhere, that attempt explains the fallback.
		advanced: false,
	}
}

func (m connectModel) Init() tea.Cmd {
	// Resolve the remembered host + its token from the OS keyring (in a Cmd, so constructing the
	// model touches no OS services — tests stay hermetic).
	return tea.Batch(textinput.Blink, loadSavedCmd())
}

// loadSavedCmd resolves WHERE to reconnect and WITH WHAT, so a returning operator does nothing:
// it picks the last host they successfully reached (else the default), then a token saved for
// THAT host (the GitHub session or a pasted token), else an auto-discovered local token. Looking
// up the token under the remembered host — not the hardcoded default — is what stops a session
// saved for a non-default host from being orphaned.
func loadSavedCmd() tea.Cmd {
	return func() tea.Msg {
		host := store.LoadLastHost()
		if host == "" {
			host = defaultConnectHost
		}
		if token := store.LoadToken(host); token != "" {
			return savedLoadedMsg{host: host, token: token, source: "saved for " + host}
		}
		token, source := store.DiscoverToken()
		return savedLoadedMsg{host: host, token: token, source: source}
	}
}

func (m connectModel) Update(msg tea.Msg) (connectModel, tea.Cmd) {
	switch msg := msg.(type) {
	case savedLoadedMsg:
		// Only act while still on the untouched login screen: if the operator has already started
		// typing their own host (the keyring/file read raced behind their input), leave it alone.
		// "Untouched" = the field still holds the built-in default, so restoring a remembered
		// non-default host is allowed, but overriding what they typed is not.
		pristine := m.host.Value() == defaultConnectHost
		if m.phase == phaseLogin && (pristine || m.host.Value() == msg.host) {
			if msg.host != "" {
				m.host.SetValue(msg.host) // reopen pointed at the host they last reached
			}
			if msg.token != "" && m.token.Value() == "" {
				m.token.SetValue(msg.token)
				m.prefilled = true
				m.tokenSource = msg.source
				// A resolved token → connect straight away. A stale one bounces back here with a
				// diagnosed error and the option to forget it (^X).
				m.phase, m.err, m.status = phaseConnecting, "", ""
				return m, tea.Batch(m.spin.Tick, connectCmd(m.host.Value(), m.token.Value()))
			}
		}
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd

	case deviceCodeMsg:
		m.device = msg.code
		m.clientID = msg.clientID // remember it for polling
		m.phase = phaseDevice
		m.err, m.status = "", ""
		// Open the browser for the operator and start polling after the prescribed interval.
		return m, tea.Batch(m.spin.Tick, openBrowserCmd(msg.code.VerificationURI), devicePollTickCmd(msg.code.Interval))

	case devicePollTickMsg:
		if m.phase != phaseDevice {
			return m, nil // a stale tick after cancel/finish — ignore
		}
		return m, pollDeviceCmd(m.clientID, m.device.DeviceCode)

	case devicePollMsg:
		if m.phase != phaseDevice {
			return m, nil
		}
		switch msg.result.Status {
		case auth.StatusDone:
			m.phase = phaseExchanging
			return m, tea.Batch(m.spin.Tick, loginExchangeCmd(m.host.Value(), msg.result.Token))
		case auth.StatusSlowDown:
			// RFC 8628 §3.5: adopt the new interval as the floor for ALL subsequent polls, not
			// just the next one — otherwise the following pending-poll reverts and GitHub keeps
			// answering slow_down forever.
			m.device.Interval = msg.result.Interval
			return m, devicePollTickCmd(m.device.Interval)
		case auth.StatusPending:
			return m, devicePollTickCmd(m.device.Interval)
		case auth.StatusDenied:
			m.phase, m.err = phaseLogin, "you declined the authorization in GitHub. Press enter to try again."
			return m, nil
		case auth.StatusExpired:
			m.phase, m.err = phaseLogin, "the code expired before you approved it. Press enter for a fresh one."
			return m, nil
		}
		return m, nil

	case loginExchangedMsg:
		// Session minted — remember who, then probe the control plane with the session token.
		m.username = msg.session.Username
		m.phase = phaseConnecting
		return m, tea.Batch(m.spin.Tick, connectCmd(m.host.Value(), msg.session.Token))

	case tea.KeyMsg:
		return m.handleKey(msg)

	case errMsg:
		// Any in-flight step failed → back to the sign-in screen with the diagnosis.
		m.phase = phaseLogin
		m.status = ""
		m.err = msg.err.Error()
		return m, nil

	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	}

	return m.routeToField(msg)
}

// handleKey processes key presses per phase. Action shortcuts are all ctrl-modified so they
// never collide with text typed into the host/token fields.
func (m connectModel) handleKey(msg tea.KeyMsg) (connectModel, tea.Cmd) {
	switch m.phase {
	case phaseStarting, phaseDevice, phaseExchanging:
		// While contacting the server / waiting on GitHub, the only control is cancel.
		if msg.String() == "esc" {
			m.phase, m.status = phaseLogin, "cancelled the GitHub login"
			return m, nil
		}
		return m, nil
	case phaseConnecting:
		return m, nil // a probe is in flight; ignore input until it returns
	}

	// phaseLogin
	switch msg.String() {
	case "ctrl+t":
		// Toggle between GitHub login and token paste.
		m.advanced = !m.advanced
		m.err = ""
		if m.advanced {
			m.focusField(1) // focus the token field
		} else {
			m.focusField(0)
		}
		return m, textinput.Blink
	case "ctrl+x":
		return m.forgetToken()
	case "tab", "shift+tab", "up", "down":
		if m.advanced {
			m.focusField(1 - m.focusIndex())
			return m, textinput.Blink
		}
		return m, nil
	case "enter":
		return m.primaryAction()
	}
	return m.routeToField(msg)
}

// primaryAction runs what `enter` means in the current login mode: start the GitHub device
// flow (first handshaking the server to learn its OAuth client id), or connect with the
// typed/prefilled token.
func (m connectModel) primaryAction() (connectModel, tea.Cmd) {
	if m.advanced {
		m.phase, m.err, m.status = phaseConnecting, "", ""
		return m, tea.Batch(m.spin.Tick, connectCmd(m.host.Value(), m.token.Value()))
	}
	m.phase, m.err, m.status = phaseStarting, "", ""
	return m, tea.Batch(m.spin.Tick, startLoginCmd(m.host.Value()))
}

func (m *connectModel) forgetToken() (connectModel, tea.Cmd) {
	// Stop using the prefilled token. A keyring-saved token is forgotten; an auto-discovered
	// one (env / file) is only cleared for this session — its source is out of our hands.
	src := m.tokenSource
	store.DeleteToken(m.host.Value())
	m.token.SetValue("")
	m.prefilled, m.tokenSource, m.err = false, "", ""
	if src == "" || strings.HasPrefix(src, "saved for ") {
		m.status = "forgot the saved token for " + m.host.Value()
	} else {
		m.status = "cleared the auto-loaded token (still in " + src + ")"
	}
	return *m, nil
}

// focusIndex reports which field is focused (0 = host, 1 = token).
func (m connectModel) focusIndex() int {
	if m.token.Focused() {
		return 1
	}
	return 0
}

func (m *connectModel) focusField(i int) {
	if i == 1 {
		m.host.Blur()
		m.token.Focus()
	} else {
		m.token.Blur()
		m.host.Focus()
	}
}

// routeToField forwards an unhandled message (e.g. a text keypress) to the focused input,
// invalidating the prefilled-source note when the operator edits a value by hand.
func (m connectModel) routeToField(msg tea.Msg) (connectModel, tea.Cmd) {
	var cmd tea.Cmd
	if m.focusIndex() == 0 {
		prev := m.host.Value()
		m.host, cmd = m.host.Update(msg)
		if m.host.Value() != prev {
			m.prefilled, m.tokenSource = false, "" // editing the host invalidates the source note
		}
	} else {
		prev := m.token.Value()
		m.token, cmd = m.token.Update(msg)
		if m.token.Value() != prev {
			m.prefilled, m.tokenSource = false, "" // a hand-typed token is no longer the loaded one
		}
	}
	return m, cmd
}

func (m connectModel) View() string {
	w := contentWidth(m.width)
	var b strings.Builder
	b.WriteString(bannerBox(w) + "\n\n")
	b.WriteString(accentRule(w, "sign in", hintStyle.Render("control plane")) + "\n\n")

	switch m.phase {
	case phaseStarting:
		b.WriteString("  " + m.spin.View() + infoStyle.Render(" contacting "+m.host.Value()+"…"))
	case phaseDevice:
		b.WriteString(m.viewDevice())
	case phaseExchanging:
		b.WriteString("  " + m.spin.View() + infoStyle.Render(" signing you in…"))
	case phaseConnecting:
		what := "connecting to " + m.host.Value() + "…"
		if m.username != "" {
			what = "signed in as " + m.username + " — connecting to " + m.host.Value() + "…"
		} else if m.prefilled {
			what = "connecting with the saved token…"
		}
		b.WriteString("  " + m.spin.View() + infoStyle.Render(" "+what))
	default:
		b.WriteString(m.viewLogin(w))
	}

	if note := m.footnote(); note != "" {
		b.WriteString("\n\n" + note)
	}
	b.WriteString("\n\n" + hintStyle.Render(m.footer()))
	return screenStyle.Render(b.String())
}

// viewLogin renders the idle sign-in screen: the host field plus either the GitHub action or
// the token field, depending on the mode.
func (m connectModel) viewLogin(w int) string {
	var b strings.Builder
	b.WriteString(connectField("host ", !m.advanced || m.focusIndex() == 0) + m.host.View() + "\n")

	if m.advanced {
		b.WriteString(connectField("token", m.focusIndex() == 1) + m.token.View() + "\n")
		if m.prefilled {
			src := m.tokenSource
			if src == "" {
				src = "auto-loaded"
			}
			b.WriteString("\n  " + renderSegs("", sg("↻ ", colInfra), sg("token: "+src, colDim)) + hintStyle.Render("  ·  ^X forget"))
		} else {
			b.WriteString("\n  " + hintStyle.Render("a token is for machines/CI. it lives on the server:"))
			b.WriteString("\n  " + hintStyle.Render("config/.api_token, or $QA_API_TOKEN."))
		}
		return b.String()
	}

	// GitHub mode: a single prominent primary action.
	b.WriteString("\n  " + renderSegs(colWash, sg("▌ ", colEmber), sgb(" Log in with GitHub ", colFg)) + "\n")
	b.WriteString("\n  " + labelStyle.Render("you'll approve this terminal at github.com — no"))
	b.WriteString("\n  " + labelStyle.Render("password or token to copy. access is granted to"))
	b.WriteString("\n  " + labelStyle.Render("collaborators of the watched repositories."))
	return b.String()
}

// viewDevice renders the "approve in GitHub" waiting screen with the user code front and centre.
func (m connectModel) viewDevice() string {
	uri := m.device.VerificationURI
	if uri == "" {
		uri = "https://github.com/login/device"
	}
	codeStyle := lipgloss.NewStyle().Bold(true).Foreground(colEmber)
	var b strings.Builder
	b.WriteString("  " + m.spin.View() + infoStyle.Render(" waiting for you to approve in GitHub…") + "\n\n")
	b.WriteString("  " + labelStyle.Render("1.  open    ") + lipgloss.NewStyle().Foreground(colFg).Render(uri) + "\n")
	b.WriteString("  " + labelStyle.Render("2.  enter   ") + codeStyle.Render(m.device.UserCode) + "\n\n")
	b.WriteString("  " + hintStyle.Render("we tried to open your browser automatically."))
	return b.String()
}

// footnote is the transient status / diagnosed error shown above the footer.
func (m connectModel) footnote() string {
	switch {
	case m.err != "":
		return renderConnectError(m.err)
	case m.status != "":
		return okStyle.Render("✓ " + m.status)
	}
	return ""
}

// footer is the context-sensitive shortcut line.
func (m connectModel) footer() string {
	switch m.phase {
	case phaseStarting, phaseDevice, phaseExchanging:
		return "esc cancel · ^C quit"
	case phaseConnecting:
		return "connecting…"
	}
	if m.advanced {
		return "enter connect · tab switch field · ^X forget token · ^T use GitHub · ^C quit"
	}
	return "enter log in with GitHub · ^T use a token · ^C quit"
}

// renderConnectError renders a (possibly multi-line) diagnosis: the ✗ leads the first line,
// continuation lines are indented beneath it.
func renderConnectError(msg string) string {
	lines := strings.Split(msg, "\n")
	out := errorStyle.Render("✗ " + lines[0])
	for _, l := range lines[1:] {
		out += "\n" + errorStyle.Render("  "+strings.TrimSpace(l))
	}
	return out
}

// connectField labels a form input, marking the focused one with an ember caret.
func connectField(label string, focused bool) string {
	if focused {
		return renderSegs("", sg("▸ ", colEmber)) + lipgloss.NewStyle().Foreground(colFg).Render(label+" ")
	}
	return "  " + labelStyle.Render(label+" ")
}

// ── Commands ──────────────────────────────────────────────────────────────────

func normalizeBase(host string) string {
	if !strings.HasPrefix(host, "http://") && !strings.HasPrefix(host, "https://") {
		return "http://" + host
	}
	return host
}

func newDeviceFlow(clientID string) auth.DeviceFlow {
	return auth.DeviceFlow{ClientID: clientID, Scope: auth.DefaultScope}
}

// startLoginCmd begins a GitHub login: it first handshakes the orchestrator to learn the OAuth
// client id it advertises (so the id need not be baked into this binary), resolves the effective
// id (env override > server-advertised > baked), then asks GitHub for a device code. The
// handshake doubles as an early reachability check, so a wrong host is diagnosed before login.
func startLoginCmd(host string) tea.Cmd {
	return func() tea.Msg {
		c := api.New(normalizeBase(host), "")
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		info, err := c.Handshake(ctx)
		if err != nil {
			return errMsg{errors.New(diagnoseConnectError(host, err, true))}
		}
		advertised := ""
		if info.GithubClientId != nil {
			advertised = *info.GithubClientId
		}
		clientID := auth.ResolveClientID(advertised)
		if clientID == "" {
			return errMsg{errors.New(host + " doesn't have GitHub login configured — press ^T to sign in with a token.")}
		}

		code, err := newDeviceFlow(clientID).RequestCode(ctx)
		if err != nil {
			return errMsg{fmt.Errorf("couldn't start GitHub login: %w", err)}
		}
		return deviceCodeMsg{code: code, clientID: clientID}
	}
}

// devicePollTickCmd waits the prescribed interval, then signals it is time to poll again.
func devicePollTickCmd(interval int) tea.Cmd {
	d := time.Duration(interval) * time.Second
	if d <= 0 {
		d = 5 * time.Second
	}
	return tea.Tick(d, func(time.Time) tea.Msg { return devicePollTickMsg{} })
}

// pollDeviceCmd performs ONE token poll against GitHub for the given client id + device code.
func pollDeviceCmd(clientID, deviceCode string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		res, err := newDeviceFlow(clientID).Poll(ctx, deviceCode)
		if err != nil {
			return errMsg{fmt.Errorf("GitHub login failed: %w", err)}
		}
		return devicePollMsg{result: res}
	}
}

// loginExchangeCmd swaps the GitHub user token for a control-plane session.
func loginExchangeCmd(host, githubToken string) tea.Cmd {
	return func() tea.Msg {
		c := api.New(normalizeBase(host), "")
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		session, err := c.Login(ctx, githubToken)
		if err != nil {
			return errMsg{errors.New(diagnoseLoginError(host, err))}
		}
		return loginExchangedMsg{session: session}
	}
}

func openBrowserCmd(url string) tea.Cmd {
	return func() tea.Msg {
		_ = auth.OpenBrowser(url)
		return nil
	}
}

// diagnoseLoginError turns a failed login exchange into operator-actionable guidance, telling
// "your GitHub token was rejected" apart from "you're authenticated but lack access".
func diagnoseLoginError(host string, err error) string {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case http.StatusForbidden:
			return "your GitHub account can't push to any repo " + host + " watches.\nask an admin to add you as a collaborator, then try again."
		case http.StatusUnauthorized:
			return "GitHub rejected the sign-in — please try logging in again."
		case http.StatusNotImplemented:
			return host + " doesn't have GitHub login configured. Use a token instead (^T)."
		default:
			return "sign-in failed at " + host + ": " + apiErr.Error()
		}
	}
	return "can't reach " + host + " — is the orchestrator running? (npm run start · docker compose up)"
}

// diagnoseConnectError turns a raw connect failure into operator-actionable guidance: a host
// that answered but is not a panchito control plane (the classic "pointed at the app's port,
// not the orchestrator"), an auth failure, or an unreachable host.
func diagnoseConnectError(host string, err error, handshake bool) string {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Status {
		case http.StatusNotFound:
			if handshake {
				return host + " answered, but it is not a panchito control plane (404 at /api/v1/version).\nThis is usually a watched app's port, not the orchestrator — check the host/port."
			}
			// The handshake already succeeded, so the server IS panchito — a 404 here is a
			// missing/mismatched route, not the wrong host.
			return host + " accepted the handshake but returned 404 for /api/v1/apps — the server looks like an incomplete or mismatched build."
		case http.StatusUnauthorized, http.StatusForbidden:
			return "auth failed for " + host + " — the token or session was rejected. Sign in again (enter) or use a token (^T)."
		default:
			return host + " rejected the request: " + apiErr.Error()
		}
	}
	return "can't reach " + host + " — is the orchestrator running? (npm run start · docker compose up)"
}

// connectCmd negotiates the version handshake first (so a stale binary is told to update
// before anything else), then probes the server with ListApps (which also exercises auth),
// diagnosing any failure. On success it remembers the host + token for next time.
func connectCmd(host, token string) tea.Cmd {
	return func() tea.Msg {
		c := api.New(normalizeBase(host), token)

		// Each call gets its own fresh deadline so a slow (cold-start) handshake can't starve
		// the ListApps probe of its budget and mis-report a healthy server as unreachable.
		hctx, hcancel := context.WithTimeout(context.Background(), 8*time.Second)
		info, err := c.Handshake(hctx)
		hcancel()
		if err != nil {
			return errMsg{errors.New(diagnoseConnectError(host, err, true))}
		}
		if !info.Compatible {
			msg := ""
			if info.Message != nil {
				msg = *info.Message
			}
			if msg == "" {
				msg = fmt.Sprintf("update panchito: server %s requires client >= %s", info.ServerVersion, info.MinClientVersion)
			}
			return errMsg{errors.New(msg)}
		}
		if info.ApiVersion != "" && info.ApiVersion != "v1" {
			return errMsg{fmt.Errorf("update panchito: server speaks API %s, this client speaks v1", info.ApiVersion)}
		}

		lctx, lcancel := context.WithTimeout(context.Background(), 8*time.Second)
		apps, err := c.ListApps(lctx)
		lcancel()
		if err != nil {
			return errMsg{errors.New(diagnoseConnectError(host, err, false))}
		}
		store.SaveToken(host, token) // remember the working token for this host next time
		store.SaveLastHost(host)     // and reopen pointed here, so the session is never orphaned
		return connectedMsg{client: c, apps: apps, info: info}
	}
}
