// Package api is the UI-agnostic client for the Panchito control plane: the
// command verbs (typed with the codegen'd contract DTOs) and the RunEvent SSE
// stream. Bubble Tea wraps these as tea.Cmds; nothing here knows about the UI.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/ArielFalcon/panchito/internal/contract"
)

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// ClientVersion is the wire version this binary reports to the server's handshake.
// Release builds inject it via -ldflags "-X .../internal/api.ClientVersion=v1.2.3".
var ClientVersion = "0.1.0"

// New builds a client for baseURL (e.g. "http://localhost:8080"). The http.Client
// has no global timeout on purpose — the SSE stream is long-lived; per-request
// deadlines come from the ctx the caller passes.
func New(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{},
	}
}

// APIError is a non-2xx response carrying the server's error message.
type APIError struct {
	Status int
	Msg    string
}

func (e *APIError) Error() string { return fmt.Sprintf("%s (HTTP %d)", e.Msg, e.Status) }

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
	if err != nil {
		return err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	// Cap the read: a rogue/misconfigured server must not OOM the client.
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 10<<20)) // 10 MiB
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{Status: resp.StatusCode, Msg: errorMessage(data)}
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

func errorMessage(data []byte) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &e) == nil {
		if e.Error != "" {
			return e.Error
		}
		if e.Message != "" {
			return e.Message
		}
	}
	// Non-JSON body (e.g. a proxy's plain-text 502): keep a truncated snippet
	// rather than masking it behind a generic message.
	if s := strings.TrimSpace(string(data)); s != "" {
		if len(s) > 256 {
			s = s[:256]
		}
		return s
	}
	return "request failed"
}

// ── Command verbs ─────────────────────────────────────────────────────────────

// Handshake is the unauthenticated version/capability negotiation — the first
// call the connect screen makes. It reports this binary's version so the server
// (the compatibility authority) can flag an out-of-date client.
func (c *Client) Handshake(ctx context.Context) (contract.VersionInfo, error) {
	q := url.Values{}
	q.Set("client", ClientVersion)
	var out contract.VersionInfo
	err := c.do(ctx, http.MethodGet, "/api/v1/version?"+q.Encode(), nil, &out)
	return out, err
}

func (c *Client) CreateRun(ctx context.Context, in contract.CreateRunInput) (contract.CreateRunResult, error) {
	var out contract.CreateRunResult
	err := c.do(ctx, http.MethodPost, "/api/v1/runs", in, &out)
	return out, err
}

func (c *Client) GetRun(ctx context.Context, id string) (contract.RunRecord, error) {
	var out contract.RunRecord
	err := c.do(ctx, http.MethodGet, "/api/v1/runs/"+url.PathEscape(id), nil, &out)
	return out, err
}

func (c *Client) ListRuns(ctx context.Context, app string, limit int) ([]contract.RunRecord, error) {
	q := url.Values{}
	q.Set("app", app)
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out []contract.RunRecord
	err := c.do(ctx, http.MethodGet, "/api/v1/runs?"+q.Encode(), nil, &out)
	return out, err
}

func (c *Client) ListApps(ctx context.Context) ([]contract.AppView, error) {
	var out []contract.AppView
	err := c.do(ctx, http.MethodGet, "/api/v1/apps", nil, &out)
	return out, err
}

func (c *Client) GetApp(ctx context.Context, name string) (contract.AppView, error) {
	var out contract.AppView
	err := c.do(ctx, http.MethodGet, "/api/v1/apps/"+url.PathEscape(name), nil, &out)
	return out, err
}

// GetIntelligence fetches the read-only learning ledger, value-oracle scorecard and
// curriculum for an app — what the system has actually learned.
func (c *Client) GetIntelligence(ctx context.Context, app string) (contract.IntelligenceView, error) {
	var out contract.IntelligenceView
	err := c.do(ctx, http.MethodGet, "/api/v1/apps/"+url.PathEscape(app)+"/intelligence", nil, &out)
	return out, err
}

// GetSignals fetches the fleet-wide integrity readout (ground-truth value-oracle vs.
// proxy pass-rate) that backs the dashboard's SIGNALS panel.
func (c *Client) GetSignals(ctx context.Context) (contract.SignalsView, error) {
	var out contract.SignalsView
	err := c.do(ctx, http.MethodGet, "/api/v1/signals", nil, &out)
	return out, err
}

// GetTrends fetches the period-over-period trends for an app (change-coverage, value-oracle,
// verdict mix, flaky rate, error classes) — the source data the report ranks.
func (c *Client) GetTrends(ctx context.Context, app string) (contract.TrendsView, error) {
	var out contract.TrendsView
	err := c.do(ctx, http.MethodGet, "/api/v1/apps/"+url.PathEscape(app)+"/trends", nil, &out)
	return out, err
}

// GetReport fetches the ad-hoc report for an app: interestingness-ranked, self-describing
// insights (each declares its chart intent + unit + semantic) the TUI renders as charts.
func (c *Client) GetReport(ctx context.Context, app string) (contract.ReportView, error) {
	var out contract.ReportView
	err := c.do(ctx, http.MethodGet, "/api/v1/apps/"+url.PathEscape(app)+"/report", nil, &out)
	return out, err
}

// GetRunReport fetches the run-scoped report for a finished run: `Current` — the report about that
// execution (verdict, case mix, this run's change-coverage/value/duration) — plus `Evolution`, the
// app's period-over-period report as it stood at that run (nil until there is history to compare).
func (c *Client) GetRunReport(ctx context.Context, runID string) (contract.RunReportView, error) {
	var out contract.RunReportView
	err := c.do(ctx, http.MethodGet, "/api/v1/runs/"+url.PathEscape(runID)+"/report", nil, &out)
	return out, err
}

func (c *Client) CreateApp(ctx context.Context, in contract.CreateAppInput) (contract.CreateAppResult, error) {
	var out contract.CreateAppResult
	err := c.do(ctx, http.MethodPost, "/api/v1/apps", in, &out)
	return out, err
}

func (c *Client) UpdateApp(ctx context.Context, name string, in contract.UpdateAppInput) (contract.CreateAppResult, error) {
	var out contract.CreateAppResult
	err := c.do(ctx, http.MethodPut, "/api/v1/apps/"+url.PathEscape(name), in, &out)
	return out, err
}

func (c *Client) DeleteApp(ctx context.Context, name string, purge bool) (contract.DeleteAppResult, error) {
	path := "/api/v1/apps/" + url.PathEscape(name)
	if purge {
		path += "?purge=1"
	}
	var out contract.DeleteAppResult
	err := c.do(ctx, http.MethodDelete, path, nil, &out)
	return out, err
}

func (c *Client) ListRepos(ctx context.Context, owner string, page int) (contract.RepoListResponse, error) {
	q := url.Values{}
	q.Set("owner", owner)
	if page > 0 {
		q.Set("page", strconv.Itoa(page))
	}
	var out contract.RepoListResponse
	err := c.do(ctx, http.MethodGet, "/api/v1/repos?"+q.Encode(), nil, &out)
	return out, err
}

func (c *Client) Queue(ctx context.Context) (contract.QueueStatus, error) {
	var out contract.QueueStatus
	err := c.do(ctx, http.MethodGet, "/api/v1/queue", nil, &out)
	return out, err
}

func (c *Client) Ask(ctx context.Context, id string, in contract.AskRequest) (contract.AskResponse, error) {
	var out contract.AskResponse
	err := c.do(ctx, http.MethodPost, "/api/v1/runs/"+url.PathEscape(id)+"/ask", in, &out)
	return out, err
}

func (c *Client) Continue(ctx context.Context, id string, in contract.ContinueRequest) (contract.ContinueResult, error) {
	var out contract.ContinueResult
	err := c.do(ctx, http.MethodPost, "/api/v1/runs/"+url.PathEscape(id)+"/continue", in, &out)
	return out, err
}

func (c *Client) Cancel(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/v1/runs/"+url.PathEscape(id), nil, nil)
}

func (c *Client) Help(ctx context.Context, in contract.AskRequest) (contract.AskResponse, error) {
	var out contract.AskResponse
	err := c.do(ctx, http.MethodPost, "/api/v1/help", in, &out)
	return out, err
}

// ── Agent runtime ─────────────────────────────────────────────────────────────

func (c *Client) GetAgentConfig(ctx context.Context) (contract.PublicAgentConfig, error) {
	var out contract.PublicAgentConfig
	err := c.do(ctx, http.MethodGet, "/api/v1/agent/config", nil, &out)
	return out, err
}

func (c *Client) UpdateAgentConfig(ctx context.Context, in contract.AgentConfigUpdate) (contract.AgentConfigApplyResult, error) {
	var out contract.AgentConfigApplyResult
	err := c.do(ctx, http.MethodPut, "/api/v1/agent/config", in, &out)
	return out, err
}

func (c *Client) ListAgentModels(ctx context.Context, provider string) (contract.AgentModelsResponse, error) {
	q := url.Values{}
	q.Set("provider", provider)
	var out contract.AgentModelsResponse
	err := c.do(ctx, http.MethodGet, "/api/v1/agent/models?"+q.Encode(), nil, &out)
	return out, err
}

func (c *Client) RestartAgentProvider(ctx context.Context, provider string) (contract.AgentRestartResponse, error) {
	in := contract.AgentRestartRequest{Provider: contract.AgentRestartRequestProvider(provider)}
	var out contract.AgentRestartResponse
	err := c.do(ctx, http.MethodPost, "/api/v1/agent/restart", in, &out)
	return out, err
}
