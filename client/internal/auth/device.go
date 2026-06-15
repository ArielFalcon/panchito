// Package auth runs the GitHub OAuth Device Flow (RFC 8628) so the operator logs in with
// their own GitHub account instead of pasting a shared secret. The flow is entirely
// client-side: the TUI gets a short user code, the human approves it at github.com/login/device,
// and the client polls until GitHub returns a user access token. That token is then exchanged
// at the orchestrator's /api/v1/auth/login for a server session — the token GitHub mints is
// never stored long-term by the client (the session JWT is).
//
// The client_id is the orchestrator team's registered OAuth App, baked in at build time
// (-ldflags) with a PANCHITO_GITHUB_CLIENT_ID env override for development. No client secret
// is needed or used — the device flow is designed for public clients that cannot keep one.
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// BakedClientID is set at build time: -ldflags "-X .../internal/auth.BakedClientID=Iv1.abc123".
// Empty in a plain `go build`, which makes the TUI fall back to manual-token entry.
var BakedClientID = ""

// DefaultScope grants read of repository data so the server can verify the user's push
// permission on a (possibly private) watched repo. The server uses the token read-only and
// discards it after the login exchange.
const DefaultScope = "repo"

const defaultBaseURL = "https://github.com"

// ResolveClientID returns the OAuth App client id to use, in priority order: the env override
// (dev), then what the server advertised in its handshake (the normal path — configure once on
// the server), then the build-time baked value (offline/air-gapped fallback). "" means GitHub
// login is not available from any source.
func ResolveClientID(advertised string) string {
	if v := strings.TrimSpace(os.Getenv("PANCHITO_GITHUB_CLIENT_ID")); v != "" {
		return v
	}
	if v := strings.TrimSpace(advertised); v != "" {
		return v
	}
	return BakedClientID
}

// DeviceFlow holds the parameters for one device-flow login. BaseURL and HTTP default to
// github.com / the default client; tests override both.
type DeviceFlow struct {
	ClientID string
	Scope    string
	BaseURL  string
	HTTP     *http.Client
}

func (f DeviceFlow) baseURL() string {
	if f.BaseURL != "" {
		return f.BaseURL
	}
	return defaultBaseURL
}

func (f DeviceFlow) httpClient() *http.Client {
	if f.HTTP != nil {
		return f.HTTP
	}
	return http.DefaultClient
}

// DeviceCode is GitHub's response to the device-code request: what the human enters and where.
type DeviceCode struct {
	DeviceCode      string
	UserCode        string
	VerificationURI string
	Interval        int // seconds the client must wait between polls
	ExpiresIn       int // seconds until the code expires
}

// PollStatus is the state of a single poll attempt.
type PollStatus string

const (
	StatusPending  PollStatus = "pending"   // keep polling
	StatusSlowDown PollStatus = "slow_down" // keep polling, but use PollResult.Interval
	StatusDone     PollStatus = "done"      // PollResult.Token is set
	StatusDenied   PollStatus = "denied"    // the user declined at github.com
	StatusExpired  PollStatus = "expired"   // the device code timed out — restart the flow
)

// PollResult is the outcome of one poll attempt.
type PollResult struct {
	Token    string
	Status   PollStatus
	Interval int // present for slow_down: the new minimum poll interval (seconds)
}

// RequestCode begins the flow: it asks GitHub for a device + user code.
func (f DeviceFlow) RequestCode(ctx context.Context) (DeviceCode, error) {
	form := url.Values{"client_id": {f.ClientID}}
	if scope := f.Scope; scope != "" {
		form.Set("scope", scope)
	}
	var body struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		Interval        int    `json:"interval"`
		ExpiresIn       int    `json:"expires_in"`
		Error           string `json:"error"`
		ErrorDesc       string `json:"error_description"`
	}
	if err := f.post(ctx, "/login/device/code", form, &body); err != nil {
		return DeviceCode{}, err
	}
	if body.Error != "" {
		return DeviceCode{}, fmt.Errorf("github device-code request rejected: %s", describe(body.Error, body.ErrorDesc))
	}
	if body.DeviceCode == "" || body.UserCode == "" {
		return DeviceCode{}, fmt.Errorf("github returned an empty device code")
	}
	return DeviceCode{
		DeviceCode:      body.DeviceCode,
		UserCode:        body.UserCode,
		VerificationURI: body.VerificationURI,
		Interval:        body.Interval,
		ExpiresIn:       body.ExpiresIn,
	}, nil
}

// Poll performs ONE token-poll attempt. The caller loops (driven by Bubble Tea ticks),
// waiting DeviceCode.Interval seconds between attempts and adopting PollResult.Interval when a
// slow_down comes back. Returning a status (not an error) for the expected pending/slow_down/
// denied/expired cases keeps the caller's control flow simple; transport/parse failures are errors.
func (f DeviceFlow) Poll(ctx context.Context, deviceCode string) (PollResult, error) {
	form := url.Values{
		"client_id":   {f.ClientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}
	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
		Interval    int    `json:"interval"`
	}
	if err := f.post(ctx, "/login/oauth/access_token", form, &body); err != nil {
		return PollResult{}, err
	}
	if body.AccessToken != "" {
		return PollResult{Token: body.AccessToken, Status: StatusDone}, nil
	}
	switch body.Error {
	case "authorization_pending":
		return PollResult{Status: StatusPending}, nil
	case "slow_down":
		return PollResult{Status: StatusSlowDown, Interval: body.Interval}, nil
	case "access_denied":
		return PollResult{Status: StatusDenied}, nil
	case "expired_token":
		return PollResult{Status: StatusExpired}, nil
	default:
		return PollResult{}, fmt.Errorf("github token poll failed: %s", describe(body.Error, body.ErrorDesc))
	}
}

func (f DeviceFlow) post(ctx context.Context, path string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.baseURL()+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := f.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("reach github: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("github %s returned HTTP %d", path, resp.StatusCode)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode github response: %w", err)
	}
	return nil
}

func describe(code, desc string) string {
	if desc != "" {
		return desc
	}
	if code != "" {
		return code
	}
	return "unknown error"
}
