package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
)

// A successful stop must not be silently swallowed: cancelRunCmd's runCanceledMsg has to be
// handled so the board reflects the wind-down immediately (a fresh poll) instead of showing a
// stale "running" state until the next 3s heartbeat.
func TestRunCanceledClearsArmAndPolls(t *testing.T) {
	m := New()
	m.client = api.New("http://x", "")
	m.screen = screenDashboard
	m.dashboard = newDashboardModel(m.client)
	m.dashboard.stopArmed = true

	updated, cmd := m.Update(runCanceledMsg{})
	m = updated.(Model)

	if m.dashboard.stopArmed {
		t.Fatal("a stop acknowledgment must clear the armed confirmation")
	}
	if cmd == nil {
		t.Fatal("a stop acknowledgment must trigger an immediate poll so the board updates promptly")
	}
	if !strings.Contains(m.dashboard.status, "stop") {
		t.Fatalf("a stop acknowledgment should surface a status line; got %q", m.dashboard.status)
	}
}

// The "+ onboard" row (cursor == len(apps)) is a valid cursor position. An ambient poll that
// leaves the app set unchanged must not bump the cursor off it.
func TestOnboardCursorSurvivesPoll(t *testing.T) {
	m := New()
	m.client = api.New("http://x", "")
	m.screen = screenDashboard
	m.dashboard = newDashboardModel(m.client)
	apps := []contract.AppView{{Name: "a"}, {Name: "b"}}
	m.sys.apps = apps
	m.dashboard.sys = m.sys
	m.dashboard.cursor = 2 // the onboard row

	updated, _ := m.Update(systemLoadedMsg{apps: apps})
	m = updated.(Model)

	if m.dashboard.cursor != 2 {
		t.Fatalf("a poll must not bump the cursor off the onboard row; cursor=%d want 2", m.dashboard.cursor)
	}
}

// cycleFocus must be correct even if called with a focus that is not currently actionable
// (e.g. a stale NOW focus after the run ended): Tab lands on the first actionable panel
// (FLEET), never skipping it.
func TestCycleFocusRecoversFromStaleNowFocus(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}}) // idle → focusOrder is [fleet, models]
	m.focus = focusNow

	m.cycleFocus(1)

	if m.focus != focusFleet {
		t.Fatalf("Tab from a stale idle NOW focus should land on FLEET (first actionable), not skip it; got %d", m.focus)
	}
}
