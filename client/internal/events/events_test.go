package events

import (
	"reflect"
	"testing"
)

// Each sample is the SSE `data:` payload the orchestrator emits (RunEventStore →
// {seq,runId,ts,body}). Decoding them through Decode ties the hand-written decoder
// to the contract (src/contract/events.ts) so a variant cannot drift.
func TestDecodeRunEventVariants(t *testing.T) {
	cases := []struct {
		name string
		json string
		typ  string
		want any
	}{
		{"run.started", `{"seq":0,"runId":"r1","ts":1,"body":{"type":"run.started","app":"portfolio","sha":"abc","mode":"diff","target":"e2e"}}`, "run.started", RunStarted{App: "portfolio", Sha: "abc", Mode: "diff", Target: "e2e"}},
		{"step.changed", `{"seq":1,"runId":"r1","ts":1,"body":{"type":"step.changed","step":"generate","detail":"x"}}`, "step.changed", StepChanged{Step: "generate", Detail: "x"}},
		{"agent.activity", `{"seq":2,"runId":"r1","ts":1,"body":{"type":"agent.activity","kind":"analyzing","target":"Header.astro","status":"running","callId":"c1"}}`, "agent.activity", AgentActivity{Kind: "analyzing", Target: "Header.astro", Status: "running", CallID: "c1"}},
		{"plan.updated", `{"seq":3,"runId":"r1","ts":1,"body":{"type":"plan.updated","todos":[{"content":"a","status":"in_progress"}]}}`, "plan.updated", PlanUpdated{Todos: []PlanTodo{{Content: "a", Status: "in_progress"}}}},
		{"test.passed", `{"seq":4,"runId":"r1","ts":1,"body":{"type":"test.passed","name":"login","durationMs":1200}}`, "test.passed", TestPassed{Name: "login", DurationMs: 1200}},
		{"test.failed", `{"seq":5,"runId":"r1","ts":1,"body":{"type":"test.failed","name":"cart","durationMs":800,"detail":"boom"}}`, "test.failed", TestFailed{Name: "cart", DurationMs: 800, Detail: "boom"}},
		{"run.verdict", `{"seq":6,"runId":"r1","ts":1,"body":{"type":"run.verdict","verdict":"pass","passed":3,"failed":0}}`, "run.verdict", RunVerdict{Verdict: "pass", Passed: 3, Failed: 0}},
		{"log.line", `{"seq":7,"runId":"r1","ts":1,"body":{"type":"log.line","level":"info","text":"hi"}}`, "log.line", LogLine{Level: "info", Text: "hi"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev, err := Decode([]byte(tc.json))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if ev.Type != tc.typ {
				t.Fatalf("type: got %q want %q", ev.Type, tc.typ)
			}
			if !reflect.DeepEqual(ev.Body, tc.want) {
				t.Fatalf("body: got %#v want %#v", ev.Body, tc.want)
			}
		})
	}
}

func TestDecodeEnvelopeFields(t *testing.T) {
	ev, err := Decode([]byte(`{"seq":7,"runId":"r9","ts":42,"body":{"type":"test.started","name":"nav"}}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if ev.Seq != 7 || ev.RunID != "r9" || ev.Ts != 42 {
		t.Fatalf("envelope: %+v", ev)
	}
	if b, ok := ev.Body.(TestStarted); !ok || b.Name != "nav" {
		t.Fatalf("body: %#v", ev.Body)
	}
}

// Tolerant reader: a body type this build does not know becomes UnknownEvent, not
// an error — a newer server must never break an older binary.
func TestDecodeUnknownTypeIsTolerant(t *testing.T) {
	ev, err := Decode([]byte(`{"seq":9,"runId":"r1","ts":1,"body":{"type":"future.thing","x":1}}`))
	if err != nil {
		t.Fatalf("unknown type must not error: %v", err)
	}
	if u, ok := ev.Body.(UnknownEvent); !ok || u.Type != "future.thing" {
		t.Fatalf("want UnknownEvent future.thing, got %#v", ev.Body)
	}
}

func TestDecodeMalformedErrors(t *testing.T) {
	if _, err := Decode([]byte(`not json`)); err == nil {
		t.Fatal("want error on malformed json")
	}
}
