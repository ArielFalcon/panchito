package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
)

// When the running project is the FLEET selection, its row offers watch/stop instead of the
// launch config — you resume or stop the run, you do not start a second one.
func TestFleetRunningSelectedRowShowsStopNotLaunchConfig(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "petclinic"}})
	setRunning(&m, "petclinic", "r1")
	gen := "generate"
	m.sys.running = &contract.RunRecord{App: "petclinic", Step: &gen}
	m.focus = focusFleet
	m.cursor = 0

	out := m.renderFleet(90)

	if !strings.Contains(out, "stop") {
		t.Fatalf("running selected row should offer stop; got:\n%s", out)
	}
	if strings.Contains(out, "‹ diff") {
		t.Fatalf("running row must replace the launch config with watch/stop; got:\n%s", out)
	}
}

// An idle selection still edits its launch config in place.
func TestFleetIdleSelectedRowKeepsLaunchConfig(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m.focus = focusFleet
	m.cursor = 0

	out := m.renderFleet(90)

	if !strings.Contains(out, "‹ diff") {
		t.Fatalf("idle selected row should still show the launch config; got:\n%s", out)
	}
}

// The "+ onboard" row is a real, selectable cursor position now — it carries the caret when
// focused, so it's reachable and obvious, not only via the global 'o'.
func TestFleetOnboardRowShowsSelectionCaret(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	m.focus = focusFleet
	m.cursor = 1 // the onboard row

	out := m.renderFleet(90)

	found := false
	for _, l := range strings.Split(out, "\n") {
		if strings.Contains(l, "onboard") && strings.Contains(l, "▸") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the onboard row should carry the selection caret when it is the cursor; got:\n%s", out)
	}
}

// The focused NOW panel surfaces its live controls.
func TestNowFocusedShowsWatchAndStop(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	setRunning(&m, "a", "r1")
	gen := "generate"
	m.sys.running = &contract.RunRecord{App: "a", Step: &gen, Mode: "manual", Target: "e2e"}

	out := m.renderNow(90, true)

	if !strings.Contains(out, "watch") || !strings.Contains(out, "stop") {
		t.Fatalf("focused NOW should advertise watch + stop; got:\n%s", out)
	}
}

// Footers adapt to focus: NOW advertises watch/stop, the help chat is discoverable everywhere
// (? ask), and the retired sessions screen never appears.
func TestFooterHintsByFocus(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	setRunning(&m, "a", "r1")

	m.focus = focusNow
	if h := m.footerHints(); !strings.Contains(h, "watch") || !strings.Contains(h, "stop") {
		t.Fatalf("NOW footer should advertise watch + stop; got %q", h)
	}

	m.focus = focusFleet
	h := m.footerHints()
	if !strings.Contains(h, "? help") {
		t.Fatalf("fleet footer should advertise the help chat (? help); got %q", h)
	}
	if strings.Contains(h, "sessions") {
		t.Fatalf("the retired sessions screen must not appear in the footer; got %q", h)
	}
}
