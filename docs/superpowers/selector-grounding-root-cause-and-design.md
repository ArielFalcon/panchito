# Selector Grounding — root cause & robust design (project-agnostic)

> **STATUS: DESIGN SPECIFICATION — not landed code (v4, 3 adversarial rounds folded in).** Every
> file:line below is the **current** (buggy) state proving the bug is live; every "add / replace /
> thread" is **prescribed work**. Round 3 produced the key correction in this version: **Pillar 2 is a
> bounded safety net, not an all-covering gate — the primary fix is Pillar 1 (correct grounding data)
> + Pillar 3 (no fabrication).** See *Design posture*.

## Scope & invariant

The engine generates Playwright selectors that must exist in the live DOM of **any** watched app,
under **any** test-id convention **or none**. This design fixes the chronic "generated **DOM
selector** doesn't exist → 30s timeout → failed run" failure at its root, for every app. Watched apps
are **interchangeable reproduction targets, never design inputs**; the only legitimate app-specific
input is the declared `e2e.testIdAttribute` in `config/`. No code path branches on app identity.

- **In scope:** grounding of DOM **selectors** (test-id, role+name, label, placeholder, text, stable
  id/name). The reproduction's four fabricated selectors were **DOM test-id selectors** (not URL
  navigations); this closes the **DOM-selector-caused** 30s timeout.
- **Out of scope (declared, separate follow-on):** non-selector hallucinations — routes/URLs, API
  operationIds/contracts, expected text/state, seeded data. The catalog schema leaves room for
  `routes`/`contracts` indices later.

## Root cause — three structural facts (project-agnostic)

1. **Convention→capture contract broken.** `testIdAttribute` flows to **execution** but **not capture**:
   the four capture functions call `render()` without it → hardcoded default
   (`dom-snapshot.ts:328,358,396,428`; default `:656`); `ContextPackInput`/`CaptureDomInput` lack the
   field; the changed-marker hardcodes the attribute (`dom-snapshot.ts:216`). → Any non-default
   convention → capture queries the wrong attribute → no hints → the agent fabricates.
2. **Verification blind to the preferred family.** `getByTestId` (+ `.locator`/`getByPlaceholder`/
   `getByAltText`/`getByTitle`) are `NON_EXTRACTABLE` (`selector-check.ts:262,272`) — test-ids live in
   the attribute side-channel, not the ARIA `nodes[]` the checker matches. → The preferred selector
   tier is the one no layer can verify; a bad test-id is caught only by a 30s timeout.
3. **No fail-closed pre-exec gate.** D4 (`selector-check.ts:10-12`): pre-gen absence is advisory
   (speculative snapshot); the pre-write check flags only ambiguity. Absence is conclusive only after
   the 30s timeout.

## Why it survived five fixes

Fact #1 is **latent** on the default convention, **manifests** only on a non-default one; prior fixes
were validated where the default matched, so the cut wire was invisible, and each fix only **enriched
the DOM payload**. None repaired the convention contract; none touched fact #2. It is a **data-flow
integrity + verification-coverage** problem, not an information-richness one.

## Design posture (the Round-3 correction — read before the pillars)

A capture-time catalog can only *confidently* verify a selector that is on the **initial load**, on a
**settled** page, in a **groundable family**, **before the first navigation/DOM-opening action**. For
the apps that actually trigger the bug (SPAs with late hydration, auth-gated routes, multi-step/modal
flows) most selectors fall **outside** that window. If the gate fail-closed there, it would
false-block valid tests; so it must stay **advisory** there. Therefore:

- **Primary fix = Pillar 1 (give the agent the REAL selectors so it transcribes instead of guessing)
  + Pillar 3 (forbid fabrication).** These eliminate fabrication *at the source* and are NOT subject
  to the coverage limit — Pillar 1 alone fixes the reproduction.
- **Pillar 2 = a bounded, cheap safety net:** it fail-closes only inside the confident window
  (catching cheap residual hallucinations before a 30s timeout); everywhere else it is advisory and
  the **runtime executor remains the backstop**. That backstop is acceptable *because* Pillars 1+3
  mean the agent is no longer guessing there. Robustness is **defense-in-depth**, not one gate.

This is the honest correction to the earlier "Pillar 2 closes Fact #3" overclaim: Pillar 2 *reduces*
the timeout-as-oracle for the cases it can confidently gate; it does not eliminate it universally.

## The Selector Catalog

Captured once per route by the existing `captureRouteTrees` pass (extended; no second browser launch),
with per-family indices.

```ts
interface RouteCatalog {
  route: string;
  status: "captured" | "degraded";   // degraded = capture errored / timed out / auth-blocked
  settled: boolean;                   // a SECONDARY waitForLoadState("networkidle",{timeout}) AFTER goto
                                      // resolved within budget. false ⇒ possibly pre-hydration ⇒ advisory.
  testIds: Map<string, number>;       // value → count. Presence AND uniqueness (count>1 ⇒ ambiguity)
  roles: Array<{ role: string; name: string }>;
  labels: Set<string>; placeholders: Set<string>; texts: Set<string>; idsNames: Set<string>;
}
```

Built without the two capture-side losses Round-2 found:

- **Role-independent test-id capture.** The current in-page walk does `if (!computedRole) return null`
  (`dom-snapshot.ts:697`), dropping `<div data-cy="x">` with no ARIA role. Fix (enumerated, not just
  "a query"): a dedicated pass that **does not check `computedRole`** emits, per element carrying the
  attribute, its raw test-id value into a `testIdRawList: string[]`. The role guard is removed **only**
  for the test-id pass; the ARIA pass keeps it.
- **Count + pre-`mergeAttrs`.** The Node-side `child.on("close")` handler counts `testIdRawList` into
  the `Map<value,count>` **before** `mergeAttrs` (`dom-snapshot.ts:760`) — so unlabelled inputs sharing
  a `role:name` key do not collapse, and duplicate test-ids are detectable.
- **Hint parity for role-less elements.** Because role-less `<div data-cy>` are in the catalog but the
  human-readable hint (`mergeAttrs`→`buildAttrHint`) is ARIA-keyed, the agent would not *see* them.
  Render a separate `test-ids on this route:` block in the DOM snapshot from the role-independent list,
  so the agent can DISCOVER every value the gate will accept. (Prevents catalog/hint divergence.)

## Pillar 1 — One convention, threaded to every capture path (primary fix; closes Fact #1)

Exact, fully-enumerated targets:

- Add `testIdAttribute?: string` to `CaptureDomInput` (`dom-snapshot.ts:62`), `ContextPackInput`
  (`context-pack.ts:48`), **and the inline `PipelineDeps.captureDom`/`captureRouteTrees` dep types**
  (`pipeline.ts:213,218`) — these are separate type definitions the test wires against; missing them
  re-cuts the wire on the reviewer path.
- Add a `testIdAttribute` parameter to all four capture fns (`captureDom :328`, `captureDomForRoutes
  :358`, `captureDomByRoute :396`, `captureRouteTrees :428`) and route every `deps.render(...)` through
  **one convention-aware helper** (single application point; functions stay separate).
- `buildChangedMarker`: add `testIdAttrName` param; update call sites (`:307,:313`); replace **both**
  occurrences of the hardcoded `"data-cy"` (`:215` guard label + `:216` return string) — the marker
  text becomes `` `[CHANGED: added ${testIdAttrName}=…]` ``.
- Forward `resolveTestIdAttribute(app)` (`pipeline.ts:899`) into every call-site: `buildContextPack`
  (`:1921`, through `ContextPackInput`+`defaultContextPackDeps`→`captureDomForRoutes`); the
  `captureRoutesDom`→`captureDomByRoute` closure (`:376`); `captureDom` (`:1521`); `captureRouteTrees`
  (`:475` **and** the call at `:1806`).
- **Anti-drift invariant test, FIRST (RED), parametrized over a non-default convention:** assert the
  convention reaches the capture spawn (`PW_TEST_ID_ATTRIBUTE`) and the emitted hints/catalog use it.
  Over conventions, never over app identity. This is the test whose absence let the wire stay cut.

## Pillar 2 — Catalog + a bounded, confidence-aware safety-net gate (closes Fact #2; reduces Fact #3)

**Per-family extractability + matching** (removes `NON_EXTRACTABLE` blindness where an index exists):
`getByTestId`→`testIds`(has key; count>1⇒ambiguity), `getByRole`→`roles`, `getByLabel`→`labels`,
`getByPlaceholder`→`placeholders`, `getByText`→`texts`, `locator('#id'|'[name=x]')`→`idsNames`.
Complex CSS/XPath, computed/variable locators, and `locator('[<testIdAttr>=x]')` → **un-groundable →
advisory**.

**The confident window — fail-closed ONLY when ALL hold:** `status==="captured"` **and**
`settled===true` **and** the selector is **pre-first-navigation** (lexically before the first
`goto(<different route>)` or `click`/`tap`; `fill`/`type`/`press`/`selectOption`/`check`/`hover` and
`goto(<same route>)` do NOT close the window) **and** a **groundable family**. In the window, absent →
**regenerate** (cheap; no 30s timeout), wired as a one-shot pre-execution repair pass between phasing
steps 4 and 5 (reusing the existing contradiction/repair path, bounded to 1 attempt).

**Everywhere else → advisory** (post-navigation, `settled===false`, `degraded`, un-groundable family,
computed route, or ambiguous click). Never blocked; the runtime executor is the backstop. Per the
*Design posture*, this is intentional — Pillars 1+3 carry the hard cases.

> **Honest coverage statement (acceptance must measure it):** the fail-closed window is narrow. The
> phasing's advisory phase must report, on the reproduction app and on a SPA, the **fraction of
> emitted selectors that land in the confident window vs advisory** — so the real catch-rate is known,
> not assumed. If it is near-zero for SPAs, that is expected and acceptable: the value there comes
> from Pillars 1+3, and Pillar 2 is documented as a static-page/initial-load safety net.

**Capture confidence & loud failure:** the capture script inserts a **secondary**
`waitForLoadState("networkidle",{timeout})` AFTER `goto` (the existing `goto({waitUntil:"networkidle"})`
times out *with* navigation, so it cannot set `settled` separately); `settled=true` only if it
resolves. Replace the silent `catch{return []}` (`:431`) / `catch{return undefined}` (`:360`) with a
typed `degraded` result + a **loud run-log warning**. A degraded/unsettled catalog is visible and
attributed, never a silent reopen.

**`locator()` escape-hatch:** un-groundable→advisory, BUT the gate counts un-groundable selectors;
**any `locator('[<testIdAttr>=x]')` pattern, OR >30% un-groundable selectors in a spec**, escalates to
a flagged warning (visible). Pillar 3 forbids wrapping a test-id in `locator()`.

## Pillar 3 — Authoring contract: grounded selectors only (primary fix; closes the fabrication license)

- Every selector value MUST come from the catalog. **Remove the fabrication license in all four prompt
  files** (verified present): generator "cannot reach DEV → do your best with code analysis alone"
  (`agents/agent/qa-generator.md:98-99`, `agent/roles/qa-generator.md:96-97`); worker "if no URL is
  provided, derive them from the code" (`agents/agent/qa-worker.md:21`, `agent/roles/qa-worker.md:21`).
- **Replacement (explicit for the no-catalog / unreachable case):** use ONLY role/label/text present in
  the grounded ARIA; **never construct a test-id or placeholder value from source code or convention**;
  **never wrap a test-id in `locator()`**. If a route has no catalog, emit no selector for that element
  and **flag it ungroundable in the verdict** — do not derive from source. Truly ungroundable critical
  flows surface as "grounding unavailable" (a visible degraded outcome), never a fabricated green/red.
- Convention-agnostic phrasing: *"use only selectors present in the provided catalog,"* never *"this
  app uses attribute X."*

## Invariant compliance

- **Project-agnostic:** no app-identity branch; convention from `config/`.
- **Fail-closed only where certain, advisory where blind:** never a false block; the runtime backstop
  covers the advisory class.
- **Surface errors loudly:** capture failure is a typed `degraded` status + loud warning, never silent.

## Phasing (TDD, parity-gated)

1. **Anti-drift invariant test first** (RED), non-default convention.
2. **Pillar 1 wire** (GREEN): single render helper; four signatures + the two inline dep types +
   `buildChangedMarker` signature; all pipeline call-sites; fix the marker (both occurrences). **This
   step alone fixes the reproduction.**
3. **Pillar 3 authoring contract:** remove the four fabrication-license sentences; insert the
   no-catalog behavior. (Primary fix; ship with/after step 2.)
4. **Catalog** (advisory): extend `captureRouteTrees` → `RouteCatalog` (role-independent test-id pass +
   `testIdRawList` count; `status`+secondary-wait `settled`); per-family extractability; role-less hint
   block; **fix the silent catches first.** Report confident-window vs advisory fractions.
5. **Flip the confident-window path to enforce** + wire the one-shot pre-exec repair, once advisory data
   shows zero false-blocks.

### Acceptance gate (agnosticism AND structural robustness — with a POSITIVE assertion)

- **Convention axis:** non-default test-id app; default test-id app; no-test-id app; + the parametrized
  anti-drift unit test.
- **Structural axes:** unlabelled-input forms (test-id index survives dedup + role-less); SPA with late
  hydration + auth-gated routes (`settled=false`/`degraded` → advisory + loud, no false-block, no
  silent reopen); multi-step/modal flow (no post-navigation false-block).
- **POSITIVE gate test (not tautological):** on a confirmed `captured && settled` static route, a spec
  with a deliberately-fabricated test-id MUST be fail-closed (the gate FIRES) — proving the confident
  window actually catches, not just that it never false-blocks.

## Placement & rewrite parity

Fix in legacy `src/qa/` + agent prompts (`agent/`, `agents/`).

**Concrete rewrite parity:** the qa-engine `DomGroundingPort.ground(objective)` returns
`DomGrounding = { aria; routes }` and takes no convention
(`qa-engine/src/contexts/generation/application/ports/index.ts:70-72`). Parity requires: a
`testIdAttribute` **parameter on `ground` (or a `DomGroundingInput`) — NOT on the kernel `Objective`**
(it is sealed: only `flow/objective/targets`), and `DomGrounding` gains the `RouteCatalog`. **Tracking:
this parity is a hard checklist item for the qa-engine generation slice — if it ships without the
field, the rewrite path silently regresses; record it as a blocking TODO on that slice, not a vague
note.**

> NOTE: `dom-snapshot.ts`/`context-pack.ts`/`changed-elements.ts` have active user WIP — coordinate
> before editing. The anti-drift invariant test lands first to pin behavior.
