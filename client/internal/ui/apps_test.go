package ui

import (
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func TestOnboardModelStartsWithNoSelectedReposAndAManualInput(t *testing.T) {
	m := newOnboardModel(nil)
	if len(m.selected) != 0 {
		t.Fatalf("expected no repos selected initially, got %d", len(m.selected))
	}
	if m.manualInput.Placeholder == "" {
		t.Fatal("expected a manual-entry input to be initialized")
	}
}

func TestRepoStepTogglesSelectionAndCyclesRole(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepRepo
	m.repos = []contract.RepoListItem{{FullName: "org/web"}, {FullName: "org/svc"}}

	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeySpace}) // toggle org/web on
	if len(m.selected) != 1 || m.selected[0].fullName != "org/web" {
		t.Fatalf("space should select the cursor repo; got %+v", m.selected)
	}
	if m.selected[0].role != "frontend" { // first selection defaults to frontend
		t.Fatalf("first selected repo should default to frontend; got %q", m.selected[0].role)
	}
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}}) // cycle role
	if m.selected[0].role != "service" {
		t.Fatalf("r should cycle role to service; got %q", m.selected[0].role)
	}
}

func TestRepoStepRequiresExactlyOneFrontend(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepRepo
	m.repos = []contract.RepoListItem{{FullName: "org/web"}, {FullName: "org/svc"}}
	m.selected = []repoRole{{"org/web", "service"}, {"org/svc", "service"}} // zero frontends
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeyEnter})
	if m.step == appStepForm {
		t.Fatal("enter must NOT advance with zero frontends")
	}
	if m.err == "" {
		t.Fatal("expected a validation error for zero frontends")
	}
}
