package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// RequestCode posts the OAuth App's client_id + scope to GitHub's device-code endpoint and
// returns the user code + verification URI the human must visit.
func TestRequestCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/login/device/code" {
			t.Fatalf("path = %s, want /login/device/code", r.URL.Path)
		}
		_ = r.ParseForm()
		if got := r.Form.Get("client_id"); got != "cid" {
			t.Fatalf("client_id = %q, want cid", got)
		}
		if got := r.Form.Get("scope"); got != "repo" {
			t.Fatalf("scope = %q, want repo", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Fatalf("Accept = %q, want application/json", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"device_code":"dc-123","user_code":"WDJB-MJHT","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}`))
	}))
	defer srv.Close()

	f := DeviceFlow{ClientID: "cid", Scope: "repo", BaseURL: srv.URL, HTTP: srv.Client()}
	code, err := f.RequestCode(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if code.DeviceCode != "dc-123" || code.UserCode != "WDJB-MJHT" {
		t.Fatalf("code = %+v", code)
	}
	if code.VerificationURI != "https://github.com/login/device" {
		t.Fatalf("verification_uri = %q", code.VerificationURI)
	}
	if code.Interval != 5 {
		t.Fatalf("interval = %d, want 5", code.Interval)
	}
}

// A pending authorization is reported as StatusPending (the caller keeps polling); once the
// user approves, Poll returns the access token with StatusDone.
func TestPollPendingThenDone(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/login/oauth/access_token" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_ = r.ParseForm()
		if r.Form.Get("device_code") != "dc-123" {
			t.Fatalf("device_code = %q", r.Form.Get("device_code"))
		}
		w.Header().Set("Content-Type", "application/json")
		calls++
		if calls == 1 {
			_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"gho_token","token_type":"bearer","scope":"repo"}`))
	}))
	defer srv.Close()

	f := DeviceFlow{ClientID: "cid", BaseURL: srv.URL, HTTP: srv.Client()}

	first, err := f.Poll(context.Background(), "dc-123")
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != StatusPending {
		t.Fatalf("first status = %q, want pending", first.Status)
	}

	second, err := f.Poll(context.Background(), "dc-123")
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != StatusDone || second.Token != "gho_token" {
		t.Fatalf("second = %+v, want done/gho_token", second)
	}
}

// slow_down carries a new (larger) interval the caller must adopt before the next poll.
func TestPollSlowDown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"slow_down","interval":12}`))
	}))
	defer srv.Close()

	f := DeviceFlow{ClientID: "cid", BaseURL: srv.URL, HTTP: srv.Client()}
	res, err := f.Poll(context.Background(), "dc-123")
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusSlowDown || res.Interval != 12 {
		t.Fatalf("res = %+v, want slow_down/12", res)
	}
}

// access_denied (user clicked Cancel) and expired_token are terminal, surfaced as distinct
// statuses so the UI can tell "you cancelled" apart from "the code timed out".
func TestPollTerminalStates(t *testing.T) {
	for _, tc := range []struct {
		body string
		want PollStatus
	}{
		{`{"error":"access_denied"}`, StatusDenied},
		{`{"error":"expired_token"}`, StatusExpired},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(tc.body))
		}))
		f := DeviceFlow{ClientID: "cid", BaseURL: srv.URL, HTTP: srv.Client()}
		res, err := f.Poll(context.Background(), "dc-123")
		srv.Close()
		if err != nil {
			t.Fatalf("%s: %v", tc.body, err)
		}
		if res.Status != tc.want {
			t.Fatalf("%s: status = %q, want %q", tc.body, res.Status, tc.want)
		}
	}
}

// ResolveClientID priority: env override > server-advertised > baked-in build value.
func TestResolveClientIDPriority(t *testing.T) {
	t.Setenv("PANCHITO_GITHUB_CLIENT_ID", "env-cid")
	if got := ResolveClientID("server-cid"); got != "env-cid" {
		t.Fatalf("env should win; ResolveClientID = %q, want env-cid", got)
	}

	t.Setenv("PANCHITO_GITHUB_CLIENT_ID", "")
	if got := ResolveClientID("server-cid"); got != "server-cid" {
		t.Fatalf("server-advertised should be used when no env; got %q, want server-cid", got)
	}
	if got := ResolveClientID(""); got != BakedClientID {
		t.Fatalf("with no env and no server value, fall back to the baked id; got %q", got)
	}
}
