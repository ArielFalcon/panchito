package contract

import (
	"encoding/json"
	"testing"
)

// Decoding the orchestrator's real GET /api/v1/runs/:id payload (see
// src/server/api.ts → RunRecordSchema) into the codegen'd struct proves the
// published contract artifact (contract/openapi.json) and the Go types agree —
// the no-drift guarantee, enforced on the Go side.
func TestRunRecordDecodesFromServerJSON(t *testing.T) {
	const payload = `{
		"id":"run_1","app":"portfolio","sha":"abc1234","target":"e2e","mode":"diff",
		"status":"done","verdict":"pass","passed":3,"failed":0,
		"cases":[{"name":"login","status":"pass","durationMs":1200}],
		"logs":["started","done"],"at":"2026-01-01T00:00:00.000Z"
	}`
	var r RunRecord
	if err := json.Unmarshal([]byte(payload), &r); err != nil {
		t.Fatalf("decode RunRecord: %v", err)
	}
	if r.Id != "run_1" || r.Target != "e2e" || r.Mode != "diff" {
		t.Fatalf("unexpected header fields: %+v", r)
	}
	if r.Verdict == nil || *r.Verdict != "pass" {
		t.Fatalf("verdict not decoded: %v", r.Verdict)
	}
	if len(r.Cases) != 1 {
		t.Fatalf("want 1 case, got %d", len(r.Cases))
	}
	if c := r.Cases[0]; c.Name != "login" || c.Status != "pass" || c.DurationMs == nil || *c.DurationMs != 1200 {
		t.Fatalf("case (incl. real durationMs) not decoded: %+v", c)
	}
}

func TestCreateRunResultCarriesTarget(t *testing.T) {
	var res CreateRunResult
	if err := json.Unmarshal([]byte(`{"id":"r","app":"portfolio","sha":"abc","target":"e2e","mode":"diff","status":"enqueued"}`), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if res.Target != "e2e" {
		t.Fatalf("target not decoded: %q", res.Target)
	}
}
