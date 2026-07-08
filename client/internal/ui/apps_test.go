package ui

import (
	"strings"
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

func TestRepoStepViewShowsCheckboxesRolesAndHints(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = []contract.RepoListItem{{FullName: "org/web"}, {FullName: "org/svc"}}
	m.selected = []repoRole{{"org/web", "frontend"}}
	out := strings.ToLower(m.View())
	for _, w := range []string{"org/web", "org/svc", "frontend", "space", "role"} {
		if !strings.Contains(out, w) {
			t.Fatalf("repo-step View missing %q:\n%s", w, out)
		}
	}
}

// The manual "/" typed-slug entry must actually surface in the View while active — otherwise
// the user has no visual feedback that their keystrokes are going into the input.
func TestRepoStepViewShowsManualInputWhenActive(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = []contract.RepoListItem{{FullName: "org/web"}}
	m.manualActive = true
	m.manualInput.SetValue("org/typed")
	out := m.View()
	if !strings.Contains(out, "org/typed") {
		t.Fatalf("repo-step View should show the manual input value when active:\n%s", out)
	}
}

// Each selected repo's OWN row must carry its own role — the wizard's core invariant
// (exactly one frontend) has to be legible at a glance, per row, not just present somewhere
// in the overall View (which TestRepoStepViewShowsCheckboxesRolesAndHints already allows).
func TestRepoStepViewMarksFrontendRepoDistinctly(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = []contract.RepoListItem{{FullName: "org/web"}, {FullName: "org/svc"}}
	m.selected = []repoRole{{"org/web", "frontend"}, {"org/svc", "service"}}
	out := strings.ToLower(m.View())
	lines := strings.Split(out, "\n")
	var webLine, svcLine string
	for _, l := range lines {
		switch {
		case strings.Contains(l, "org/web"):
			webLine = l
		case strings.Contains(l, "org/svc"):
			svcLine = l
		}
	}
	if webLine == "" || svcLine == "" {
		t.Fatalf("expected both repos to render a row:\n%s", out)
	}
	if !strings.Contains(webLine, "frontend") {
		t.Fatalf("the frontend repo's own row must show its role:\n%s", webLine)
	}
	if strings.Contains(svcLine, "frontend") {
		t.Fatalf("the service repo's row must not be marked as frontend:\n%s", svcLine)
	}
}

func TestCreateInputSplitsFrontendAndServices(t *testing.T) {
	sel := []repoRole{{"org/web", "frontend"}, {"org/svc-a", "service"}, {"org/svc-b", "service"}}
	in := buildCreateInput(sel, "shop", "https://dev", "", "e2e", "qa", true, true, nil)
	if in.Repo != "org/web" {
		t.Fatalf("frontend must be the primary Repo; got %q", in.Repo)
	}
	if in.Services == nil || len(*in.Services) != 2 {
		t.Fatalf("expected 2 services; got %+v", in.Services)
	}
	if (*in.Services)[0].Repo != "org/svc-a" || (*in.Services)[1].Repo != "org/svc-b" {
		t.Fatalf("services must be in list order; got %+v", *in.Services)
	}
	if in.Name == nil || *in.Name != "shop" {
		t.Fatalf("name must be set; got %+v", in.Name)
	}
}

func TestCreateInputNoServicesWhenSingleFrontend(t *testing.T) {
	in := buildCreateInput([]repoRole{{"org/only", "frontend"}}, "solo", "https://dev", "", "e2e", "qa", false, false, nil)
	if in.Repo != "org/only" {
		t.Fatalf("Repo=%q", in.Repo)
	}
	if in.Services != nil {
		t.Fatalf("no services expected; got %+v", in.Services)
	}
}
