package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
)

// P2-1: the focused selection reveals its secondary actions inline (progressive disclosure),
// so they are discoverable on the row instead of only memorised from the footer.
func TestFleetSelectedRowRevealsActionDrawer(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m.focus = focusFleet
	m.cursor = 0

	out := m.renderFleet(90)

	if !strings.Contains(out, "history") || !strings.Contains(out, "intel") {
		t.Fatalf("the selected row should reveal its actions inline (history/intel); got:\n%s", out)
	}
}

// Only the selected row reveals the drawer — the others stay calm.
func TestFleetUnselectedRowsHideActionDrawer(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}, {Name: "b"}})
	m.focus = focusFleet
	m.cursor = 0

	out := m.renderFleet(90)

	if n := strings.Count(out, "history"); n != 1 {
		t.Fatalf("only the selected row should reveal the drawer; 'history' appeared %d times\n%s", n, out)
	}
}

// P2-4: a project with no run history reads as "no runs yet", not a bare, cryptic "—".
func TestFleetNoRunsShowsLegibleEmptyState(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "panchito"}})
	m.focus = focusModels // not focused on fleet → no caret/drawer noise

	out := m.renderFleet(90)

	if !strings.Contains(out, "no runs") {
		t.Fatalf("a project with no history should say 'no runs', not a bare —; got:\n%s", out)
	}
}

// P2-5: per-row actions live in the inline drawer now, so the footer is trimmed of them but
// keeps the essentials.
func TestFleetFooterTrimmed(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})
	m.focus = focusFleet

	h := m.footerHints()

	if strings.Contains(h, "h history") {
		t.Fatalf("per-row actions belong in the inline drawer, not the footer; got %q", h)
	}
	if !strings.Contains(h, "↵ launch") || !strings.Contains(h, "? help") {
		t.Fatalf("footer must keep the essentials (launch, help); got %q", h)
	}
}

// P2-5: the ‹o› bracket-shortcut notation is retired (the onboard row is arrow-selectable and
// the footer carries the key) — ‹ › is reserved for editable values like ‹ diff · e2e ›.
func TestOnboardRowDropsBracketShortcut(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}})

	out := m.renderFleet(90)

	if strings.Contains(out, "‹o›") {
		t.Fatalf("the ‹o› shortcut notation is retired; got:\n%s", out)
	}
	if !strings.Contains(out, "onboard") {
		t.Fatalf("the onboard row must still be present; got:\n%s", out)
	}
}
