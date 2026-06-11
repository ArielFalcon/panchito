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
