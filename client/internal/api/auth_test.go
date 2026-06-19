package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Login posts the GitHub token to the public login route and decodes the minted session. It
// must work WITHOUT a bearer token (the client has none yet — that is the whole point).
func TestLoginExchangesGithubTokenForSession(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/auth/login" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("login must be unauthenticated, got Authorization %q", got)
		}
		var body struct {
			GithubToken string `json:"githubToken"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.GithubToken != "gho_token" {
			t.Errorf("githubToken = %q", body.GithubToken)
		}
		_, _ = w.Write([]byte(`{"token":"sess.jwt.sig","username":"alice","expiresAt":"2026-06-15T00:00:00Z"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	res, err := c.Login(context.Background(), "gho_token")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if res.Token != "sess.jwt.sig" || res.Username != "alice" {
		t.Fatalf("decoded session: %+v", res)
	}
}

// A 403 (authenticated GitHub user, but not a collaborator on any watched repo) surfaces as an
// APIError the connect screen can diagnose, not a silent empty result.
func TestLoginForbiddenReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"this GitHub account cannot push to any watched repo"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	_, err := c.Login(context.Background(), "gho_token")
	var apiErr *APIError
	if err == nil || !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden {
		t.Fatalf("want 403 APIError, got %v", err)
	}
}
