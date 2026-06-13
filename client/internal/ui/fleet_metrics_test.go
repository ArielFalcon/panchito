package ui

import (
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
)

// The FLEET pass-rate (history) and NOW's pipeline progress are both rendered as "NN%",
// which made "FLEET 0% vs NOW 38%" read as a contradiction. A project that is currently
// running must show its LIVE progress in FLEET (matching NOW), never the historical
// pass-rate of its past runs.
func TestFleetRunningRowShowsLiveProgressNotPassRate(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "petclinic"}})
	m.sys.queue.Running = &struct {
		App string `json:"app"`
		Id  string `json:"id"`
	}{App: "petclinic", Id: "r1"}
	step := "generate"
	m.sys.running = &contract.RunRecord{App: "petclinic", Step: &step}
	// A history that computes a 0% pass-rate (all skipped) — the misleading number the
	// running row must NOT surface while the run is in flight.
	sk := contract.RunRecordVerdictSkipped
	m.fleet = map[string][]contract.RunRecord{"petclinic": {{Verdict: &sk}, {Verdict: &sk}}}

	out := m.renderFleet(90)

	if !strings.Contains(out, "generate") {
		t.Fatalf("running row must show the live phase; got:\n%s", out)
	}
	if !strings.Contains(out, "38%") {
		t.Fatalf("running row must show live progress (38%%, matching NOW); got:\n%s", out)
	}
	if strings.Contains(out, "0%") {
		t.Fatalf("running row must NOT show the historical 0%% pass-rate (the contradiction); got:\n%s", out)
	}
}

// An idle project's "NN%" is a pass-rate, not progress. Label it so the two NN% readouts on
// the board are never confused.
func TestFleetIdleRowLabelsPassRate(t *testing.T) {
	m := dashWith([]contract.AppView{{Name: "portfolio"}})
	p := contract.RunRecordVerdictPass
	m.fleet = map[string][]contract.RunRecord{"portfolio": {{Verdict: &p}, {Verdict: &p}}}

	out := m.renderFleet(90)

	if !strings.Contains(out, "pass") {
		t.Fatalf("idle row should label its pass-rate (e.g. \"100%% pass\") to disambiguate from progress; got:\n%s", out)
	}
}
