package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func TestIntelligenceBodyRendersRulesAndProvenance(t *testing.T) {
	sr := float32(0.86)
	m := newIntelligenceModel(api.New("http://x", ""), "portfolio")
	m.loading = false
	m.width = 96
	m.view = &contract.IntelligenceView{
		App: "portfolio",
		Rules: []contract.LearningRuleView{
			{Trigger: "fragile selector", Action: "scope to a test id", ErrorClass: "E-SELECTOR-FRAGILE", Confidence: "high", UsageCount: 22, OutcomeCount: 3, SuccessRate: &sr, Status: "active"},
		},
		Scorecard: nil, // an e2e app with no oracle signal → must read "not measured"
		Curriculum: &contract.CurriculumView{
			Archetypes: []struct {
				Archetype      string `json:"archetype"`
				CaughtRealBug  bool   `json:"caughtRealBug"`
				PromotionCount int    `json:"promotionCount"`
			}{
				{Archetype: "happy-path", CaughtRealBug: true, PromotionCount: 2},
				{Archetype: "network-error", CaughtRealBug: false, PromotionCount: 0},
			},
		},
	}
	out := m.body()
	for _, want := range []string{"RULES", "E-SELECTOR-FRAGILE", "used 22", "ORACLE", "not measured", "CURRICULUM", "happy-path", "1/2 proven"} {
		if !strings.Contains(out, want) {
			t.Fatalf("intelligence body missing %q:\n%s", want, out)
		}
	}
}

func TestIntelligenceGroundTruthScorecard(t *testing.T) {
	avg := float32(0.82)
	m := newIntelligenceModel(api.New("http://x", ""), "panchito")
	m.loading = false
	m.width = 96
	m.view = &contract.IntelligenceView{
		App:       "panchito",
		Scorecard: &contract.ScorecardView{AvgValueScore: &avg, LastValueScore: &avg, MeasuredRuns: 1, TotalRuns: 1},
	}
	out := m.body()
	if !strings.Contains(out, "ground-truth") || !strings.Contains(out, "0.82") {
		t.Fatalf("scorecard ground-truth line missing:\n%s", out)
	}
}

func TestDashboardIntelKeyOpensIntelligence(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("i")})
	if cmd == nil {
		t.Fatal("i must emit a command")
	}
	if msg, ok := cmd().(intelligenceSelectedMsg); !ok || msg.app != "portfolio" {
		t.Fatalf("i should open intelligence for the selected app, got %#v", cmd())
	}
}
