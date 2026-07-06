package ui

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// boundaryPollInterval is the dedicated poll cadence for a running onboarding job — finer
// than the ambient 3s heartbeat (system.go's pollInterval) so round/candidate/score
// transitions feel live rather than laggy for a bounded ≤3-round job.
const boundaryPollInterval = 1500 * time.Millisecond

// boundaryProposeModel is the FIRST poll-driven live-progress view in this TUI (design §B/§D
// — it deliberately does not reuse live.go's QA-shaped step/verdict rendering; onboarding
// phases don't map onto a QA run's step rail). It renders the current OnboardingJobStatus and,
// on a winner outcome, a confirm card the human must explicitly accept before anything writes.
type boundaryProposeModel struct {
	client *api.Client
	app    string
	width  int
	height int
	status contract.OnboardingJobStatus
	err    string
}

func newBoundaryProposeModel(client *api.Client, app string) boundaryProposeModel {
	return boundaryProposeModel{client: client, app: app}
}

func (m boundaryProposeModel) Init() tea.Cmd {
	return tea.Batch(proposeBoundariesCmd(m.client, m.app), boundaryTickCmd())
}

// ── Messages ─────────────────────────────────────────────────────────────────

// boundaryStatusMsg carries one status snapshot back to the model, whether it came from the
// initial propose call or a subsequent poll — both resolve to the same contract type.
type boundaryStatusMsg struct{ status contract.OnboardingJobStatus }

// boundaryTickMsg fires on the dedicated onboarding-screen heartbeat; the model answers by
// polling the job's status again.
type boundaryTickMsg struct{}

// confirmedBoundariesMsg acknowledges a successful confirm — the boundary block was spliced
// into config/apps/<name>.yaml. The caller (model.go) treats this like any other app-changed
// event and returns to the board.
type confirmedBoundariesMsg struct {
	apps   []contract.AppView
	status string
}

func boundaryTickCmd() tea.Cmd {
	return tea.Tick(boundaryPollInterval, func(time.Time) tea.Msg { return boundaryTickMsg{} })
}

func proposeBoundariesCmd(c *api.Client, app string) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return errMsg{errNotConnected}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		status, err := c.ProposeBoundaries(ctx, app, contract.ProposeBoundariesInput{})
		if err != nil {
			return errMsg{err}
		}
		return boundaryStatusMsg{status: status}
	}
}

func pollBoundaryStatusCmd(c *api.Client, app string) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return errMsg{errNotConnected}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		status, err := c.GetBoundaryStatus(ctx, app)
		if err != nil {
			return errMsg{err}
		}
		return boundaryStatusMsg{status: status}
	}
}

func confirmBoundariesCmd(c *api.Client, app string, status contract.OnboardingJobStatus) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return errMsg{errNotConnected}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		res, err := c.ConfirmBoundaries(ctx, app, contract.ConfirmBoundariesInput{Confirm: true})
		if err != nil {
			return errMsg{err}
		}
		if !res.Ok {
			msg := "confirm rejected"
			if res.Errors != nil && len(*res.Errors) > 0 {
				msg = strings.Join(*res.Errors, "; ")
			}
			return errMsg{fmt.Errorf("%s", msg)}
		}
		note := "boundaries confirmed for " + app
		apps, err := c.ListApps(ctx)
		if err != nil {
			// The write succeeded even though the follow-up refresh failed — surface the note
			// without a stale app list rather than dropping the confirmation.
			return confirmedBoundariesMsg{status: note}
		}
		return confirmedBoundariesMsg{apps: apps, status: note}
	}
}

// ── Update / View ────────────────────────────────────────────────────────────

func (m boundaryProposeModel) Update(msg tea.Msg) (boundaryProposeModel, tea.Cmd) {
	switch msg := msg.(type) {
	case boundaryTickMsg:
		if isTerminalOnboardState(m.status.State) {
			return m, nil
		}
		return m, pollBoundaryStatusCmd(m.client, m.app)
	case boundaryStatusMsg:
		m.status = msg.status
		m.err = ""
		if isTerminalOnboardState(m.status.State) {
			return m, nil
		}
		return m, boundaryTickCmd()
	case errMsg:
		m.err = msg.err.Error()
		return m, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "enter":
			if m.isConfirmableWinner() {
				return m, confirmBoundariesCmd(m.client, m.app, m.status)
			}
			return m, nil
		case "esc":
			return m, func() tea.Msg { return backMsg{} }
		}
	}
	return m, nil
}

// isTerminalOnboardState reports whether the job has reached a state that will never change
// again, so the model must stop rescheduling its own tick (otherwise the poll loop never
// terminates — mirrors system.go's pollTick termination contract, but per-screen).
func isTerminalOnboardState(state contract.OnboardingJobStatusState) bool {
	return state == contract.OnboardingJobStatusStateDone || state == contract.OnboardingJobStatusStateFailed
}

// isConfirmableWinner reports whether the current status is a completed job with a winning,
// resolved profile FOR THIS SCREEN'S OWN APP — the ONLY state in which enter should dispatch a
// confirm. This mirrors the server's own per-app scoping guard (judgment-day C1: the per-app REST
// surface is a facade over one process-wide job) as defense in depth on the client side too — even
// though the server now returns a scoped idle response on an app mismatch, the client must still
// never treat a status payload for a DIFFERENT app as its own confirmable winner.
func (m boundaryProposeModel) isConfirmableWinner() bool {
	return !m.isAppMismatch() &&
		m.status.State == contract.OnboardingJobStatusStateDone &&
		m.status.Outcome != nil && *m.status.Outcome == contract.Winner &&
		m.status.ResolvedProfile != nil
}

// isAppMismatch reports whether the most recently received status belongs to a different app
// than this screen's own app. `status.App` is nil only before the very first status arrives, in
// which case there is nothing to mismatch against.
func (m boundaryProposeModel) isAppMismatch() bool {
	return m.status.App != nil && *m.status.App != m.app
}

func (m boundaryProposeModel) View() string {
	var b strings.Builder
	b.WriteString(accentRule(contentWidth(m.width), "propose boundaries", hintStyle.Render(m.app)) + "\n\n")
	b.WriteString(m.stateBadge() + "\n")
	b.WriteString(m.roundLine() + "\n\n")

	switch {
	case m.isAppMismatch():
		b.WriteString(m.renderAppMismatch())
	case m.status.State == contract.OnboardingJobStatusStateFailed:
		b.WriteString(m.renderFailed())
	case m.isConfirmableWinner():
		b.WriteString(m.renderWinnerCard())
	case m.status.State == contract.OnboardingJobStatusStateDone && m.status.Outcome != nil && *m.status.Outcome == contract.NoProfile:
		b.WriteString(m.renderNoProfile())
	}

	if m.err != "" {
		b.WriteString("\n" + errorStyle.Render("✗ "+m.err) + "\n")
	}
	b.WriteString("\n" + hintStyle.Render(m.footerHint()))
	return b.String()
}

func (m boundaryProposeModel) stateBadge() string {
	label, style := m.badgeLabelAndStyle()
	return style.Bold(true).Render(strings.ToUpper(label))
}

func (m boundaryProposeModel) badgeLabelAndStyle() (string, lipgloss.Style) {
	switch m.status.State {
	case contract.OnboardingJobStatusStateResolvingMirrors:
		return "resolving mirrors", infoStyle
	case contract.OnboardingJobStatusStateProposing:
		return fmt.Sprintf("proposing round %d/%d", int(m.status.Round), int(m.status.Ceiling)), infoStyle
	case contract.OnboardingJobStatusStateScoring:
		return "scoring", infoStyle
	case contract.OnboardingJobStatusStateDone:
		if m.status.Outcome != nil && *m.status.Outcome == contract.Winner {
			return "resolved", okStyle
		}
		return "done", okStyle
	case contract.OnboardingJobStatusStateFailed:
		return "failed", errorStyle
	default:
		return "starting", hintStyle
	}
}

// roundLine reports the per-round progress fields fed by the server's onRound observer
// (design §B) — round, candidates scored, and the best resolved score seen so far.
func (m boundaryProposeModel) roundLine() string {
	line := labelStyle.Render(fmt.Sprintf("round %d/%d · candidates scored %d",
		int(m.status.Round), int(m.status.Ceiling), int(m.status.CandidatesScored)))
	if m.status.LastResolvedScore != nil {
		line += labelStyle.Render(fmt.Sprintf(" · best score %.2f", *m.status.LastResolvedScore))
	}
	return line
}

func (m boundaryProposeModel) renderFailed() string {
	msg := "onboarding failed"
	if m.status.Error != nil {
		msg = *m.status.Error
	}
	return errorStyle.Render(msg) + "\n"
}

func (m boundaryProposeModel) renderNoProfile() string {
	return hintStyle.Render("completed — no boundary profile found (the app may not fit the http/event templates)") + "\n"
}

// renderAppMismatch reports that the polled status belongs to a different app than this screen —
// only possible if another onboarding run started for a different app concurrently. There is
// nothing actionable here except going back; no confirm affordance is ever offered.
func (m boundaryProposeModel) renderAppMismatch() string {
	other := ""
	if m.status.App != nil {
		other = *m.status.App
	}
	return errorStyle.Render(fmt.Sprintf("another app's onboarding job is active: %s", other)) + "\n"
}

// renderWinnerCard shows the serialized boundary block before it lands — the human sees the
// exact block that a confirm would write, matching the human-review-first posture (design §D.4).
func (m boundaryProposeModel) renderWinnerCard() string {
	var b strings.Builder
	b.WriteString(okStyle.Bold(true).Render("boundary profile resolved") + "\n\n")
	b.WriteString(m.renderResolvedProfile())
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colPass).
		Padding(0, 2).
		Render(b.String())
	return box + "\n"
}

// renderResolvedProfile renders a human-readable preview of the resolved boundary — a client-
// side display only; the authoritative serialization into config/apps/<name>.yaml happens
// server-side (spliceBoundariesBlock, reused verbatim from the CLI path, design §A/§C).
func (m boundaryProposeModel) renderResolvedProfile() string {
	if m.status.ResolvedProfile == nil {
		return ""
	}
	if http, err := m.status.ResolvedProfile.AsOnboardingJobStatusResolvedProfile0(); err == nil && http.Transport == contract.Http {
		lines := []string{
			labelStyle.Render("transport ") + "http",
			labelStyle.Render("frontFiles ") + http.FrontFiles,
			labelStyle.Render("servicePrefixTemplate ") + http.ServicePrefixTemplate,
			labelStyle.Render("serviceRepoTemplate ") + http.ServiceRepoTemplate,
			labelStyle.Render("openApiPath ") + http.OpenApiPath,
		}
		return strings.Join(lines, "\n") + "\n"
	}
	if event, err := m.status.ResolvedProfile.AsOnboardingJobStatusResolvedProfile1(); err == nil {
		lines := []string{
			labelStyle.Render("transport ") + "event",
			labelStyle.Render("files ") + event.Files,
			labelStyle.Render("eventPattern.kind ") + event.EventPattern.Kind,
			labelStyle.Render("eventPattern.publishCall ") + event.EventPattern.PublishCall,
			labelStyle.Render("eventPattern.listenerEventCall ") + event.EventPattern.ListenerEventCall,
		}
		return strings.Join(lines, "\n") + "\n"
	}
	return hintStyle.Render("(unrecognized profile shape)") + "\n"
}

func (m boundaryProposeModel) footerHint() string {
	if m.isConfirmableWinner() {
		return "enter confirm · esc cancel"
	}
	return "esc back"
}
