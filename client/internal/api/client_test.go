package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
