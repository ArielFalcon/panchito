package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/api"
	"github.com/ArielFalcon/panchito/internal/contract"
	tea "github.com/charmbracelet/bubbletea"
)

func vptr(v contract.RunRecordVerdict) *contract.RunRecordVerdict { return &v }

func TestSparkline(t *testing.T) {
	if sparkline(nil) != "" {
		t.Fatal("empty series must render empty")
	}
	if asc := sparkline([]float64{0, 1, 2, 3, 4, 5, 6, 7}); asc != "▁▂▃▄▅▆▇█" {
		t.Fatalf("ascending sparkline = %q", asc)
	}
	if flat := sparkline([]float64{3, 3, 3}); flat != "▅▅▅" {
		t.Fatalf("flat sparkline = %q, want the mid-ramp glyph repeated", flat)
	}
	// Fixed-range: a semantic 0..1 score must read full when high, low when low.
	if hi := sparklineRange([]float64{1, 1, 1}, 0, 1); hi != "███" {
		t.Fatalf("all-high fixed sparkline = %q, want ███", hi)
	}
	if lo := sparklineRange([]float64{0, 0}, 0, 1); lo != "▁▁" {
		t.Fatalf("all-low fixed sparkline = %q, want ▁▁", lo)
	}
}

func TestComputeFleetStats(t *testing.T) {
	// newest-first, as ListRuns returns: pass (newest) · fail · pass (oldest)
	runs := []contract.RunRecord{
		{Verdict: vptr(contract.RunRecordVerdictPass)},
		{Verdict: vptr(contract.RunRecordVerdictFail)},
		{Verdict: vptr(contract.RunRecordVerdictPass)},
	}
	st := computeFleetStats(runs, fleetWindow)
	if st.total != 3 || st.passes != 2 {
		t.Fatalf("total=%d passes=%d, want 3/2", st.total, st.passes)
	}
	if st.passRate < 0.66 || st.passRate > 0.67 {
		t.Fatalf("passRate = %.3f, want ~0.667", st.passRate)
	}
	if len([]rune(st.spark)) != 3 {
		t.Fatalf("spark width = %d, want 3", len([]rune(st.spark)))
	}
	// last must be oldest→newest: pass, fail, pass
	if len(st.last) != 3 || st.last[1] == nil || *st.last[1] != contract.RunRecordVerdictFail {
		t.Fatalf("last verdicts not oldest→newest: %+v", st.last)
	}
}

func TestComputeFleetStatsEmpty(t *testing.T) {
	if st := computeFleetStats(nil, fleetWindow); st.total != 0 || st.passRate != 0 || st.spark != "" {
		t.Fatalf("empty stats = %+v", st)
	}
}

func dashWith(apps []contract.AppView) dashboardModel {
	m := newDashboardModel(api.New("http://x", ""))
	m.sys.apps = apps
	m.width = 100
	m.loading = false
	return m
}

func TestDashboardRendersSections(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}, {Name: "panchito", Code: true}})
	m.fleet = map[string][]contract.RunRecord{
		"portfolio": {{App: "portfolio", Verdict: vptr(contract.RunRecordVerdictPass), At: "2026-06-13T14:00:00Z"}},
	}
	out := m.View()
	for _, want := range []string{"FLEET", "portfolio", "panchito", "MODELS", "SIGNALS", "RECENT", "proxy", "⚠"} {
		if !strings.Contains(out, want) {
			t.Fatalf("dashboard missing %q:\n%s", want, out)
		}
	}
}

func TestDashboardEnterQuickLaunchesSelectedApp(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}}) // an e2e app; default mode diff
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter must emit a command")
	}
	msg, ok := cmd().(launchMsg)
	if !ok {
		t.Fatalf("enter should fire a direct launch with the in-place config, got %#v", cmd())
	}
	if msg.input.App != "portfolio" || string(msg.input.Mode) != "diff" || string(msg.input.Target) != "e2e" {
		t.Fatalf("launch config wrong: %+v", msg.input)
	}
}

func TestDashboardFleetCyclesModeAndTarget(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}}) // e2e app → natural target e2e
	// → advances the mode (diff → complete); t flips the target to code.
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRight})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("t")})
	// complete is a heavy mode → the first Enter arms a confirmation, the second launches.
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil || !m.launchArmed {
		t.Fatalf("a heavy mode's first Enter must arm a confirm, not launch (armed=%v cmd=%v)", m.launchArmed, cmd)
	}
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	msg, ok := cmd().(launchMsg)
	if !ok {
		t.Fatalf("the second Enter should launch, got %#v", cmd())
	}
	if string(msg.input.Mode) != "complete" || string(msg.input.Target) != "code" {
		t.Fatalf("← →/t must edit the launch config: %+v", msg.input)
	}
}

// A heavy mode must not launch on a single Enter, and any other key cancels the armed state.
func TestDashboardHeavyModeConfirmCancels(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m.launchMode = "exhaustive"
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !m.launchArmed {
		t.Fatal("first Enter on a heavy mode must arm the confirm")
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")}) // any other key
	if m.launchArmed || cmd != nil {
		t.Fatalf("a non-Enter key must cancel the armed confirm (armed=%v)", m.launchArmed)
	}
}

func TestDashboardManualModeRoutesToWizard(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m.launchMode = "manual" // manual needs a guidance string → the full wizard
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if _, ok := cmd().(appSelectedMsg); !ok {
		t.Fatalf("manual mode must open the launcher wizard, got %#v", cmd())
	}
}

func TestDashboardTabFocusesModelsAndEnterOpensSwitcher(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab})
	if m.focus != focusModels {
		t.Fatalf("tab must move focus to MODELS, got %d", m.focus)
	}
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if _, ok := cmd().(agentSelectedMsg); !ok {
		t.Fatalf("enter on MODELS must open the agent switcher, got %#v", cmd())
	}
}

func TestDashboardSignalsRenderGroundTruthVsProxy(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	avg := float32(0.82)
	pass := float32(0.9)
	m.signals = &contract.SignalsView{}
	m.signals.ValueOracle.Measured = true
	m.signals.ValueOracle.AvgScore = &avg
	m.signals.ValueOracle.MeasuredRuns = 7
	m.signals.Reviewer.PassRate = &pass
	m.signals.Reviewer.Runs = 10
	out := m.renderSignals(96)
	// ◆ value-oracle truth, ◇ proxy pass-rate, and coverage stated precisely (measured per
	// run, not yet a gate) — never a flat "not measured" that contradicts the live run.
	for _, want := range []string{"0.82", "90% pass", "per run", "gate not built ⚠"} {
		if !strings.Contains(out, want) {
			t.Fatalf("signals readout missing %q:\n%s", want, out)
		}
	}
}

func TestDashboardEnterWatchesRunningApp(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m.sys.queue.Running = &struct {
		App string `json:"app"`
		Id  string `json:"id"`
	}{App: "portfolio", Id: "run_9"}
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter must emit a command")
	}
	if msg, ok := cmd().(watchRunMsg); !ok || msg.id != "run_9" {
		t.Fatalf("enter on the running app should watch it, got %#v", cmd())
	}
}

func TestDashboardCursorNavigation(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "a"}, {Name: "b"}})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")})
	if m.cursor != 1 {
		t.Fatalf("cursor after down = %d, want 1 (app b)", m.cursor)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("j")}) // → the onboard row
	if m.focus != focusFleet || m.cursor != 2 {
		t.Fatalf("down past the last project should reach the onboard row (cursor=2); focus=%d cursor=%d", m.focus, m.cursor)
	}
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("k")})
	if m.cursor != 1 {
		t.Fatalf("cursor after up from onboard = %d, want 1", m.cursor)
	}
}

// The classic menu is retired from the dashboard (the board IS the home surface), so 'm'
// is no longer a binding — it must be an inert no-op, not open the redundant screen.
func TestDashboardMenuKeyRetired(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("m")})
	if cmd != nil {
		t.Fatalf("'m' must be a no-op now that the classic menu is retired, got %#v", cmd())
	}
}

// The dashboard is the single home surface now, so its keys must emit the destination
// messages the retired menu used to (onboard / edit / delete / agents).
func TestDashboardActionKeysEmitDestinations(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	cases := []struct {
		key  string
		want any
	}{
		{"o", onboardSelectedMsg{}},
		{"a", agentSelectedMsg{}},
		{"e", editAppMsg{}},
		{"d", deleteAppMsg{}},
	}
	for _, c := range cases {
		_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(c.key)})
		if cmd == nil {
			t.Fatalf("key %q must emit a command", c.key)
		}
		switch c.want.(type) {
		case onboardSelectedMsg:
			if _, ok := cmd().(onboardSelectedMsg); !ok {
				t.Fatalf("key %q → %T, want onboardSelectedMsg", c.key, cmd())
			}
		case agentSelectedMsg:
			if _, ok := cmd().(agentSelectedMsg); !ok {
				t.Fatalf("key %q → %T, want agentSelectedMsg", c.key, cmd())
			}
		case editAppMsg:
			if msg, ok := cmd().(editAppMsg); !ok || msg.app.Name != "portfolio" {
				t.Fatalf("key %q → %T, want editAppMsg{portfolio}", c.key, cmd())
			}
		case deleteAppMsg:
			if msg, ok := cmd().(deleteAppMsg); !ok || msg.app.Name != "portfolio" {
				t.Fatalf("key %q → %T, want deleteAppMsg{portfolio}", c.key, cmd())
			}
		}
	}
}

func firstLabel(as []paletteAction) string {
	if len(as) == 0 {
		return ""
	}
	return as[0].label
}

func TestDashboardPaletteOpensFiltersAndRuns(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(":")})
	if !m.paletteActive {
		t.Fatal("':' must open the command palette")
	}
	m.paletteInput.SetValue("agents")
	acts := m.filteredActions()
	if len(acts) == 0 || !strings.Contains(acts[0].label, "agents") {
		t.Fatalf("filter 'agents' → %d actions, first=%q", len(acts), firstLabel(acts))
	}
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter in the palette must emit a command")
	}
	if _, ok := cmd().(agentSelectedMsg); !ok {
		t.Fatalf("palette enter should run agents, got %#v", cmd())
	}
}

func TestDashboardPaletteEscCloses(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(":")})
	if m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc}); m.paletteActive {
		t.Fatal("esc must close the palette")
	}
}

func TestDashboardEventTailFromRunningRecord(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m.sys.queue.Running = &struct {
		App string `json:"app"`
		Id  string `json:"id"`
	}{App: "portfolio", Id: "run_1"}
	acts := []contract.AgentActivity{{Kind: "file", Text: "e2e/checkout.spec.ts"}}
	m.sys.running = &contract.RunRecord{App: "portfolio", Activity: &acts}
	if tail := m.runActivityTail(96); !strings.Contains(tail, "checkout.spec.ts") {
		t.Fatalf("event tail missing the activity:\n%s", tail)
	}
}

func TestDashboardColumnsRenderNarrow(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	m.width = 50 // contentWidth ~46, below the 72 threshold → columns stack
	out := m.View()
	for _, want := range []string{"MODELS", "SIGNALS", "FLEET"} {
		if !strings.Contains(out, want) {
			t.Fatalf("narrow dashboard missing %q:\n%s", want, out)
		}
	}
}
