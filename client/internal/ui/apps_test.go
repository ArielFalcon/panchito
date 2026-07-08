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

func TestFormEscInCreateModeGoesBackToRepoStepPreservingState(t *testing.T) {
	m := newOnboardModel(nil) // create mode
	m.step = appStepForm
	m.selected = []repoRole{{"org/web", "frontend"}, {"org/svc", "service"}}
	m.nameInput.SetValue("shop")
	m, cmd := m.updateForm(tea.KeyMsg{Type: tea.KeyEsc})
	if m.step != appStepRepo {
		t.Fatalf("create-mode form esc must go back to the repo step; got step %v", m.step)
	}
	if len(m.selected) != 2 || m.selected[0].fullName != "org/web" {
		t.Fatalf("selection must survive back-nav; got %+v", m.selected)
	}
	if m.nameInput.Value() != "shop" {
		t.Fatalf("form values must survive back-nav; name=%q", m.nameInput.Value())
	}
	if cmd != nil {
		// must NOT emit backMsg (which would exit the wizard)
		if _, isBack := cmd().(backMsg); isBack {
			t.Fatal("create-mode form esc must NOT emit backMsg (that exits the wizard)")
		}
	}
}

func TestFormEscInEditModeExits(t *testing.T) {
	// Edit mode opens directly on the form with no repo step, so esc must still exit.
	m := newEditAppModel(nil, contract.AppView{Name: "shop", Repo: "org/web"})
	m.step = appStepForm
	_, cmd := m.updateForm(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd == nil {
		t.Fatal("edit-mode form esc must emit a command (backMsg to exit)")
	}
	if _, isBack := cmd().(backMsg); !isBack {
		t.Fatalf("edit-mode form esc must emit backMsg; got %#v", cmd())
	}
}

// The repo step's enter prefill must be idempotent: a form -> (esc) -> repo -> (enter) -> form
// round-trip (B5) must NOT clobber a manually edited name or a typed base URL.
func TestFormValuesSurviveRepoRoundTrip(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepRepo
	m.repos = []contract.RepoListItem{{FullName: "org/web"}}
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeySpace}) // select org/web (frontend)
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeyEnter}) // -> form
	m.nameInput.SetValue("my-shop")
	m.baseInput.SetValue("https://dev.shop.com")
	m, _ = m.updateForm(tea.KeyMsg{Type: tea.KeyEsc}) // back to repo (B5)
	if m.step != appStepRepo {
		t.Fatalf("expected repo step; got %v", m.step)
	}
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeyEnter}) // forward to form again
	if m.nameInput.Value() != "my-shop" {
		t.Fatalf("name wiped on round-trip: %q", m.nameInput.Value())
	}
	if m.baseInput.Value() != "https://dev.shop.com" {
		t.Fatalf("base URL wiped on round-trip: %q", m.baseInput.Value())
	}
}

// "/" must work even when the repo list came back empty — otherwise the manual-entry
// input is focused but never rendered, so the user gets no feedback for their keystrokes.
func TestManualInputRendersWhenRepoListEmpty(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = nil // empty list
	m.manualActive = true
	m.manualInput.SetValue("org/typed")
	out := strings.ToLower(m.View())
	if !strings.Contains(out, "org/typed") {
		t.Fatalf("manual input must render even with an empty repo list:\n%s", out)
	}
}

// The manual "/" entry's affordance is "add repo" — it must never remove an already-selected
// repo, unlike the space-key toggle.
func TestManualAddIsAddOnlyNeverRemoves(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepRepo
	m.repos = []contract.RepoListItem{{FullName: "org/web"}}
	m, _ = m.updateRepo(tea.KeyMsg{Type: tea.KeySpace}) // select org/web via space
	if len(m.selected) != 1 {
		t.Fatalf("expected 1 selected after space; got %d", len(m.selected))
	}
	m.manualActive = true
	m.manualInput.SetValue("org/web")
	m, _ = m.updateManualRepo(tea.KeyMsg{Type: tea.KeyEnter}) // manual-add the same slug again
	if len(m.selected) != 1 {
		t.Fatalf("manual add of an already-selected repo must be add-only, not a removal; got %+v", m.selected)
	}
	if m.selected[0].fullName != "org/web" || m.selected[0].role != "frontend" {
		t.Fatalf("expected org/web to remain selected as frontend; got %+v", m.selected)
	}
}

// reposLoadedMsg keeps m.selected across owner switches, but the checkbox list only marks
// repos present in the CURRENT m.repos page — so a cross-owner or otherwise off-list pick
// becomes invisible (and undoable only by memory) unless a summary surfaces it.
func TestSelectionSummaryShowsOffListRepos(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepRepo, 100
	m.repos = []contract.RepoListItem{{FullName: "org/web"}}
	m.selected = []repoRole{{"org/web", "frontend"}, {"org/other-owner-repo", "service"}}
	out := m.View()
	if !strings.Contains(out, "org/other-owner-repo") {
		t.Fatalf("selection summary must show off-list repos:\n%s", out)
	}
}

// buildCreateInput must agree with frontendRepo() (used for display + the repo-step
// prefill) on which frontend wins when more than one is present: the FIRST. This is
// defensive — the UI's one-frontend invariant makes this unreachable in practice — but it
// locks the contract so the two never silently diverge.
func TestCreateInputTakesFirstFrontendWhenMultiplePresent(t *testing.T) {
	sel := []repoRole{{"org/first", "frontend"}, {"org/second", "frontend"}}
	in := buildCreateInput(sel, "shop", "https://dev", "", "e2e", "qa", true, true, nil)
	if in.Repo != "org/first" {
		t.Fatalf("expected the first frontend to win; got %q", in.Repo)
	}
}

// Slice C: DEV-environment Basic Auth field. authMode defaults to "disabled" (no auth
// header written) and the auth row on the form (space toggles it, like target/shadow/review)
// cycles it to "basic", which reveals the user+password inputs.
func TestAuthDefaultsDisabledAndTogglesToBasic(t *testing.T) {
	m := newOnboardModel(nil)
	if m.authMode != "disabled" {
		t.Fatalf("auth must default to disabled; got %q", m.authMode)
	}
	m.step = appStepForm
	m.formCursor = fAuth
	m.toggleFormValue()
	if m.authMode != "basic" {
		t.Fatalf("space on auth row should switch to basic; got %q", m.authMode)
	}
}

// The env user/password rows only exist when basic auth is on, so tab/shift+tab must skip over
// fAuthUser/fAuthPass while auth is disabled (landing on fSave/fAuth respectively without ever
// stopping on the hidden rows), and must be able to stop on them once basic auth reveals them.
// fAuth itself (the toggle) is never hidden, so two forward hops from fPrefix land on fSave.
func TestMoveFormFocusSkipsHiddenAuthFieldsWhenDisabled(t *testing.T) {
	m := newOnboardModel(nil)
	m.step = appStepForm
	m.authMode = "disabled"

	m.formCursor = fPrefix
	m.moveFormFocus(1) // -> fAuth (always visible, never skipped)
	if m.formCursor != fAuth {
		t.Fatalf("expected fAuth after one tab from fPrefix; got %d", m.formCursor)
	}
	m.moveFormFocus(1) // -> must skip fAuthUser/fAuthPass straight to fSave
	if m.formCursor == fAuthUser || m.formCursor == fAuthPass {
		t.Fatalf("disabled auth must skip the hidden credential rows; got %d", m.formCursor)
	}
	if m.formCursor != fSave {
		t.Fatalf("expected fSave after skipping the hidden auth rows; got %d", m.formCursor)
	}

	// Backward from fSave must skip back over the hidden rows to fAuth.
	m.formCursor = fSave
	m.moveFormFocus(-1)
	if m.formCursor != fAuth {
		t.Fatalf("expected fAuth when tabbing back from fSave with auth disabled; got %d", m.formCursor)
	}

	// With basic auth on, the same rows must become reachable.
	m.authMode = "basic"
	m.formCursor = fAuth
	m.moveFormFocus(1)
	if m.formCursor != fAuthUser {
		t.Fatalf("expected fAuthUser to be reachable when basic auth is on; got %d", m.formCursor)
	}
	m.moveFormFocus(1)
	if m.formCursor != fAuthPass {
		t.Fatalf("expected fAuthPass to be reachable when basic auth is on; got %d", m.formCursor)
	}
}

func TestFormViewShowsAuthAndRevealsCredsWhenBasic(t *testing.T) {
	m := newOnboardModel(nil)
	m.step, m.width = appStepForm, 100
	m.repo = "org/web"
	out := strings.ToLower(m.View())
	if !strings.Contains(out, "authentication") {
		t.Fatalf("form must show an authentication row:\n%s", out)
	}
	if strings.Contains(out, "env password") {
		t.Fatal("password row must be hidden while auth is disabled")
	}
	m.authMode = "basic"
	out = strings.ToLower(m.View())
	if !strings.Contains(out, "env user") || !strings.Contains(out, "env password") {
		t.Fatalf("basic auth must reveal user+password:\n%s", out)
	}
}

func TestEnvVarsFromBasicAuth(t *testing.T) {
	m := newOnboardModel(nil)
	m.authMode = "basic"
	m.userInput.SetValue("envuser")
	m.passInput.SetValue("envpass")
	env := m.envVars()
	if env["DEV_ENV_USER"] != "envuser" || env["DEV_ENV_PASS"] != "envpass" {
		t.Fatalf("basic auth must yield DEV_ENV_USER/PASS; got %+v", env)
	}
	m.authMode = "disabled"
	if len(m.envVars()) != 0 {
		t.Fatal("disabled auth must yield no env vars")
	}
}

// The edit form reuses the create form, so it shows the DEV Basic Auth fields — but
// updateAppCmd used to build its UpdateAppInput with no Env at all, silently discarding any
// creds typed on an edit. buildUpdateInput must thread env exactly like buildCreateInput does:
// non-nil only when the caller passes a non-empty map (m.envVars()'s contract — basic auth on
// with a non-empty user), so an edit with auth left disabled sends no Env and never wipes
// creds already stored server-side.
func TestBuildUpdateInputCarriesEnvWhenBasicAuth(t *testing.T) {
	in := buildUpdateInput("org/web", "https://dev", "", "e2e", "qa", true, true, map[string]string{"DEV_ENV_USER": "u", "DEV_ENV_PASS": "p"})
	if in.Env == nil {
		t.Fatal("edit input must carry env when basic auth is set")
	}
	if (*in.Env)["DEV_ENV_USER"] != "u" || (*in.Env)["DEV_ENV_PASS"] != "p" {
		t.Fatalf("env creds not threaded; got %+v", *in.Env)
	}
}

func TestBuildUpdateInputOmitsEnvWhenNone(t *testing.T) {
	in := buildUpdateInput("org/web", "https://dev", "", "e2e", "qa", true, true, nil)
	if in.Env != nil {
		t.Fatalf("no env expected (must not wipe existing creds); got %+v", *in.Env)
	}
}
