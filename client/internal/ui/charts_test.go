package ui

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/ArielFalcon/panchito/internal/contract"
)

func f32(v float32) *float32 { return &v }

func unitPtr(u string) *contract.ReportInsightUnit {
	x := contract.ReportInsightUnit(u)
	return &x
}

// insightFromJSON decodes a wire-shape insight — the anonymous breakdown struct carries json tags,
// so building it from JSON is cleaner (and exercises the real decode path) than a literal.
func insightFromJSON(t *testing.T, js string) contract.ReportInsight {
	t.Helper()
	var ins contract.ReportInsight
	if err := json.Unmarshal([]byte(js), &ins); err != nil {
		t.Fatalf("decode insight: %v", err)
	}
	return ins
}

func TestFmtValueByUnit(t *testing.T) {
	cases := []struct {
		v    *float32
		unit string
		want string
	}{
		{f32(0.82), "ratio", "82%"},
		{f32(73), "percent", "73%"},
		{f32(1200), "ms", "1.2s"},
		{f32(125000), "ms", "2m05s"},
		{f32(8), "count", "8"},
		{f32(2.5), "score", "2.5"},
		{nil, "ratio", "—"}, // absence is an em dash, never a fabricated zero
	}
	for _, c := range cases {
		got := fmtValue(c.v, unitPtr(c.unit))
		if got != c.want {
			t.Errorf("fmtValue(%v, %q) = %q, want %q", c.v, c.unit, got, c.want)
		}
	}
}

func TestInsightColorGaugeVsTarget(t *testing.T) {
	// A coverage gauge (goodWhen up) that meets its target is good; below target is bad.
	meets := contract.ReportInsight{Value: f32(0.8), Target: f32(0.7), GoodWhen: "up"}
	if got := insightColor(meets); got != colPass {
		t.Errorf("meeting target should be colPass, got %v", got)
	}
	misses := contract.ReportInsight{Value: f32(0.4), Target: f32(0.7), GoodWhen: "up"}
	if got := insightColor(misses); got != colFail {
		t.Errorf("missing target should be colFail, got %v", got)
	}
	// A flaky rate (goodWhen down) rising is bad.
	rising := contract.ReportInsight{Direction: "up", GoodWhen: "down"}
	if got := insightColor(rising); got != colFail {
		t.Errorf("a rising bad-metric should be colFail, got %v", got)
	}
	// A neutral metric stays foreground.
	if got := insightColor(contract.ReportInsight{GoodWhen: "neutral", Direction: "up"}); got != colFg {
		t.Errorf("neutral should be colFg, got %v", got)
	}
}

func TestRenderInsightFullByIntent(t *testing.T) {
	composition := insightFromJSON(t, `{
		"id":"case-mix","title":"Case results","intent":"composition","chart":"donut",
		"value":3,"unit":"count","delta":null,"multiplier":null,"direction":"flat","goodWhen":"neutral",
		"caption":"3/3 passed","score":2,
		"breakdown":[{"label":"pass","value":3,"semantic":"good"},{"label":"fail","value":0,"semantic":"bad"}]}`)
	out := renderInsightFull(composition, 80)
	for _, want := range []string{"CASE RESULTS", "pass", "3/3 passed"} { // labelRule upper-cases the title
		if !strings.Contains(out, want) {
			t.Errorf("composition render missing %q in:\n%s", want, out)
		}
	}

	distribution := insightFromJSON(t, `{
		"id":"flow-results","title":"Flows that misbehaved","intent":"distribution","chart":"ranked-bars",
		"value":2,"unit":"count","delta":null,"multiplier":null,"direction":"flat","goodWhen":"down","score":1.8,
		"breakdown":[{"label":"checkout","value":2,"semantic":"bad"}]}`)
	if out := renderInsightFull(distribution, 80); !strings.Contains(out, "checkout") {
		t.Errorf("distribution render missing label:\n%s", out)
	}

	trend := insightFromJSON(t, `{
		"id":"change-coverage","title":"Change-coverage","intent":"trend","chart":"line",
		"value":0.82,"unit":"ratio","target":0.7,"delta":0.1,"multiplier":null,"direction":"up","goodWhen":"up",
		"series":[0.6,0.7,0.82],"score":1.2}`)
	out = renderInsightFull(trend, 80)
	for _, want := range []string{"CHANGE-COVERAGE", "now", "82%", "target"} {
		if !strings.Contains(out, want) {
			t.Errorf("trend render missing %q in:\n%s", want, out)
		}
	}

	single := insightFromJSON(t, `{
		"id":"suite-duration","title":"Suite duration","intent":"single-value","chart":"big-number",
		"value":4300,"unit":"ms","delta":null,"multiplier":null,"direction":"flat","goodWhen":"down","score":0.3}`)
	if out := renderInsightFull(single, 80); !strings.Contains(out, "4.3s") {
		t.Errorf("single-value render missing formatted duration:\n%s", out)
	}
}

func TestRenderGaugeNotMeasured(t *testing.T) {
	ins := contract.ReportInsight{Value: nil, Unit: unitPtr("ratio"), GoodWhen: "up", Intent: "single-value"}
	if out := renderGauge(ins, 40); !strings.Contains(out, "not measured") {
		t.Errorf("a nil value should render 'not measured', got %q", out)
	}
}

func TestRenderReportSummaryHeadlineAndTopK(t *testing.T) {
	var view contract.ReportView
	js := `{"app":"demo","generatedAt":"2026-06-14T10:00:00Z","headline":"PASS — 3/3 cases green",
		"window":{"current":1,"previous":0},
		"insights":[
		  {"id":"case-mix","title":"Case results","intent":"composition","chart":"donut","value":3,"unit":"count","delta":null,"multiplier":null,"direction":"flat","goodWhen":"neutral","score":2,"breakdown":[{"label":"pass","value":3,"semantic":"good"}]},
		  {"id":"change-coverage","title":"Change-coverage","intent":"single-value","chart":"gauge","value":0.82,"unit":"ratio","target":0.7,"delta":null,"multiplier":null,"direction":"flat","goodWhen":"up","score":1.5},
		  {"id":"value-oracle","title":"Value-oracle","intent":"single-value","chart":"gauge","value":0.9,"unit":"ratio","delta":null,"multiplier":null,"direction":"flat","goodWhen":"up","score":0.7},
		  {"id":"suite-duration","title":"Suite duration","intent":"single-value","chart":"big-number","value":4300,"unit":"ms","delta":null,"multiplier":null,"direction":"flat","goodWhen":"down","score":0.3}]}`
	if err := json.Unmarshal([]byte(js), &view); err != nil {
		t.Fatal(err)
	}
	out := renderReportSummary(view, 80, 3)
	if !strings.Contains(out, "PASS — 3/3 cases green") {
		t.Errorf("summary missing headline:\n%s", out)
	}
	if !strings.Contains(out, "r open") {
		t.Errorf("summary missing the 'r open' hint:\n%s", out)
	}
	// Top-3 only: the 4th insight (suite-duration) must not appear.
	if strings.Contains(out, "SUITE DURATION") {
		t.Errorf("summary should cap at top-K (3), but rendered the 4th insight:\n%s", out)
	}
	// Compact composition lists its slices.
	if !strings.Contains(out, "pass") {
		t.Errorf("summary case-mix should list slices:\n%s", out)
	}
}

func TestRenderReportDetailEmpty(t *testing.T) {
	view := contract.ReportView{App: "demo", Headline: "nothing"}
	if out := renderReportDetail(view, 80); !strings.Contains(out, "no insights") {
		t.Errorf("empty report should say so, got %q", out)
	}
}
