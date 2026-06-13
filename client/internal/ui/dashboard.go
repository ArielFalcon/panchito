package ui

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// fleetWindow is how many recent runs per app feed the dashboard's pass-rate and trend.
const fleetWindow = 10

// dashFocus is which interactive panel currently takes navigation/action keys. Tab cycles
// it. Only the panels that DO something are focusable — NOW, SIGNALS and RECENT are
// ambient read-outs, not action surfaces.
type dashFocus int

const (
	focusNow    dashFocus = iota // the active run · ↵ watch · x stop (only when one is running)
	focusFleet                   // pick a project · ← → mode · t target · ↵ launch
	focusModels                  // pick a role · ↵ open the model switcher
	dashFocusCount
)

// launchModes is the FLEET quick-launch cycle (← →). It mirrors the launcher wizard's
// modes; "manual" still routes through the wizard because it needs a guidance string.
var launchModes = []string{"diff", "complete", "exhaustive", "manual", "context"}

// dashboardModel is the console's command center and landing screen: an ambient,
// always-current view of the fleet (per-app recent verdicts + trend), the active run,
// the model roster, recent outcomes, and an honest read of which quality signals are
// real vs. proxy. Volatile state — queue, running run, model health, clock — comes from
// the shell's polled systemState (kept in sync by the root), so the board is live even
// when idle; slower-changing per-app run history is fetched on entry and on refresh.
type dashboardModel struct {
	client  *api.Client
	sys     systemState                     // synced from the root on every poll
	fleet   map[string][]contract.RunRecord // app → recent runs (newest-first)
	signals *contract.SignalsView           // fleet integrity readout (◆ ground truth vs ◇ proxy)
	cursor  int                             // selected app in the fleet
	width   int
	loading bool
	err     string
	status  string // transient success line (e.g. after onboarding)

	// Interaction state: which panel is focused, and the FLEET quick-launch config the
	// focused project row edits in place (← → mode · t target · ↵ launch).
	focus        dashFocus
	launchMode   string // one of launchModes
	launchTarget string // "" → the app's natural target; t toggles to an explicit e2e/code
	launchArmed  bool   // a heavy mode needs a second Enter to confirm (whole-suite/repo runs)
	stopArmed    bool   // 'x' on the active run pressed once; a second 'x' confirms the stop
	modelCursor  int    // MODELS: selected role row

	// Command palette (':'): a fuzzy launcher over the board, scoped to the dashboard
	// so it never eats keystrokes meant for a text field on another screen.
	paletteActive bool
	paletteInput  textinput.Model
	paletteCursor int
}

func newDashboardModel(client *api.Client) dashboardModel {
	ti := textinput.New()
	ti.Placeholder = "run · watch · onboard · agents · history…"
	ti.Prompt = "" // the palette draws its own ember caret
	ti.CharLimit = 80
	return dashboardModel{client: client, fleet: map[string][]contract.RunRecord{}, loading: true, paletteInput: ti, launchMode: "diff", focus: focusFleet}
}

func (m dashboardModel) Init() tea.Cmd {
	return loadFleetCmd(m.client, appNames(m.sys.apps))
}

func appNames(apps []contract.AppView) []string {
	out := make([]string, 0, len(apps))
	for _, a := range apps {
		out = append(out, a.Name)
	}
	return out
}

// fleetLoadedMsg carries the per-app run history that backs the board's trends plus the
// fleet-wide integrity signals (both slow-changing → fetched on entry/refresh, not on the
// 3s heartbeat).
type fleetLoadedMsg struct {
	fleet   map[string][]contract.RunRecord
	signals *contract.SignalsView
}

// loadFleetCmd fetches recent runs for every app and the fleet integrity signals under one
// short deadline. The fleet is small (a handful of apps), so a sequential fetch keeps the
// code simple and the orchestrator unsurprised; a single failing app (or an absent signals
// endpoint) is skipped rather than blanking the board.
func loadFleetCmd(c *api.Client, apps []string) tea.Cmd {
	return func() tea.Msg {
		fleet := make(map[string][]contract.RunRecord, len(apps))
		if c == nil {
			return fleetLoadedMsg{fleet: fleet}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		for _, app := range apps {
			runs, err := c.ListRuns(ctx, app, fleetWindow)
			if err != nil {
				continue // a per-app blip must not blank the rest of the board
			}
			fleet[app] = runs
		}
		var signals *contract.SignalsView
		if s, err := c.GetSignals(ctx); err == nil {
			signals = &s
		}
		return fleetLoadedMsg{fleet: fleet, signals: signals}
	}
}

func (m dashboardModel) Update(msg tea.Msg) (dashboardModel, tea.Cmd) {
	switch msg := msg.(type) {
	case fleetLoadedMsg:
		m.loading = false
		m.fleet = msg.fleet
		m.signals = msg.signals
		m.err = ""
		return m, nil
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case tea.KeyMsg:
		if m.paletteActive {
			return m.paletteKey(msg)
		}
		return m.handleKey(msg)
	}
	return m, nil
}

func (m dashboardModel) handleKey(k tea.KeyMsg) (dashboardModel, tea.Cmd) {
	// A run that ended invalidates a NOW focus; fall back to FLEET so keys act on something.
	if m.focus == focusNow && !m.hasNow() {
		m.focus = focusFleet
	}
	// A key other than a second Enter / second x cancels a pending confirmation.
	if k.String() != "enter" {
		m.launchArmed = false
	}
	if k.String() != "x" {
		m.stopArmed = false
	}
	// Global keys work regardless of which panel is focused.
	switch k.String() {
	case ":":
		m.paletteActive = true
		m.paletteCursor = 0
		m.paletteInput.SetValue("")
		m.paletteInput.Focus()
		return m, textinput.Blink
	case "tab":
		m.cycleFocus(+1)
		return m, nil
	case "shift+tab":
		m.cycleFocus(-1)
		return m, nil
	case "up", "k":
		m.navUp()
		return m, nil
	case "down", "j":
		m.navDown()
		return m, nil
	case "r":
		if !m.loading {
			m.loading, m.status = true, ""
			return m, loadFleetCmd(m.client, appNames(m.sys.apps))
		}
		return m, nil
	case "o":
		return m, func() tea.Msg { return onboardSelectedMsg{} }
	case "a":
		return m, func() tea.Msg { return agentSelectedMsg{} }
	case "?":
		return m, func() tea.Msg { return helpSelectedMsg{} }
	}
	// Panel-scoped keys.
	switch m.focus {
	case focusNow:
		return m.handleNowKey(k)
	case focusModels:
		return m.handleModelsKey(k)
	}
	return m.handleFleetKey(k)
}

// hasNow reports whether the NOW panel is an actionable focus — i.e. a run is in flight.
func (m dashboardModel) hasNow() bool { return m.sys.queue.Running != nil }

// onboardRow is the cursor index of the "+ onboard" row, which sits just past the last
// project so it is reachable with ↓ (not only the global 'o').
func (m dashboardModel) onboardRow() int { return len(m.sys.apps) }

// navDown / navUp move the selection down / up, crossing panel boundaries at the edges so ↑↓
// flow through NOW → projects → onboard → model roles as one continuous list (no Tab needed).
func (m *dashboardModel) navDown() {
	switch m.focus {
	case focusNow:
		m.focus = focusFleet
		m.cursor = 0
	case focusFleet:
		if m.cursor < m.onboardRow() {
			m.cursor++
		} else {
			m.focus = focusModels
			m.modelCursor = 0
		}
	case focusModels:
		if m.modelCursor < len(m.modelRoleList())-1 {
			m.modelCursor++
		}
	}
}

func (m *dashboardModel) navUp() {
	switch m.focus {
	case focusNow:
		// already at the top of the board
	case focusFleet:
		if m.cursor > 0 {
			m.cursor--
		} else if m.hasNow() {
			m.focus = focusNow
		}
	case focusModels:
		if m.modelCursor > 0 {
			m.modelCursor--
		} else {
			m.focus = focusFleet
			m.cursor = m.onboardRow() // re-enter FLEET at its bottom (the onboard row)
		}
	}
}

// focusOrder is the Tab cycle of actionable panels — NOW only while a run is active.
func (m dashboardModel) focusOrder() []dashFocus {
	if m.hasNow() {
		return []dashFocus{focusNow, focusFleet, focusModels}
	}
	return []dashFocus{focusFleet, focusModels}
}

// cycleFocus advances Tab focus through focusOrder, clamping a stale FLEET cursor back in range.
func (m *dashboardModel) cycleFocus(dir int) {
	order := m.focusOrder()
	idx := 0
	for i, f := range order {
		if f == m.focus {
			idx = i
			break
		}
	}
	m.focus = order[(idx+dir+len(order))%len(order)]
	if m.focus == focusFleet && m.cursor > m.onboardRow() {
		m.cursor = m.onboardRow()
	}
}

// handleNowKey drives the focused NOW panel: resume (re-attach) the active run, or stop it
// with a two-press confirm. NOW is focusable only while a run is in flight.
func (m dashboardModel) handleNowKey(k tea.KeyMsg) (dashboardModel, tea.Cmd) {
	r := m.sys.queue.Running
	if r == nil {
		return m, nil
	}
	switch k.String() {
	case "enter":
		id, app := r.Id, r.App
		return m, func() tea.Msg { return watchRunMsg{id: id, app: app} }
	case "x":
		if m.stopArmed {
			m.stopArmed = false
			return m, cancelRunCmd(m.client, r.Id)
		}
		m.stopArmed = true
		return m, nil
	}
	return m, nil
}

// handleFleetKey drives the FLEET panel: pick a project (↑↓), edit its quick-launch
// config in place (← → mode · t target), and launch or watch it (↵). The per-app actions
// (history/intelligence/edit/delete) act on the selected project.
func (m dashboardModel) handleFleetKey(k tea.KeyMsg) (dashboardModel, tea.Cmd) {
	switch k.String() {
	case "left":
		m.launchMode = cycleMode(m.launchMode, -1)
	case "right":
		m.launchMode = cycleMode(m.launchMode, +1)
	case "t":
		if a, ok := m.selectedApp(); ok {
			if m.effectiveTarget(a) == "e2e" {
				m.launchTarget = "code"
			} else {
				m.launchTarget = "e2e"
			}
		}
	case "x":
		// Stop the active run when its project is the selection (the running row surfaces
		// "x stop"); two-press confirm, shared with the NOW panel.
		if r := m.sys.queue.Running; r != nil {
			if a, ok := m.selectedApp(); ok && a.Name == r.App {
				if m.stopArmed {
					m.stopArmed = false
					return m, cancelRunCmd(m.client, r.Id)
				}
				m.stopArmed = true
				return m, nil
			}
		}
	case "enter":
		if m.cursor == m.onboardRow() {
			return m, func() tea.Msg { return onboardSelectedMsg{} }
		}
		return m.launchSelected()
	case "h":
		if a, ok := m.selectedApp(); ok {
			return m, func() tea.Msg { return historySelectedMsg{app: a.Name} }
		}
	case "i":
		if a, ok := m.selectedApp(); ok {
			return m, func() tea.Msg { return intelligenceSelectedMsg{app: a.Name} }
		}
	case "e":
		if a, ok := m.selectedApp(); ok {
			return m, func() tea.Msg { return editAppMsg{app: a} }
		}
	case "d":
		if a, ok := m.selectedApp(); ok {
			return m, func() tea.Msg { return deleteAppMsg{app: a} }
		}
	}
	return m, nil
}

// handleModelsKey drives the MODELS panel: pick a role (↑↓), then ↵ opens the full agent
// switcher (provider, model, dual mode, restart) — the existing screen, not a duplicate.
func (m dashboardModel) handleModelsKey(k tea.KeyMsg) (dashboardModel, tea.Cmd) {
	if k.String() == "enter" {
		return m, func() tea.Msg { return agentSelectedMsg{} }
	}
	return m, nil
}

// cycleMode steps the FLEET quick-launch mode forward/back through launchModes.
func cycleMode(cur string, delta int) string {
	idx := indexOf(launchModes, cur)
	if idx < 0 {
		idx = 0
	}
	n := len(launchModes)
	return launchModes[(idx+delta+n)%n]
}

// effectiveTarget is the target a FLEET launch would use: the explicit override the user
// toggled with t, or the app's natural target (code apps run code; everything else e2e).
func (m dashboardModel) effectiveTarget(a contract.AppView) string {
	if m.launchTarget != "" {
		return m.launchTarget
	}
	if a.Code {
		return "code"
	}
	return "e2e"
}

// launchSelected acts on the FLEET selection: watch it if it is the running run, route to
// the wizard when the mode needs a guidance string (manual), else fire a direct run with
// the in-place [mode · target] config. Shadow is left unset so the app's own config governs.
func (m dashboardModel) launchSelected() (dashboardModel, tea.Cmd) {
	a, ok := m.selectedApp()
	if !ok {
		return m, nil
	}
	if r := m.sys.queue.Running; r != nil && r.App == a.Name {
		return m, func() tea.Msg { return watchRunMsg{id: r.Id, app: a.Name} }
	}
	if m.launchMode == "manual" {
		return m, func() tea.Msg { return appSelectedMsg{app: a.Name} }
	}
	// Heavy modes (whole-suite / whole-repo) cost real time and tokens — require a second
	// Enter so a stray keypress on stage can't kick one off.
	if isHeavyMode(m.launchMode) && !m.launchArmed {
		m.launchArmed = true
		return m, nil
	}
	m.launchArmed = false
	in := contract.CreateRunInput{
		App:    a.Name,
		Target: contract.CreateRunInputTarget(m.effectiveTarget(a)),
		Mode:   contract.CreateRunInputMode(m.launchMode),
	}
	return m, func() tea.Msg { return launchMsg{input: in} }
}

// isHeavyMode flags the modes that regenerate/analyze the whole suite or repo — expensive
// enough to deserve a confirmation before launching from the board.
func isHeavyMode(mode string) bool {
	switch mode {
	case "complete", "exhaustive", "context":
		return true
	}
	return false
}

// modelRole pairs a role's display label with its current assignment.
type modelRole struct {
	label string
	as    contract.RoleAssignment
}

// modelRoleList is the MODELS roster in display order.
func (m dashboardModel) modelRoleList() []modelRole {
	a := m.sys.agent.Assignments
	return []modelRole{
		{"generator", a.Primary},
		{"reviewer", a.Reviewer},
		{"assistant", a.Chat},
	}
}

func (m dashboardModel) selectedApp() (contract.AppView, bool) {
	if m.cursor < 0 || m.cursor >= len(m.sys.apps) {
		return contract.AppView{}, false
	}
	return m.sys.apps[m.cursor], true
}

// ── Command palette (':') ──────────────────────────────────────────────────

type paletteAction struct {
	label string
	msg   func() tea.Msg
}

// paletteActions is the full command set — app-scoped entries (run/watch/history) first,
// then the global destinations.
func (m dashboardModel) paletteActions() []paletteAction {
	var as []paletteAction
	if r := m.sys.queue.Running; r != nil {
		id, app := r.Id, r.App
		as = append(as, paletteAction{"watch " + app + " (running)", func() tea.Msg { return watchRunMsg{id: id, app: app} }})
	}
	for _, a := range m.sys.apps {
		name := a.Name
		as = append(as, paletteAction{"run " + name, func() tea.Msg { return appSelectedMsg{app: name} }})
	}
	for _, a := range m.sys.apps {
		name := a.Name
		as = append(as, paletteAction{"history " + name, func() tea.Msg { return historySelectedMsg{app: name} }})
	}
	for _, a := range m.sys.apps {
		name := a.Name
		as = append(as, paletteAction{"intelligence " + name, func() tea.Msg { return intelligenceSelectedMsg{app: name} }})
	}
	// The dashboard IS the home surface: queue/health live in the status bar, projects in
	// FLEET, the model roster in MODELS. The classic "menu" and "status" screens are
	// redundant subsets, so they are not offered here (see the redundant-screens note).
	return append(as,
		paletteAction{"onboard project", func() tea.Msg { return onboardSelectedMsg{} }},
		paletteAction{"agents — runtime & models", func() tea.Msg { return agentSelectedMsg{} }},
		paletteAction{"help", func() tea.Msg { return helpSelectedMsg{} }},
	)
}

// filteredActions narrows the command set by the typed query (case-insensitive substring).
func (m dashboardModel) filteredActions() []paletteAction {
	q := strings.ToLower(strings.TrimSpace(m.paletteInput.Value()))
	all := m.paletteActions()
	if q == "" {
		return all
	}
	out := make([]paletteAction, 0, len(all))
	for _, a := range all {
		if strings.Contains(strings.ToLower(a.label), q) {
			out = append(out, a)
		}
	}
	return out
}

func (m dashboardModel) paletteKey(k tea.KeyMsg) (dashboardModel, tea.Cmd) {
	switch k.String() {
	case "esc":
		m.paletteActive = false
		m.paletteInput.Blur()
		m.paletteCursor = 0
		return m, nil
	case "up", "ctrl+p":
		if m.paletteCursor > 0 {
			m.paletteCursor--
		}
		return m, nil
	case "down", "ctrl+n":
		if m.paletteCursor < len(m.filteredActions())-1 {
			m.paletteCursor++
		}
		return m, nil
	case "enter":
		acts := m.filteredActions()
		if m.paletteCursor >= 0 && m.paletteCursor < len(acts) {
			run := acts[m.paletteCursor].msg
			m.paletteActive = false
			m.paletteInput.Blur()
			return m, func() tea.Msg { return run() }
		}
		return m, nil
	default:
		var cmd tea.Cmd
		m.paletteInput, cmd = m.paletteInput.Update(k)
		m.paletteCursor = 0 // the filter changed; reset the selection to the top
		return m, cmd
	}
}

func activityGlyph(kind contract.AgentActivityKind) string {
	switch kind {
	case "file":
		return "✎"
	case "command":
		return "⚙"
	case "todo":
		return "◦"
	case "error":
		return "✗"
	case "phase":
		return "▸"
	default:
		return "·"
	}
}

// ── Fleet aggregation ────────────────────────────────────────────────────────

// verdictScore maps a run verdict to a quality score in [0,1] for the trend sparkline:
// a clean pass is 1, a soft outcome (flaky/skipped) is mid, a hard failure is 0.
func verdictScore(v *contract.RunRecordVerdict) float64 {
	if v == nil {
		return 0.5
	}
	switch *v {
	case contract.RunRecordVerdictPass:
		return 1
	case contract.RunRecordVerdictFlaky, contract.RunRecordVerdictSkipped:
		return 0.5
	default: // fail, invalid, infra-error
		return 0
	}
}

type fleetStats struct {
	total    int
	passes   int
	passRate float64
	spark    string                       // oldest→newest quality trend
	last     []*contract.RunRecordVerdict // oldest→newest, within the window
}

// computeFleetStats summarizes an app's runs (as returned newest-first by ListRuns):
// it takes the most recent window, reverses to oldest→newest, and derives the trend +
// pass rate from the verdicts.
func computeFleetStats(runs []contract.RunRecord, window int) fleetStats {
	if window <= 0 || window > len(runs) {
		window = len(runs)
	}
	recent := runs[:window]
	var st fleetStats
	st.total = len(recent)
	scores := make([]float64, 0, len(recent))
	for i := len(recent) - 1; i >= 0; i-- { // newest-first → oldest-first
		v := recent[i].Verdict
		scores = append(scores, verdictScore(v))
		st.last = append(st.last, v)
		if v != nil && *v == contract.RunRecordVerdictPass {
			st.passes++
		}
	}
	st.spark = sparklineRange(scores, 0, 1) // quality is a fixed 0..1 scale, not relative
	if st.total > 0 {
		st.passRate = float64(st.passes) / float64(st.total)
	}
	return st
}

func pipelineFraction(step string) float64 {
	idx := indexOf(pipelinePhases, step)
	if idx < 0 || len(pipelinePhases) <= 1 {
		return 0
	}
	return float64(idx) / float64(len(pipelinePhases)-1)
}

// runningPhase reports whether app is the active run and, if its polled record has landed,
// its live phase and pipeline fraction — so a FLEET row can show progress instead of a
// stale pass-rate. ok is true the moment the queue says the app is running, even before the
// step record arrives (phase=="" → the row shows a bare "● running").
func (m dashboardModel) runningPhase(app string) (phase string, frac float64, ok bool) {
	r := m.sys.queue.Running
	if r == nil || r.App != app {
		return "", 0, false
	}
	if rec := m.sys.running; rec != nil && rec.App == app && rec.Step != nil {
		return *rec.Step, pipelineFraction(*rec.Step), true
	}
	return "", 0, true
}

// ── View ───────────────────────────────────────────────────────────────────

func (m dashboardModel) View() string {
	w := contentWidth(m.width)
	if m.paletteActive {
		return screenStyle.Render(m.renderPalette(w))
	}
	var b strings.Builder
	b.WriteString(m.renderNow(w) + "\n\n")
	b.WriteString(m.renderFleet(w) + "\n\n")

	// Two columns when there's room; stack them on narrow terminals so neither the
	// roster nor the signals panel is crushed to an unreadable width.
	if w < 72 {
		b.WriteString(m.renderModels(w) + "\n\n" + m.renderSignals(w) + "\n\n")
	} else {
		colW := (w - 3) / 2
		cols := lipgloss.JoinHorizontal(
			lipgloss.Top,
			m.renderModels(colW),
			lipgloss.NewStyle().Width(3).Render(""),
			m.renderSignals(colW),
		)
		b.WriteString(cols + "\n\n")
	}
	b.WriteString(m.renderRecent(w))

	switch {
	case m.launchArmed:
		b.WriteString("\n\n" + shadowStyle.Render(fmt.Sprintf("⚠ '%s' is a heavy run (whole suite/repo) — press ↵ again to confirm · any other key cancels", m.launchMode)))
	case m.err != "":
		b.WriteString("\n\n" + errorStyle.Render("✗ "+m.err))
	case m.status != "":
		b.WriteString("\n\n" + okStyle.Render("✓ "+m.status))
	}
	b.WriteString("\n\n" + hintStyle.Render(m.footerHints()))
	return screenStyle.Render(b.String())
}

// footerHints adapts the key legend to the focused panel, so the actions a panel offers
// are always visible rather than memorised. Tab moves focus; the palette (':') and help
// ('?') are the always-available escape hatches.
func (m dashboardModel) footerHints() string {
	switch m.focus {
	case focusModels:
		return "tab panel · ↑↓ role · ↵ change model · o onboard · a agents · s sessions · : cmd · ? help · q quit"
	default:
		return "tab panel · ↑↓ project · ← → mode · t target · ↵ launch · h history · i intel · e edit · d delete · o onboard · : cmd · q quit"
	}
}

// renderPalette is the ':' command launcher: an input, then the filtered command list
// with the ember selection bar — the keyboard-first accelerator over the board's keys.
func (m dashboardModel) renderPalette(w int) string {
	var b strings.Builder
	b.WriteString(accentRule(w, "command", hintStyle.Render("↑↓ move · ↵ run · esc close")) + "\n\n")
	b.WriteString(renderSegs("", sg("› ", colEmber)) + m.paletteInput.View() + "\n\n")
	acts := m.filteredActions()
	if len(acts) == 0 {
		return b.String() + hintStyle.Render("  no matching command")
	}
	for i, a := range acts {
		if i >= 12 {
			b.WriteString(hintStyle.Render(fmt.Sprintf("  +%d more — keep typing to narrow", len(acts)-12)))
			break
		}
		if i == m.paletteCursor {
			b.WriteString(selectedRow(w, "", a.label, "") + "\n")
		} else {
			b.WriteString(normalRow(w, "", a.label, "") + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// renderNow is the active-run banner — the board's pulse. It reads the live queue and,
// when a run is in flight, the running record's step and pipeline position.
func (m dashboardModel) renderNow(w int) string {
	q := m.sys.queue
	if q.Running == nil {
		body := hintStyle.Render("no active run")
		if len(m.sys.apps) > 0 {
			body = hintStyle.Render("pick a project below · ↵ run · o onboard")
		}
		return accentRule(w, "now", okStyle.Render("idle")) + "\n  " + body
	}

	app := q.Running.App
	r := m.sys.running
	right, step := "", ""
	frac := 0.0
	if r != nil {
		var meta []string
		if r.Mode != "" {
			meta = append(meta, string(r.Mode))
		}
		meta = append(meta, string(r.Target))
		right = hintStyle.Render(strings.Join(meta, " · "))
		if r.Step != nil {
			step = *r.Step
		}
		frac = pipelineFraction(step)
	}

	line := renderSegs("", sg("● ", colInfra), sgb(app, colFg))
	if step != "" {
		line += renderSegs("", sg("   ", colFaint), sg(phaseDescription(step), colDim))
	}
	out := accentRule(w, "now", right) + "\n  " + line + "\n  " + progressBar(w-2, frac, colInfra)
	if tail := m.runActivityTail(w); tail != "" {
		out += "\n" + tail
	}
	return out + "\n  " + hintStyle.Render("↵ watch this run · s sessions")
}

// runActivityTail surfaces the active run's last few activity lines — a live-ish event
// feed sourced from the polled run record (it refreshes on the heartbeat, so it needs no
// extra stream subscription).
func (m dashboardModel) runActivityTail(w int) string {
	r := m.sys.running
	if r == nil || r.Activity == nil {
		return ""
	}
	acts := *r.Activity
	if len(acts) == 0 {
		return ""
	}
	start := 0
	if len(acts) > 3 {
		start = len(acts) - 3
	}
	var b strings.Builder
	for _, a := range acts[start:] {
		b.WriteString("  " + hintStyle.Render(activityGlyph(a.Kind)+" "+truncate(a.Text, w-6)) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// panelRule draws a section header that turns ember (accentRule) when its panel is the
// focused, interactive one, and stays quiet (labelRule) otherwise.
func panelRule(w int, focused bool, title, right string) string {
	if focused {
		return accentRule(w, title, right)
	}
	return labelRule(w, title, right)
}

// renderFleet is the per-app health board AND the quick launcher: target, the last few
// verdicts, a pass rate, and a quality trend sparkline. When FLEET is focused, the
// selected row also shows the in-place launch config (← → mode · t target · ↵ launch).
func (m dashboardModel) renderFleet(w int) string {
	focused := m.focus == focusFleet
	var b strings.Builder
	b.WriteString(panelRule(w, focused, "fleet", hintStyle.Render(pluralize(len(m.sys.apps), "project", "projects"))) + "\n")
	if len(m.sys.apps) == 0 {
		return b.String() + "  " + renderSegs("", sg("＋ ", colEmber)) + hintStyle.Render("no projects yet — press o to onboard one")
	}
	for i, a := range m.sys.apps {
		st := computeFleetStats(m.fleet[a.Name], fleetWindow)
		target, tcol := "e2e", colInfra
		if a.Code {
			target, tcol = "code", colFlaky
		}
		selected := i == m.cursor
		bar, name := "   ", labelStyle.Render(padRight(a.Name, 14))
		if selected {
			bar = renderSegs("", sg("▌▸ ", colEmber))
			name = renderSegs("", sgb(padRight(a.Name, 14), colFg))
		}
		// A running project shows its LIVE pipeline progress (the same metric NOW shows, so
		// the two never disagree); an idle one shows its run history — last verdicts, the
		// pass-rate (labelled "pass", so it never reads as progress) and the quality trend.
		var status string
		if phase, frac, running := m.runningPhase(a.Name); running {
			label := "running"
			if phase != "" {
				label = phase
			}
			status = renderSegs("", sg("● ", colInfra), sg(label, colInfra))
			// Append the progress % only once the pipeline has actually advanced; the first
			// phase ("gate", frac 0) shows a bare "● gate" rather than a bare 0%.
			if phase != "" && frac > 0 {
				status += lipgloss.NewStyle().Foreground(colInfra).Render(fmt.Sprintf("  %d%%", int(frac*100+0.5)))
			}
		} else {
			rate := "  —"
			if st.total > 0 {
				rate = fmt.Sprintf("%3.0f%% pass", st.passRate*100)
			}
			status = padGlyphs(lastVerdictGlyphs(st.last, 5), 5) + "  " +
				passRateStyle(st.passRate, st.total).Render(rate) + "  " +
				lipgloss.NewStyle().Foreground(colDim).Render(st.spark)
		}
		row := bar + name + " " +
			renderSegs("", sg(padRight(target, 5), tcol)) + " " +
			status
		if a.Shadow {
			row += "  " + shadowStyle.Render("shadow")
		}
		// On the focused selection, surface the launch config the ← → t keys edit in place.
		if selected && focused {
			row += "   " + renderSegs("", sg("‹ ", colEmber), sgb(m.launchMode, colFg), sg(" · ", colFaint), sgb(m.effectiveTarget(a), colFg), sg(" ›", colEmber))
		}
		b.WriteString(row + "\n")
	}
	b.WriteString("  " + renderSegs("", sg("＋ ", colEmber), sg("onboard project", colDim)) + hintStyle.Render("  ‹o›"))
	return strings.TrimRight(b.String(), "\n")
}

// lastVerdictGlyphs renders the last n verdicts (oldest→newest) as colored glyphs.
func lastVerdictGlyphs(verdicts []*contract.RunRecordVerdict, n int) string {
	if len(verdicts) > n {
		verdicts = verdicts[len(verdicts)-n:]
	}
	var b strings.Builder
	for _, v := range verdicts {
		b.WriteString(runVerdictStyle(v).Render(runVerdictIcon(v)))
	}
	return b.String()
}

// padGlyphs right-pads a glyph cluster (display width = glyph count) to n cells so the
// pass-rate column stays aligned across apps with different history depth.
func padGlyphs(glyphs string, n int) string {
	if w := lipgloss.Width(glyphs); w < n {
		return glyphs + strings.Repeat(" ", n-w)
	}
	return glyphs
}

func passRateStyle(rate float64, total int) lipgloss.Style {
	if total == 0 {
		return hintStyle
	}
	switch {
	case rate >= 0.9:
		return okStyle
	case rate >= 0.6:
		return shadowStyle
	default:
		return errorStyle
	}
}

// renderModels is the roster AND the entry to the switcher: each role's provider, model,
// and a provider health dot. When focused, ↑↓ picks a role and ↵ opens the full agent
// screen (provider/model/dual/restart). The header states the runtime mode (single·dual).
func (m dashboardModel) renderModels(w int) string {
	focused := m.focus == focusModels
	right := ""
	switch string(m.sys.agent.Mode) {
	case "dual":
		right = renderSegs("", sg("dual", colFlaky))
	case "single":
		right = hintStyle.Render("single · " + string(m.sys.agent.SingleProvider))
	}
	var b strings.Builder
	b.WriteString(panelRule(w, focused, "models", right) + "\n")
	for i, r := range m.modelRoleList() {
		model := r.as.Model
		if model == "" {
			model = "—"
		}
		prov := string(r.as.Provider)
		marker, label := " ", labelStyle.Render(padRight(r.label, 10))
		if focused && i == m.modelCursor {
			marker = renderSegs("", sg("▌", colEmber))
			label = renderSegs("", sgb(padRight(r.label, 10), colFg))
		}
		b.WriteString(marker + " " + m.providerDot(prov) + " " + label + " " + hintStyle.Render(padRight(prov, 9)+" "+model) + "\n")
	}
	if focused {
		b.WriteString("  " + hintStyle.Render("↵ change model · provider"))
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m dashboardModel) providerDot(provider string) string {
	if m.sys.agent.Health == nil {
		return hintStyle.Render("·")
	}
	var h *contract.AgentProviderHealth
	switch provider {
	case "opencode":
		h = m.sys.agent.Health.Opencode
	case "codex":
		h = m.sys.agent.Health.Codex
	}
	if h == nil {
		return hintStyle.Render("·")
	}
	return healthDot(h.Status)
}

// renderSignals is the integrity panel — the anti-Goodhart readout. It juxtaposes the
// ground-truth value-oracle (◆, real: do the tests catch injected bugs?) against the proxy
// the rest of the board shows everywhere (◇ pass rate), and states precisely where
// change-coverage stands: measured per run, but not yet a fleet-level merge gate (⚠) —
// the keystone. Every number is real or honestly absent; nothing inert is dressed up.
func (m dashboardModel) renderSignals(w int) string {
	var b strings.Builder
	b.WriteString(labelRule(w, "signals", renderSegs("", sg("◆ truth ", colPass), sg("◇ proxy", colFlaky))) + "\n")

	// ◆ value oracle — ground truth.
	oracle := shadowStyle.Render("not measured yet ⚠")
	if m.signals != nil && m.signals.ValueOracle.Measured && m.signals.ValueOracle.AvgScore != nil {
		oracle = renderSegs("", sg("◆ ", colPass)) + okStyle.Render(fmt.Sprintf("%.2f", *m.signals.ValueOracle.AvgScore)) +
			hintStyle.Render("  "+pluralize(m.signals.ValueOracle.MeasuredRuns, "run", "runs"))
	}
	b.WriteString("  " + labelStyle.Render(padRight("value oracle", 13)) + " " + oracle + "\n")

	// ◇ reviewer — the proxy gate (pass rate over quality-verdict runs).
	proxy := hintStyle.Render("reviewer · LLM ") + renderSegs("", sg("◇", colFlaky))
	if m.signals != nil && m.signals.Reviewer.PassRate != nil {
		proxy = renderSegs("", sg("◇ ", colFlaky)) + hintStyle.Render(fmt.Sprintf("%.0f%% pass  %s", *m.signals.Reviewer.PassRate*100, pluralize(m.signals.Reviewer.Runs, "run", "runs")))
	}
	b.WriteString("  " + labelStyle.Render(padRight("reviewer", 13)) + " " + proxy + "\n")

	// change-coverage IS measured per run (the live run shows covered/changed lines); what
	// is not built yet is using it as a fleet-level MERGE GATE — the keystone. Say exactly
	// that, so this never contradicts the live run that displays a coverage %.
	b.WriteString("  " + labelStyle.Render(padRight("coverage", 13)) + " " + hintStyle.Render("per run") + shadowStyle.Render(" · gate not built ⚠"))
	return b.String()
}

// renderRecent is the cross-fleet outcome feed: the most recent runs, newest first.
func (m dashboardModel) renderRecent(w int) string {
	var all []contract.RunRecord
	for _, runs := range m.fleet {
		all = append(all, runs...)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].At > all[j].At })

	var b strings.Builder
	b.WriteString(labelRule(w, "recent", "") + "\n")
	if len(all) == 0 {
		return b.String() + "  " + hintStyle.Render("no runs yet")
	}
	for i, r := range all {
		if i >= 6 {
			break
		}
		b.WriteString("  " + recentLine(r) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func recentLine(r contract.RunRecord) string {
	st := runVerdictStyle(r.Verdict)
	v := "…"
	if r.Verdict != nil {
		v = string(*r.Verdict)
	}
	return st.Render(runVerdictIcon(r.Verdict)) + "  " +
		labelStyle.Render(padRight(r.App, 12)) + " " +
		hintStyle.Render(padRight(string(r.Mode), 6)) + " " +
		st.Render(padRight(v, 8)) + " " +
		hintStyle.Render(relativeTime(r.At))
}
