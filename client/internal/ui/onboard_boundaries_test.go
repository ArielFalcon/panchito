package ui

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func strPtr(s string) *string { return &s }

func winnerProfile() contract.OnboardingJobStatus_ResolvedProfile {
	var p contract.OnboardingJobStatus_ResolvedProfile
	if err := json.Unmarshal([]byte(`{
		"transport":"http","frontFiles":"src/api/shop.ts",
		"frontCallSite":{"kind":"fetch"},
		"servicePrefixTemplate":"/api/shop","serviceRepoTemplate":"org/shop-svc",
		"openApiPath":"openapi/shop.yaml"
	}`), &p); err != nil {
		panic(err)
	}
	return p
}

func winnerStatus() contract.OnboardingJobStatus {
	outcome := contract.Winner
	profile := winnerProfile()
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateDone, App: strPtr("shop"), Round: 2, Ceiling: 3,
		CandidatesScored: 5, Outcome: &outcome, ResolvedProfile: &profile,
	}
}

func noProfileStatus() contract.OnboardingJobStatus {
	outcome := contract.NoProfile
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateDone, App: strPtr("shop"), Round: 3, Ceiling: 3,
		CandidatesScored: 6, Outcome: &outcome,
	}
}

func failedStatus() contract.OnboardingJobStatus {
	errMsg := "onboarding timed out"
	return contract.OnboardingJobStatus{
		State: contract.OnboardingJobStatusStateFailed, App: strPtr("shop"), Round: 1, Ceiling: 3,
		CandidatesScored: 1, Error: &errMsg,
	}
}

func inProgressStatus(state contract.OnboardingJobStatusState, round float32) contract.OnboardingJobStatus {
	return contract.OnboardingJobStatus{
		State: state, App: strPtr("shop"), Round: round, Ceiling: 3, CandidatesScored: 2,
	}
}

// Every state renders a distinguishable View — the badge/round line the design calls for.
func TestBoundaryProposeFoldsEveryStateIntoDistinctView(t *testing.T) {
	cases := []struct {
		name   string
		status contract.OnboardingJobStatus
		want   []string
	}{
		{"resolvingMirrors", inProgressStatus(contract.OnboardingJobStatusStateResolvingMirrors, 0), []string{"resolving"}},
		{"proposing", inProgressStatus(contract.OnboardingJobStatusStateProposing, 1), []string{"proposing", "1", "3"}},
		{"scoring", inProgressStatus(contract.OnboardingJobStatusStateScoring, 2), []string{"scoring"}},
		{"winner", winnerStatus(), []string{"confirm"}},
		{"no-profile", noProfileStatus(), []string{"no boundary profile found"}},
		{"failed", failedStatus(), []string{"onboarding timed out"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := newBoundaryProposeModel(nil, "shop")
			m.width, m.height = 100, 30
			updated, _ := m.Update(boundaryStatusMsg{status: c.status})
			out := strings.ToLower(updated.View())
			for _, w := range c.want {
				if !strings.Contains(out, strings.ToLower(w)) {
					t.Fatalf("%s: View() missing %q:\n%s", c.name, w, out)
				}
			}
		})
	}
}

// enter on a winner outcome dispatches confirmBoundariesCmd — and ONLY on a winner outcome
// (defense in depth alongside the server's own 409/422 on a non-winner confirm).
func TestBoundaryProposeConfirmFiresOnlyOnWinner(t *testing.T) {
	winner := newBoundaryProposeModel(nil, "shop")
	winner.width, winner.height = 100, 30
	winner, _ = winner.Update(boundaryStatusMsg{status: winnerStatus()})
	_, cmd := winner.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter on a winner outcome must dispatch a command")
	}
	switch cmd().(type) {
	case confirmedBoundariesMsg, errMsg:
		// confirmBoundariesCmd resolves to one of these — proves the confirm command fired
		// (client is nil here, so it errors, but the dispatch itself is what's under test).
	default:
		t.Fatalf("enter on a winner should dispatch confirmBoundariesCmd; got %#v", cmd())
	}

	for _, c := range []struct {
		name   string
		status contract.OnboardingJobStatus
	}{
		{"no-profile", noProfileStatus()},
		{"failed", failedStatus()},
		{"in-progress", inProgressStatus(contract.OnboardingJobStatusStateProposing, 1)},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := newBoundaryProposeModel(nil, "shop")
			m.width, m.height = 100, 30
			m, _ = m.Update(boundaryStatusMsg{status: c.status})
			_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
			if cmd != nil {
				t.Fatalf("enter on %s must NOT dispatch a confirm command; got %#v", c.name, cmd())
			}
		})
	}
}

// esc on the winner confirm card discards — no confirm dispatched, and the caller (model.go)
// is the one that actually navigates back; this model only needs to emit backMsg.
func TestBoundaryProposeEscDiscardsNoWrite(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: winnerStatus()})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEscape})
	if cmd == nil {
		t.Fatal("esc must emit a command (back to the board)")
	}
	if _, ok := cmd().(backMsg); !ok {
		t.Fatalf("esc on the winner card should discard and go back; got %#v", cmd())
	}
}

// A no-profile outcome renders no confirm card and esc still just goes back.
func TestBoundaryProposeNoProfileRendersDistinctlyFromWinner(t *testing.T) {
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	m, _ = m.Update(boundaryStatusMsg{status: noProfileStatus()})
	out := strings.ToLower(m.View())
	if strings.Contains(out, "confirm") {
		t.Fatalf("a no-profile outcome must not render a confirm card:\n%s", out)
	}
	if !strings.Contains(out, "no boundary profile found") {
		t.Fatalf("View() missing the no-profile message:\n%s", out)
	}
}

// Once a job reaches a terminal state (done or failed), the model must stop rescheduling its
// own tick — otherwise the poll loop never terminates (mirrors the ongoing pollTick idiom's
// termination contract, system.go, but a per-screen tick instead of the ambient one).
func TestBoundaryProposeStopsTickingOnTerminalState(t *testing.T) {
	for _, c := range []struct {
		name   string
		status contract.OnboardingJobStatus
	}{
		{"done-winner", winnerStatus()},
		{"done-no-profile", noProfileStatus()},
		{"failed", failedStatus()},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := newBoundaryProposeModel(nil, "shop")
			m.width, m.height = 100, 30
			_, cmd := m.Update(boundaryStatusMsg{status: c.status})
			if cmd != nil {
				t.Fatalf("a terminal status must not reschedule the tick; got a non-nil cmd: %#v", cmd())
			}
		})
	}
	// A non-terminal status DOES reschedule (batched: reschedule tick + nothing else, since the
	// poll itself is fired by the tick, not by folding the status).
	m := newBoundaryProposeModel(nil, "shop")
	m.width, m.height = 100, 30
	_, cmd := m.Update(boundaryStatusMsg{status: inProgressStatus(contract.OnboardingJobStatusStateProposing, 1)})
	if cmd == nil {
		t.Fatal("a non-terminal status must reschedule the next tick")
	}
}
