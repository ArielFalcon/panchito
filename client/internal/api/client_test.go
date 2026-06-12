package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
)

func TestCreateRunSendsAuthAndDecodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/runs" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("auth header = %q", got)
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"run_1","app":"portfolio","sha":"abc","target":"e2e","mode":"diff","status":"enqueued"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "tok")
	res, err := c.CreateRun(context.Background(), contract.CreateRunInput{App: "portfolio", Target: "e2e", Mode: "diff"})
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if res.Id != "run_1" || res.Target != "e2e" || res.Mode != "diff" {
		t.Fatalf("decoded result: %+v", res)
	}
}

func TestNon2xxBecomesAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"run not found: x"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	_, err := c.GetRun(context.Background(), "x")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want *APIError, got %v", err)
	}
	if apiErr.Status != http.StatusNotFound || apiErr.Msg != "run not found: x" {
		t.Fatalf("APIError = %+v", apiErr)
	}
}

func TestListAppsDecodesArray(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/apps" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`[{"name":"portfolio","repo":"o/r","baseUrl":"https://x","versionUrl":"","code":false,"shadow":true,"needsReview":false,"testDataPrefix":"qa_","services":[]}]`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	apps, err := c.ListApps(context.Background())
	if err != nil {
		t.Fatalf("ListApps: %v", err)
	}
	if len(apps) != 1 || apps[0].Name != "portfolio" || !apps[0].Shadow {
		t.Fatalf("apps: %+v", apps)
	}
}

func TestAgentRuntimeMethodsUseContractPaths(t *testing.T) {
	type seenRequest struct {
		method string
		path   string
		query  string
		body   string
	}
	var seen []seenRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		seen = append(seen, seenRequest{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, body: string(data)})
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/agent/config":
			_, _ = w.Write([]byte(`{"mode":"single","singleProvider":"opencode","assignments":{"primary":{"provider":"opencode","model":"opencode-go/deepseek-v4-pro"},"reviewer":{"provider":"opencode","model":"opencode-go/qwen3.7-max"},"chat":{"provider":"opencode","model":"opencode-go/deepseek-v4-flash"}},"keys":{"opencode":true,"codex":false},"validation":{"ok":true,"errors":[]}}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api/v1/agent/config":
			_, _ = w.Write([]byte(`{"config":{"mode":"single","singleProvider":"codex","assignments":{"primary":{"provider":"codex","model":"gpt-5.4"},"reviewer":{"provider":"codex","model":"gpt-5.4"},"chat":{"provider":"codex","model":"gpt-5.4-mini"}},"keys":{"opencode":true,"codex":true},"validation":{"ok":true,"errors":[]}},"restarted":["codex"]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/agent/models":
			_, _ = w.Write([]byte(`{"provider":"codex","models":[{"id":"gpt-5.4"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/agent/restart":
			_, _ = w.Write([]byte(`{"health":{"provider":"opencode","status":"healthy","configured":true}}`))
		default:
			t.Errorf("unexpected %s %s?%s", r.Method, r.URL.Path, r.URL.RawQuery)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	if cfg, err := c.GetAgentConfig(context.Background()); err != nil || cfg.SingleProvider != "opencode" {
		t.Fatalf("GetAgentConfig = %+v, %v", cfg, err)
	}
	codexKey := "sk-codex"
	mode := contract.AgentConfigUpdateModeSingle
	single := contract.AgentConfigUpdateSingleProvider("codex")
	if res, err := c.UpdateAgentConfig(context.Background(), contract.AgentConfigUpdate{
		Mode:           &mode,
		SingleProvider: &single,
		ApiKeys: &struct {
			Codex    *string `json:"codex,omitempty"`
			Opencode *string `json:"opencode,omitempty"`
		}{Codex: &codexKey},
	}); err != nil || len(res.Restarted) != 1 {
		t.Fatalf("UpdateAgentConfig = %+v, %v", res, err)
	}
	if models, err := c.ListAgentModels(context.Background(), "codex"); err != nil || models.Models[0].Id != "gpt-5.4" {
		t.Fatalf("ListAgentModels = %+v, %v", models, err)
	}
	if restart, err := c.RestartAgentProvider(context.Background(), "opencode"); err != nil || restart.Health.Status != contract.Healthy {
		t.Fatalf("RestartAgentProvider = %+v, %v", restart, err)
	}

	if seen[0].method != http.MethodGet || seen[0].path != "/api/v1/agent/config" {
		t.Fatalf("get config request: %+v", seen[0])
	}
	if seen[1].method != http.MethodPut || seen[1].path != "/api/v1/agent/config" || !strings.Contains(seen[1].body, `"codex":"sk-codex"`) {
		t.Fatalf("update config request: %+v", seen[1])
	}
	if seen[2].method != http.MethodGet || seen[2].path != "/api/v1/agent/models" || seen[2].query != "provider=codex" {
		t.Fatalf("models request: %+v", seen[2])
	}
	if seen[3].method != http.MethodPost || seen[3].path != "/api/v1/agent/restart" || !strings.Contains(seen[3].body, `"provider":"opencode"`) {
		t.Fatalf("restart request: %+v", seen[3])
	}
}

func TestAppOnboardingMethodsUseContractPaths(t *testing.T) {
	type seenRequest struct {
		method string
		path   string
		query  string
		body   string
	}
	var seen []seenRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		seen = append(seen, seenRequest{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, body: string(data)})
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/apps/shop":
			_, _ = w.Write([]byte(`{"name":"shop","repo":"org/shop","baseUrl":"https://dev","versionUrl":"","code":false,"shadow":true,"needsReview":true,"testDataPrefix":"qa","services":[]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/apps":
			_, _ = w.Write([]byte(`{"ok":true,"name":"shop","path":"/x/shop.yaml"}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api/v1/apps/shop":
			_, _ = w.Write([]byte(`{"ok":true,"name":"shop"}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/api/v1/apps/shop":
			_, _ = w.Write([]byte(`{"removed":["config:shop"]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/repos":
			_, _ = w.Write([]byte(`{"repos":[{"fullName":"org/shop","private":false,"description":null}],"hasMore":false}`))
		default:
			t.Errorf("unexpected %s %s?%s", r.Method, r.URL.Path, r.URL.RawQuery)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	if app, err := c.GetApp(context.Background(), "shop"); err != nil || app.Name != "shop" {
		t.Fatalf("GetApp = %+v, %v", app, err)
	}
	if created, err := c.CreateApp(context.Background(), contract.CreateAppInput{Repo: "org/shop"}); err != nil || created.Name == nil || *created.Name != "shop" {
		t.Fatalf("CreateApp = %+v, %v", created, err)
	}
	baseURL := "https://new.dev"
	if updated, err := c.UpdateApp(context.Background(), "shop", contract.UpdateAppInput{BaseUrl: &baseURL}); err != nil || updated.Name == nil || *updated.Name != "shop" {
		t.Fatalf("UpdateApp = %+v, %v", updated, err)
	}
	if deleted, err := c.DeleteApp(context.Background(), "shop", true); err != nil || deleted.Removed[0] != "config:shop" {
		t.Fatalf("DeleteApp = %+v, %v", deleted, err)
	}
	if repos, err := c.ListRepos(context.Background(), "org", 2); err != nil || repos.Repos[0].FullName != "org/shop" {
		t.Fatalf("ListRepos = %+v, %v", repos, err)
	}

	assertReq := func(i int, method, path, query string) {
		t.Helper()
		if seen[i].method != method || seen[i].path != path || seen[i].query != query {
			t.Fatalf("request[%d] = %+v, want %s %s?%s", i, seen[i], method, path, query)
		}
	}
	assertReq(0, http.MethodGet, "/api/v1/apps/shop", "")
	assertReq(1, http.MethodPost, "/api/v1/apps", "")
	if !strings.Contains(seen[1].body, `"repo":"org/shop"`) {
		t.Fatalf("create body: %s", seen[1].body)
	}
	assertReq(2, http.MethodPut, "/api/v1/apps/shop", "")
	if !strings.Contains(seen[2].body, `"baseUrl":"https://new.dev"`) {
		t.Fatalf("update body: %s", seen[2].body)
	}
	assertReq(3, http.MethodDelete, "/api/v1/apps/shop", "purge=1")
	assertReq(4, http.MethodGet, "/api/v1/repos", "owner=org&page=2")
}
