package ui

import (
	"strings"
	"testing"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func TestSystemStateFold(t *testing.T) {
	now := time.Unix(1700000000, 0)
	s := systemState{}.fold(systemLoadedMsg{
		queue: contract.QueueStatus{Pending: 2},
		apps:  []contract.AppView{{Name: "portfolio"}},
	}, now)
	if !s.loaded {
		t.Fatal("loaded must be true after a successful fold")
	}
	if s.queue.Pending != 2 {
		t.Fatalf("pending = %d, want 2", s.queue.Pending)
	}
	if len(s.apps) != 1 || s.apps[0].Name != "portfolio" {
		t.Fatalf("apps = %+v", s.apps)
	}
	if !s.lastPoll.Equal(now) {
		t.Fatalf("lastPoll = %v, want %v", s.lastPoll, now)
	}
	if s.lastErr != "" {
		t.Fatalf("lastErr should clear on success, got %q", s.lastErr)
	}
}

func TestQueueSummaryStates(t *testing.T) {
	running := systemState{loaded: true}
	running.queue.Running = &struct {
		App string `json:"app"`
		Id  string `json:"id"`
	}{App: "portfolio", Id: "run_1"}

	tests := []struct {
		name string
		sys  systemState
		want string
	}{
		{"not loaded", systemState{}, "connecting"},
		{"idle", systemState{loaded: true}, "idle"},
		{"running", running, "portfolio"},
		{"pending", systemState{loaded: true, queue: contract.QueueStatus{Pending: 3}}, "3 queued"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if out := queueSummary(tt.sys); !strings.Contains(out, tt.want) {
				t.Fatalf("queueSummary = %q, want substring %q", out, tt.want)
			}
		})
	}
}

func TestHealthDots(t *testing.T) {
	if healthDots(systemState{}) != "" {
		t.Fatal("no agent health → no dots")
	}
	s := systemState{}
	s.agent.Health = &struct {
		Codex    *contract.AgentProviderHealth `json:"codex,omitempty"`
		Opencode *contract.AgentProviderHealth `json:"opencode,omitempty"`
	}{Opencode: &contract.AgentProviderHealth{Status: contract.AgentProviderHealthStatusHealthy}}
	if dots := healthDots(s); !strings.Contains(dots, "●") {
		t.Fatalf("expected a health dot, got %q", dots)
	}
}

func TestStatusBarShowsBrandAndState(t *testing.T) {
	out := statusBar(90, "v9.9.9", systemState{loaded: true}, time.Date(2026, 6, 13, 14, 32, 0, 0, time.UTC))
	for _, want := range []string{"panchito", "v9.9.9", "idle", "14:32"} {
		if !strings.Contains(out, want) {
			t.Fatalf("statusBar missing %q:\n%s", want, out)
		}
	}
}

func TestShellNoChromeBeforeConnect(t *testing.T) {
	m := New() // connect screen, client nil
	if m.chromeHeight() != 0 {
		t.Fatalf("chromeHeight before connect = %d, want 0", m.chromeHeight())
	}
	if m.View() != m.screenView() {
		t.Fatal("the connect screen must render with no shell chrome")
	}
}

func TestShellWrapsConnectedScreen(t *testing.T) {
	m := New()
	updated, cmd := m.Update(connectedMsg{
		client: api.New("http://x", ""),
		apps:   []contract.AppView{{Name: "portfolio"}},
		info:   contract.VersionInfo{ServerVersion: "v9.9.9"},
	})
	m = updated.(Model)
	if cmd == nil {
		t.Fatal("connecting must start the ambient poller (non-nil cmd)")
	}
	out := m.View()
	// "connecting…" is unique to the status bar before the first poll lands, so its
	// presence proves the shell chrome wraps the home screen.
	if !strings.Contains(out, "connecting") {
		t.Fatalf("connected view missing the status bar:\n%s", out)
	}
}

func TestShellForwardsReducedHeight(t *testing.T) {
	m := New()
	m.client = api.New("http://x", "")
	m.screen = screenHelp
	m.help = newHelpModel(m.client)

	updated, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	mm := updated.(Model)
	if mm.width != 80 || mm.height != 24 {
		t.Fatalf("root must keep the full size, got %dx%d", mm.width, mm.height)
	}
	if mm.help.height != 23 {
		t.Fatalf("focused screen height = %d, want 23 (24 − 1 chrome)", mm.help.height)
	}
}

func TestSystemLoadedUpdatesShell(t *testing.T) {
	m := New()
	m.client = api.New("http://x", "")
	updated, _ := m.Update(systemLoadedMsg{queue: contract.QueueStatus{Pending: 1}})
	if !updated.(Model).sys.loaded {
		t.Fatal("systemLoadedMsg must mark the ambient state loaded")
	}
}

func TestHealthDotStoppedVsHealthy(t *testing.T) {
	if got := healthDot(contract.AgentProviderHealthStatusStopped); !strings.Contains(got, "○") {
		t.Fatalf("stopped health = %q, want a hollow ○ (distinct from active)", got)
	}
	if got := healthDot(contract.AgentProviderHealthStatusHealthy); !strings.Contains(got, "●") {
		t.Fatalf("healthy health = %q, want a filled ●", got)
	}
}

func TestStatusBarStaleAndUnreachable(t *testing.T) {
	now := time.Date(2026, 6, 13, 14, 0, 0, 0, time.UTC)
	if stale := statusBar(90, "v1", systemState{loaded: true, lastErr: "boom"}, now); !strings.Contains(stale, "stale") {
		t.Fatalf("loaded + last error must surface 'stale':\n%s", stale)
	}
	if un := queueSummary(systemState{lastErr: "boom"}); !strings.Contains(un, "unreachable") {
		t.Fatalf("never-loaded + error must show 'unreachable', got %q", un)
	}
}

func TestShellClampsCursorOnAppShrink(t *testing.T) {
	m := New()
	m.client = api.New("http://x", "")
	m.screen = screenDashboard
	m.dashboard = newDashboardModel(m.client)
	m.dashboard.sys.apps = []contract.AppView{{Name: "a"}, {Name: "b"}, {Name: "c"}}
	m.dashboard.cursor = 2
	updated, _ := m.Update(systemLoadedMsg{apps: []contract.AppView{{Name: "a"}}})
	if c := updated.(Model).dashboard.cursor; c != 0 {
		t.Fatalf("cursor after the fleet shrank = %d, want 0 (clamped)", c)
	}
}
