package ui

import (
	"fmt"
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/events"
	"github.com/charmbracelet/lipgloss"
)

// A focus card must be a clean rectangle: top border, every body row, and the bottom
// border all exactly `width` display cells. A mismatch is the "broken corner" bug.
func TestFocusCardLinesAreEqualWidth(t *testing.T) {
	for _, w := range []int{60, 80, 84} {
		card := focusCard(w, colEmber,
			lipgloss.NewStyle().Bold(true).Render("generate"),
			"⠋ 1/3  1m 55s",
			"Add model-behavior tests (phaseIndex, phaseFraction, stateColor)",
			"",
			[]cardKV{
				kv("✎", colEmberS, "wrote", "client/internal/ui/style_test.go"),
				kv("⠋", colInfra, "now", "the agent is generating tests"),
			},
		)
		for i, ln := range strings.Split(card, "\n") {
			if got := lipgloss.Width(ln); got != w {
				t.Fatalf("w=%d: card line %d width = %d, want %d:\n%q", w, i, got, w, ln)
			}
		}
	}
}

// The focus card reads sticky state, not the rolling activity window, so a written file
// stays on screen even after many later tool calls push it out of that window.
func TestFocusCardRowsStayStickyAsActivityWindowSlides(t *testing.T) {
	m := newLiveModel("r", "app", make(chan events.RunEvent, 1), func() {}, 90, 30)
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "step.changed", Body: events.StepChanged{Step: "generate"}}))
	m, _ = m.Update(runEventMsg(events.RunEvent{Type: "agent.activity", Body: events.AgentActivity{CallID: "w", Kind: "writing", Target: "a.spec.ts", Status: "completed"}}))
	// Far more reads than maxActivity, so the write slides out of the rolling window.
	for i := 0; i < maxActivity*3; i++ {
		m, _ = m.Update(runEventMsg(events.RunEvent{Type: "agent.activity", Body: events.AgentActivity{CallID: fmt.Sprintf("r%d", i), Kind: "reading", Target: "x.go", Status: "completed"}}))
	}
	if m.lastFile != "a.spec.ts" {
		t.Fatalf("lastFile = %q, want a.spec.ts", m.lastFile)
	}
	card := m.renderFocusCard(m.deriveActivity())
	if !strings.Contains(card, "a.spec.ts") {
		t.Fatalf("focus card dropped the written file after the window slid:\n%s", card)
	}
}
