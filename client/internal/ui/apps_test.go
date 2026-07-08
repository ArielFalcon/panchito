package ui

import "testing"

func TestOnboardModelStartsWithNoSelectedReposAndAManualInput(t *testing.T) {
	m := newOnboardModel(nil)
	if len(m.selected) != 0 {
		t.Fatalf("expected no repos selected initially, got %d", len(m.selected))
	}
	if m.manualInput.Placeholder == "" {
		t.Fatal("expected a manual-entry input to be initialized")
	}
}
