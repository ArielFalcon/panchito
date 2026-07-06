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

// Decoding the orchestrator's real GET /api/v1/apps/:name/boundaries/propose/status
// payload (see src/server/onboarding/onboarding-job.ts → OnboardingJobStatusSchema)
// into the codegen'd struct — the same no-drift guarantee as RunRecord above, now for
// the boundary-onboarding job's poll DTO. Two shapes: a winner (outcome + resolvedProfile
// set) and a no-profile completion (outcome set, resolvedProfile absent).
func TestOnboardingJobStatusDecodesWinnerFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"done","app":"shop","round":2,"ceiling":3,"candidatesScored":5,
		"lastResolvedScore":0.92,
		"resolvedProfile":{
			"transport":"http","frontFiles":"src/api/shop.ts",
			"frontCallSite":{"kind":"fetch","receiver":"shopClient"},
			"servicePrefixTemplate":"/api/shop","serviceRepoTemplate":"org/shop-svc",
			"openApiPath":"openapi/shop.yaml"
		},
		"outcome":"winner",
		"startedAt":"2026-07-06T00:00:00.000Z","finishedAt":"2026-07-06T00:02:00.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (winner): %v", err)
	}
	if s.State != OnboardingJobStatusStateDone || s.App == nil || *s.App != "shop" || s.Round != 2 || s.Ceiling != 3 || s.CandidatesScored != 5 {
		t.Fatalf("unexpected header fields: %+v", s)
	}
	if s.Outcome == nil || *s.Outcome != Winner {
		t.Fatalf("outcome not decoded: %v", s.Outcome)
	}
	if s.ResolvedProfile == nil {
		t.Fatalf("resolvedProfile not decoded")
	}
	profile, err := s.ResolvedProfile.AsOnboardingJobStatusResolvedProfile0()
	if err != nil {
		t.Fatalf("resolvedProfile did not decode as the http variant: %v", err)
	}
	if profile.Transport != Http || profile.FrontFiles != "src/api/shop.ts" || profile.ServiceRepoTemplate != "org/shop-svc" {
		t.Fatalf("http profile fields: %+v", profile)
	}
	if profile.FrontCallSite.Receiver == nil || *profile.FrontCallSite.Receiver != "shopClient" {
		t.Fatalf("frontCallSite.receiver not decoded: %+v", profile.FrontCallSite)
	}
}

// Decoding the event-variant resolvedProfile — the transport:"event" shape a service-to-service
// (class-based-domain-events) winner carries, as opposed to the http shape covered above. This
// exercises AsOnboardingJobStatusResolvedProfile1(), which the winner-http test above never touches.
func TestOnboardingJobStatusDecodesEventWinnerFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"done","app":"shop","round":1,"ceiling":3,"candidatesScored":4,
		"lastResolvedScore":0.88,
		"resolvedProfile":{
			"transport":"event","files":"src/events/ShopEventListener.java",
			"eventPattern":{
				"kind":"class-based-domain-events",
				"listenerBaseType":"DomainEventListener",
				"listenerEventCall":"onEvent",
				"subscriberBaseType":"DomainEventSubscriber",
				"publishCall":"eventPublisher.publish"
			}
		},
		"outcome":"winner",
		"startedAt":"2026-07-06T00:00:00.000Z","finishedAt":"2026-07-06T00:01:30.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (event winner): %v", err)
	}
	if s.Outcome == nil || *s.Outcome != Winner {
		t.Fatalf("outcome not decoded: %v", s.Outcome)
	}
	if s.ResolvedProfile == nil {
		t.Fatalf("resolvedProfile not decoded")
	}
	profile, err := s.ResolvedProfile.AsOnboardingJobStatusResolvedProfile1()
	if err != nil {
		t.Fatalf("resolvedProfile did not decode as the event variant: %v", err)
	}
	if profile.Transport != Event || profile.Files != "src/events/ShopEventListener.java" {
		t.Fatalf("event profile fields: %+v", profile)
	}
	if profile.EventPattern.Kind != "class-based-domain-events" ||
		profile.EventPattern.ListenerBaseType != "DomainEventListener" ||
		profile.EventPattern.ListenerEventCall != "onEvent" ||
		profile.EventPattern.SubscriberBaseType != "DomainEventSubscriber" ||
		profile.EventPattern.PublishCall != "eventPublisher.publish" {
		t.Fatalf("eventPattern fields not decoded: %+v", profile.EventPattern)
	}
}

func TestOnboardingJobStatusDecodesNoProfileFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"done","app":"shop","round":3,"ceiling":3,"candidatesScored":6,
		"outcome":"no-profile",
		"startedAt":"2026-07-06T00:00:00.000Z","finishedAt":"2026-07-06T00:02:30.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (no-profile): %v", err)
	}
	if s.State != OnboardingJobStatusStateDone {
		t.Fatalf("state not decoded: %v", s.State)
	}
	if s.Outcome == nil || *s.Outcome != NoProfile {
		t.Fatalf("outcome not decoded: %v", s.Outcome)
	}
	if s.ResolvedProfile != nil {
		t.Fatalf("resolvedProfile should be absent for a no-profile outcome, got %+v", s.ResolvedProfile)
	}
}

// Decoding a payload in the NEW "indexing" state (onboarding-auto-index, Slice 1, design §2.1-§2.2)
// WITH a per-repo indexProgress array — the same no-drift guarantee as the winner/no-profile tests
// above, now for the post-confirm advisory-index phase. Mirrors the L52-148 pattern.
func TestOnboardingJobStatusDecodesIndexingStateFromServerJSON(t *testing.T) {
	const payload = `{
		"state":"indexing","app":"shop","round":3,"ceiling":3,"candidatesScored":6,
		"outcome":"winner",
		"resolvedProfile":{
			"transport":"http","frontFiles":"src/api/shop.ts",
			"frontCallSite":{"kind":"fetch"},
			"servicePrefixTemplate":"/api/shop","serviceRepoTemplate":"org/shop-svc",
			"openApiPath":"openapi/shop.yaml"
		},
		"indexProgress":[
			{"repo":"org/shop","status":"ok","nodeCount":120},
			{"repo":"org/shop-svc","status":"failed","error":"indexing org/shop-svc timed out"}
		],
		"startedAt":"2026-07-06T00:00:00.000Z"
	}`
	var s OnboardingJobStatus
	if err := json.Unmarshal([]byte(payload), &s); err != nil {
		t.Fatalf("decode OnboardingJobStatus (indexing): %v", err)
	}
	if s.State != OnboardingJobStatusStateIndexing {
		t.Fatalf("state not decoded: %v", s.State)
	}
	if s.Outcome == nil || *s.Outcome != Winner {
		t.Fatalf("outcome must stay winner during indexing (ADR-3 — indexing is a post-step, not a verdict): %v", s.Outcome)
	}
	if s.IndexProgress == nil || len(*s.IndexProgress) != 2 {
		t.Fatalf("indexProgress not decoded: %+v", s.IndexProgress)
	}
	progress := *s.IndexProgress
	if progress[0].Repo != "org/shop" || progress[0].Status != OnboardingJobStatusIndexProgressStatusOk {
		t.Fatalf("first repo outcome not decoded: %+v", progress[0])
	}
	if progress[0].NodeCount == nil || *progress[0].NodeCount != 120 {
		t.Fatalf("nodeCount not decoded: %+v", progress[0])
	}
	if progress[1].Repo != "org/shop-svc" || progress[1].Status != OnboardingJobStatusIndexProgressStatusFailed {
		t.Fatalf("second repo outcome not decoded: %+v", progress[1])
	}
	if progress[1].Error == nil || *progress[1].Error != "indexing org/shop-svc timed out" {
		t.Fatalf("error not decoded: %+v", progress[1])
	}
}
