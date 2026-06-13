// Package events decodes the RunEvent SSE stream. RunEventBody is a 15-variant
// discriminated union that does not codegen into idiomatic Go (a oneOf without an
// OpenAPI discriminator), so the envelope + variants are hand-written here — in
// their own package to avoid name clashes with the codegen'd command types in
// internal/contract (both have an "AgentActivity", different concepts). The
// contract stays the source of truth: events_test.go round-trips canonical server
// JSON (matching src/contract/events.ts) to catch drift. See docs/tui-vnext.md §4.
package events

import (
	"encoding/json"
	"fmt"
)

// RunEvent is the SSE envelope. Body is one of the variant types below — or
// UnknownEvent for a `type` this build does not know (tolerant reader: a newer
// server never breaks an older binary). Bubble Tea's Update switches on Body's
// concrete type.
type RunEvent struct {
	Seq   int
	RunID string
	Ts    int64
	Type  string
	Body  any
}

type RunStarted struct {
	App    string `json:"app"`
	Sha    string `json:"sha"`
	Mode   string `json:"mode"`
	Target string `json:"target"`
}

type StepChanged struct {
	Step   string `json:"step"`
	Detail string `json:"detail"`
}

type AgentActivity struct {
	Kind     string `json:"kind"` // analyzing | writing | command | subagent
	Target   string `json:"target"`
	Status   string `json:"status"` // running | completed
	CallID   string `json:"callId"`
	WorkerID string `json:"workerId"`
}

type PlanTodo struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

type PlanUpdated struct {
	Todos []PlanTodo `json:"todos"`
}

type SpecWritten struct {
	File string `json:"file"`
}

type TestDiscovered struct {
	Name string `json:"name"`
	File string `json:"file"`
}

type TestStarted struct {
	Name string `json:"name"`
}

type TestPassed struct {
	Name       string  `json:"name"`
	DurationMs float64 `json:"durationMs"`
}

type TestFailed struct {
	Name       string  `json:"name"`
	DurationMs float64 `json:"durationMs"`
	Detail     string  `json:"detail"`
}

type TestFlaky struct {
	Name     string `json:"name"`
	Attempts int    `json:"attempts"`
}

type ReviewerVerdict struct {
	Approved bool     `json:"approved"`
	Reasons  []string `json:"reasons"`
}

type CoverageComputed struct {
	ChangedLines int `json:"changedLines"`
	CoveredLines int `json:"coveredLines"`
}

type RunVerdict struct {
	Verdict string `json:"verdict"`
	Passed  int    `json:"passed"`
	Failed  int    `json:"failed"`
	Outcome string `json:"outcome"` // what the run produced — "suite PR merged · <url>", "Issue filed · <url>"
}

type AgentError struct {
	Detail string `json:"detail"`
}

type LogLine struct {
	Level string `json:"level"`
	Text  string `json:"text"`
}

// UnknownEvent carries a body type this build does not recognize, so the TUI can
// ignore it instead of erroring (tolerant-reader / additive contract evolution).
type UnknownEvent struct {
	Type string
	Raw  json.RawMessage
}

// Decode parses one SSE `data:` payload into a RunEvent. It errors only on
// malformed JSON or a missing discriminator — never on an unknown event type.
func Decode(data []byte) (RunEvent, error) {
	var env struct {
		Seq   int             `json:"seq"`
		RunID string          `json:"runId"`
		Ts    int64           `json:"ts"`
		Body  json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return RunEvent{}, fmt.Errorf("decode RunEvent envelope: %w", err)
	}
	var disc struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(env.Body, &disc); err != nil {
		return RunEvent{}, fmt.Errorf("decode RunEvent discriminator: %w", err)
	}
	body, err := decodeBody(disc.Type, env.Body)
	if err != nil {
		return RunEvent{}, err
	}
	return RunEvent{Seq: env.Seq, RunID: env.RunID, Ts: env.Ts, Type: disc.Type, Body: body}, nil
}

func decodeBody(t string, raw json.RawMessage) (any, error) {
	switch t {
	case "run.started":
		return into[RunStarted](raw)
	case "step.changed":
		return into[StepChanged](raw)
	case "agent.activity":
		return into[AgentActivity](raw)
	case "plan.updated":
		return into[PlanUpdated](raw)
	case "spec.written":
		return into[SpecWritten](raw)
	case "test.discovered":
		return into[TestDiscovered](raw)
	case "test.started":
		return into[TestStarted](raw)
	case "test.passed":
		return into[TestPassed](raw)
	case "test.failed":
		return into[TestFailed](raw)
	case "test.flaky":
		return into[TestFlaky](raw)
	case "reviewer.verdict":
		return into[ReviewerVerdict](raw)
	case "coverage.computed":
		return into[CoverageComputed](raw)
	case "run.verdict":
		return into[RunVerdict](raw)
	case "agent.error":
		return into[AgentError](raw)
	case "log.line":
		return into[LogLine](raw)
	default:
		return UnknownEvent{Type: t, Raw: raw}, nil
	}
}

func into[T any](raw json.RawMessage) (any, error) {
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("decode RunEvent body: %w", err)
	}
	return v, nil
}
