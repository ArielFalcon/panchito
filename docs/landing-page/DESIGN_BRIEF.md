# panchito — Landing Page Design Brief

**Audience of this document:** a designer/coding model that will generate the full HTML of the page.
**Goal:** produce a single, self-contained, production-quality landing page that is **faithful to the intent below** — a sophisticated product landing that *demonstrates* an autonomous E2E QA agent through interactive, animated demos, not walls of text.

Read the whole brief before generating. When in doubt, prefer the choice that makes the product feel **trustworthy, alive, and engineered** over the choice that looks like a generic SaaS template.

---

## 0. What to output

- **One self-contained `index.html`** with embedded CSS and vanilla JavaScript. It must run by opening the file — **no build step, no framework runtime, no external JS deps** (one exception: you may load **Motion One** from a CDN for imperative animation; if unavailable, fall back to CSS/WAAPI).
- Fonts may load from Google Fonts (or be swapped for system fallbacks).
- The markup must be **clean and componentized in structure** (clear sections, BEM-ish or data-attribute hooks) because it will later be ported to **Astro + Svelte islands**. Think of this as the high-fidelity reference implementation.
- It must be **responsive** (mobile-first works up to large desktop), **accessible** (semantic HTML, keyboard-operable, ARIA where needed), and honor **`prefers-reduced-motion`** (render the final state of every animation instantly, no motion).
- Performance budget: lightweight. No video, no WebGL, no canvas-heavy renderers, no large image assets. All "visuals" are **styled DOM + SVG + CSS/JS animation**.

**Definition of "faithful" (acceptance bar):**
1. The page reads as a *scenario engine*, not a brochure: the hero and every section contain motion that shows the product working.
2. All four demos are implemented with the **shared data-driven player** (Section 5) and follow the **demo pattern** (bold visual metaphor + concise explanatory text).
3. The visual language is **bold editorial framing with authentic terminal/CLI surfaces inside the demos** (Section 3).
4. Bilingual EN/ES toggle works and persists (Section 8).
5. Brand is a **swappable token layer** (the name "panchito" and all colors/type come from CSS variables).
6. Nothing looks like a default Tailwind/Bootstrap/AI-generated SaaS page (Section 11).

---

## 1. The product (context you must internalize)

**panchito** is an autonomous End-to-End QA agent. On every deploy to a DEV environment it:
1. Reads the **change** (the commit diff + intent), across one or many repos (frontend + microservices).
2. Computes the **blast radius** through real code relationships and writes a focused **test plan**.
3. Generates **Playwright** E2E tests for what could break.
4. Has a **second, independent AI model** review each test for real value (no "click without asserting").
5. Confirms via **change-coverage** that the test actually executes the changed lines.
6. Runs the tests **against the live DEV environment** (never a mock).
7. If green + approved → opens a **PR that commits the tests into the user's own repo**. If broken → files a **GitHub Issue** with human-readable diagnostics. Flaky → quarantines.
8. Learns across runs (fragile flows, reliable selectors) and can be **asked questions in natural language**.
9. In its final phase, it **tests and fixes itself**: a dedicated maintainer agent receives error reports from the other agents, resolves them, and commits its own changes, with live log/status monitoring.

**Audience:** software engineers, engineering leads, and QA leads on teams that ship frequently. They are skeptical of "AI testing" hype. They are won by *seeing it work*, not by adjectives.

**The five weapons (the differentiation spine — every section should reinforce one):**
1. **Commit-aware blast radius** — tests exactly what changed, across all repos. Skips noise.
2. **Two independent models** — automated, scalable trust. (Competitors use humans or a single model.)
3. **Tests live in *your* git via PR** — full ownership, reviewable, zero lock-in.
4. **Change-coverage proof** — proves the test executes the changed lines. The anti-"green-noise" moat **no competitor advertises**.
5. **Runs against your real environment** + self-improving memory + a conversational layer.

---

## 2. The big idea

The page is a **Scenario Engine wrapped in a scroll narrative**:
- The **scroll** tells the story of a developer's deploy: *"did I just break something?"* → *it reads my change* → *it proves the test is real* → *I can ask it anything* → *it even fixes itself*.
- **Four pre-built, auto-playing demos** carry that story for the casual visitor.
- The **interactive Scenario Engine** near the end is the climax for the engaged visitor: pick/enter a repo, choose a diff depth, watch the full pipeline run live and end in a PR/Issue.

**The demo pattern (apply to ALL demos):** a **bold visual metaphor** that is light on technical detail and carries the energy, paired with **concise explanatory text** that carries the precision. The animation impresses; the text explains. Never explain with the animation alone, and never rely on text alone.

---

## 3. Visual language

**Tone:** bold editorial × engineered. Big confident typography and asymmetric, magazine-like layout for the *narrative*, with **authentic terminal/CLI surfaces** living *inside* the demos. The contrast between **editorial (paper, big type, whitespace)** and **terminal (dark, monospace, streaming logs)** is the signature of the design. Use it deliberately: alternate dark "engine" bands with lighter "editorial" bands to create rhythm.

**This is a provisional brand layer — implement everything via CSS custom properties so it can be swapped when the real "panchito" identity lands.**

### Color tokens (provisional, semantic)
The palette doubles as the product's verdict vocabulary — use these consistently for status:
```
--ink:        #0B0B12   /* near-black canvas (dark bands, terminals) */
--paper:      #F4F1EA   /* warm off-white (editorial bands)          */
--fg:         #EDEDF2   /* primary text on dark                      */
--fg-ink:     #16161D   /* primary text on paper                     */
--muted:      #8A8A99   /* secondary text                            */
--line:       #26262F   /* hairlines/borders on dark                 */

/* brand accent (swap on rebrand) */
--brand:      #C6F23A   /* acid lime — "alive / panchito"            */

/* status / verdict semantics (used in demos AND copy) */
--pass:       #34E29B   /* green   — pass / approved / PR            */
--fail:       #FF4D6D   /* magenta-red — fail / issue                */
--flaky:      #FFB020   /* amber   — flaky / skip / regression       */
--info:       #5AA9FF   /* blue    — info / coverage glow            */
```
Dark-first for hero + demos; use `--paper` bands for narrative/comparison sections. One accent (`--brand`) only — do not introduce rainbow gradients.

### Typography
- **Display** (headlines): a strong, characterful grotesk — e.g. *Space Grotesk*, *Clash Display*, or *Geist*. Large scale (clamp from ~2.5rem mobile to ~6rem desktop for the hero), tight leading, occasional oversized numerals.
- **Body**: a clean neutral grotesk — *Inter*, *Geist*, or system. Comfortable measure (60–72ch max).
- **Mono** (terminals, code, logs, verdicts): *JetBrains Mono*, *Geist Mono*, or *IBM Plex Mono*.
- Editorial touches: an eyebrow/kicker (small-caps mono) above each H2; large pull-quote-style sub-copy; generous section spacing.

### Layout & motion
- 12-col fluid grid; asymmetric compositions (don't center everything).
- **Demo sections use a "sticky panel" pattern:** the animated demo pins in the viewport while the explanatory text scrolls beside it (desktop); stacked on mobile (text above, demo below, demo plays when scrolled into view).
- Motion is **purposeful and timeline-driven** (events happening in sequence), not decorative parallax. Easing: smooth, slightly snappy (e.g. cubic-bezier(0.22, 1, 0.36, 1)). Respect reduced-motion.

---

## 4. Page structure (in order)

1. **Sticky nav** — wordmark `panchito` (left), section anchors (center, optional), **EN/ES toggle** + **GitHub** + primary CTA (right). Transparent over hero, solidifies on scroll.
2. **Hero** — editorial H1 + sub-copy + two CTAs ("Run a live scenario" → scrolls to engine; "See it work" → scrolls to Demo 1). Background: a subtle, always-on micro-demo — a commit landing and a PR card being "born" on loop (low-key, not distracting). Eyebrow: "Autonomous E2E QA".
3. **Demo 1 — Blast radius / analysis** (dark band). Metaphor: dependency graph (Section 6.1).
4. **Demo 2 — Generate → review → coverage → run → record** (the full flow; dark band). (Section 6.2)
5. **Demo 3 — Ask it anything** (paper band). Conversational + memory. (Section 6.3)
6. **Demo 4 — It tests itself** (dark band). Recursive/self-improving. (Section 6.4)
7. **Scenario Engine** (dark, full-bleed, the climax). Interactive. (Section 7)
8. **Comparison** (paper band). "Where panchito is different" table vs the market. (Section 9)
9. **Final CTA / waitlist** (dark band). Email capture (no backend; see Section 7) + GitHub.
10. **Footer** — wordmark, EN/ES toggle, minimal links, "made with panchito" wink.

---

## 5. The shared "scenario player" (build this once, reuse everywhere)

All four demos AND the Scenario Engine are driven by **one small data-driven runtime**. Build it as a single vanilla-JS module.

**Concept:** a *scenario* is a list of timed **events**. A *player* advances a clock and dispatches each event to a renderer that mutates the DOM. The renderer doesn't care whether events come from a static script (mock) or, in the future, a live backend stream — same renderer, different source. (This mirrors how the product's real TUI consumes the orchestrator's log/status stream.)

**Event/script schema (illustrative):**
```js
// a scenario = { id, repos?, steps: Step[] }
// Step = { at:ms, stage?, log?, type?, code?, verdict?, highlight?, counter?,
//          humanError?, card?, node?, edge? }
const scenario = {
  id: "feat-coupon",
  steps: [
    { at: 0,    stage: "classify", log: "diff +42 −3 · intent=feat → GENERATE" },
    { at: 700,  stage: "generate", type: "checkout.spec.ts" },
    { at: 2200, stage: "review",   verdict: { ok: true, reason: "asserts discount applied" } },
    { at: 3000, stage: "coverage", highlight: [12,13,14], counter: "8/8 changed lines" },
    { at: 4200, stage: "execute",  log: "running against dev.shop.app · 1 failed" },
    { at: 5200, humanError: "Coupon never applied: 'Apply' stayed disabled after a valid code. Likely a 500 from the discount API." },
    { at: 6000, stage: "decide",   card: { kind: "issue", title: "Coupon not applied on checkout" } },
  ]
}
```

**Player API (suggested):**
- `createPlayer(rootEl, scenario, { autoplayOnVisible, onDone })` → `{ play, pause, restart, seekToEnd }`.
- Uses `IntersectionObserver` to autoplay when ≥50% visible; `restart` button per demo.
- `prefers-reduced-motion` → immediately `seekToEnd` (final state, no animation).

**Renderer components (small, isolated; styled DOM/SVG):**
- `PipelineRail` — the horizontal/vertical **stage tracker**: Gate · Classify · Generate · Review · Coverage · Execute · Decide. Stages light up in sequence as events arrive. This is the "timeline of events" spine; show it in Demo 1, 2, 4 and the Engine.
- `Terminal` — a faux terminal window (traffic-light header, mono body) that streams log lines with timestamps and status coloring. Authentic-looking, never a real xterm.
- `CodeDiff` — a code block with line numbers where lines can **highlight / glow** (used for change-coverage).
- `ReviewVerdict` — a card showing the second model's JSON-ish verdict (approved/rejected + reason), color-coded.
- `PRCard` / `IssueCard` — GitHub-style cards (PR with "auto-merge ✓" green, or Issue with sanitized logs red).
- `Chat` — message bubbles + a thinking indicator (Demo 3).
- `Graph` — SVG nodes + edges with a growing "blast radius" glow (Demo 1).
- `RepoInput` — the Engine's controls (repo field, depth stepper, "Full analysis" button, Run).

Keep each component dumb and driven by events. One engine, many faces.

---

## 6. Demo specifications

> Each demo = **metaphor (visual) + explanatory text (precise)**. Copy is given EN/ES; wire both into the i18n dictionary. Keep technical detail in the text, keep the animation bold and legible.

### 6.1 Demo 1 — "Sees the blast radius, not the whole app" (the analysis phase)

**This is the phase BEFORE execution.** It shows how panchito analyzes **multiple repos** (frontend + microservices), computes the **blast radius** of a diff through **real relationships**, and ends by assembling a **plan** — before running any test.

**Metaphor (the `Graph` component):**
- Render the codebase as a **graph of nodes** grouped in 2–3 **clusters** (e.g., `web-frontend`, `checkout-service`, `payments-service`) with edges between/within clusters.
- A commit lands on one node (pulse on the changed node). The **blast radius is an expanding area/glow** that propagates **along edges**, lighting up affected nodes one hop at a time.
- Show at least one **cross-repo relationship**: e.g., a changed class in `payments-service` is injected into `checkout-service`, so that downstream node lights up too. Briefly label the edge ("injected", "imports", "calls API") as it activates.
- As nodes light, a **plan list** assembles on the side: "3 flows to test: checkout w/ coupon, refund, price display." Then the `PipelineRail` shows `Classify → (plan ready)` — handing off to Demo 2.
- Keep it legible: a dozen nodes, not a hairball. Animation is impressionistic; the text carries precision.

**Modes caption (small, under the demo):** `Default: diff (blast radius of one change). Also: manual (test what you ask) · complete (audit the whole suite).`

**Copy**
- EN H2: **"It doesn't test everything. It tests what your change can break."**
  Sub: "panchito maps your code — across every repo, frontend to microservices — into a dependency graph. When a commit lands, it grows the blast radius through *real* relationships: a class you changed, injected three services away, still lights up. Then it writes a focused test plan — before running a single test."
- ES H2: **"No prueba todo. Prueba lo que tu cambio puede romper."**
  Sub: "panchito mapea tu código —en todos tus repos, del frontend a los microservicios— como un grafo de dependencias. Cuando entra un commit, hace crecer el blast-radius a través de relaciones *reales*: una clase que cambiaste, inyectada tres servicios más allá, igual se enciende. Después arma un plan de tests enfocado — antes de correr un solo test."

### 6.2 Demo 2 — "Writes a real test — and a second model proves it"

**Metaphor:** a production line on the `PipelineRail`. Visual focus is on **(a) the test writing itself** and **(b) the live, human-translated feedback**. The "runs against the real environment, reading your repo" parts are explained in text and resolved in the final card.

**Sequence:**
1. `Generate` — `checkout.spec.ts` **types itself** into a `CodeDiff`/editor surface (use a typing effect; show real-ish Playwright lines).
2. `Review` — a `ReviewVerdict` from a *different* model stamps it: first reject a weak variant ("clicks without asserting → REJECTED"), then approve the strong one ("asserts discount applied → APPROVED").
3. `Coverage` — the **changed lines glow green** in the diff; counter "8/8 changed lines covered".
4. `Execute` — `Terminal` streams a run against `dev.shop.app`; one spec fails.
5. **Human-translated failure** (the key beat): instead of a stack trace, a callout in plain language — "Coupon never applied: the 'Apply' button stayed disabled after a valid code. Likely a 500 from the discount API."
6. `Decide` — drops a `PRCard` (green, auto-merge) on the happy path, or an `IssueCard` (red) on failure. Include a small toggle to flip between the green and red endings.

**Copy**
- EN H2: **"A test that runs green isn't proof. panchito proves it."**
  Sub: "It writes the spec, a *different* model reviews it for real assertions, and change-coverage confirms the test actually executes the lines you changed. Then it runs against your live DEV and tells you — in plain language — what broke. Green and approved → a PR into *your* repo. Broken → a GitHub Issue. Your tests, your git, no lock-in."
- ES H2: **"Un test en verde no es una prueba. panchito lo demuestra."**
  Sub: "Escribe el spec, un modelo *distinto* lo revisa buscando asserts reales, y el change-coverage confirma que el test realmente ejecuta las líneas que cambiaste. Después corre contra tu DEV vivo y te dice — en lenguaje claro — qué se rompió. Verde y aprobado → un PR a *tu* repo. Roto → un GitHub Issue. Tus tests, tu git, sin lock-in."

### 6.3 Demo 3 — "Ask it anything"

**Metaphor:** a `Chat` thread; when panchito answers, a faint **memory timeline** of past runs lights up behind/below the answer (showing it pulling from history). Light, paper-band section.

**Sequence:** user asks *"why did checkout fail yesterday?"* → typing indicator → answer synthesized from memory: "Run #314 — the coupon test failed 3 of the last 8 runs. Root cause: selector ambiguity on the pay button. Last stable after commit `abc123` added `data-testid='pay-now'`." Offer 2–3 suggested follow-up chips ("show flaky tests", "onboard a repo").

**Copy**
- EN H2: **"Your test suite, now something you can talk to."**
  Sub: "panchito remembers every run — fragile flows, flaky selectors, what fixed them last time — and answers from memory. Trigger runs, explain failures, onboard a repo: in plain language."
- ES H2: **"Tu suite de tests, ahora algo con lo que podés hablar."**
  Sub: "panchito recuerda cada corrida — flujos frágiles, selectores flaky, qué los arregló la última vez — y responde desde su memoria. Dispará corridas, explicá fallos, onboardeá un repo: en lenguaje natural."

### 6.4 Demo 4 — "It tests itself"

**Metaphor:** recursion / a mirror. The product's own agents emit small **error tickets** that flow toward a central **maintainer agent**; it resolves them and **commits to its own repo**; a compact **status/monitoring panel** pulses (uptime, runs today, self-fixes). Subtle recursive motif (e.g., a small panchito testing a smaller panchito, or a loop edge).

**Sequence:** `qa-generator` and `qa-reviewer` emit "issue reported" → arrows converge on `qa-maintainer` → it opens **its own PR** ("fix: stabilize flaky selector in own suite, auto-merge ✓") → monitoring panel ticks up "self-fixes: 7 this week". `PipelineRail` runs against panchito itself.

**Copy**
- EN H2: **"The first thing panchito tests is panchito."**
  Sub: "Its agents report their own failures to a maintainer agent that fixes them and commits the change — with live log and status monitoring. The code that uses itself to get better, every day. (Like building git in git.)"
- ES H2: **"Lo primero que panchito prueba es panchito."**
  Sub: "Sus agentes le reportan sus propios fallos a un agente de mantenimiento que los resuelve y commitea el cambio — con monitoreo de logs y status en vivo. El código que se usa a sí mismo para mejorar, cada día. (Como construir git en git.)"

---

## 7. The Scenario Engine (interactive climax)

A full-bleed dark section where the visitor runs the pipeline themselves.

**Controls (`RepoInput`):**
- **Repository** field (prefilled with a sample like `your-org/shop`).
- **Diff depth** stepper — a number: "Analyze the last **N** commits" (default 10). Make the meaning explicit in the label.
- **"Full analysis"** button — alternative to depth (audits the whole repo/suite).
- **Run** button.

**Behavior:**
- On Run, play the **full pipeline** through the shared player: blast-radius graph → plan → generate → review → coverage → execute (live `Terminal` stream) → ends in PR/Issue cards per analyzed change. Use the *same* components as the demos.
- **Demo mode is capped** — surface a small note: "Demo mode is capped (a few commits / a handful of tests) so you get the feel in seconds, not an 80-test marathon." This is a real product behavior; communicate it.
- **Execution adapters (architecture to encode in the JS):**
  - `mockAdapter` (default, bundled): deterministic scripted scenarios — **always works, no backend.** Powers the page on Vercel.
  - `liveAdapter` (optional, future): if a `window.PANCHITO_DEMO_API` URL is configured, POST `{repo, depth | full}` and stream real bounded results into the *same* renderer. If unset/unreachable, fall back gracefully to mock or the waitlist.
- **"Run on my real repo" → waitlist:** an email field that, with no backend, posts to a form service (Formspree/Firebase) **or** is a `mailto:`/no-op stub clearly marked `TODO: wire form endpoint`. Do not invent a backend.

**Copy**
- EN H2: **"Don't take our word for it. Run it."**  Sub: "Point it at a repo, pick how deep to look, and watch the whole pipeline work — live."
- ES H2: **"No nos creas. Corrélo."**  Sub: "Apuntalo a un repo, elegí cuán profundo mirar, y mirá todo el pipeline trabajar — en vivo."

---

## 8. Bilingual (EN/ES) + brand tokens

- **i18n:** a single JS dictionary `{ en: {...}, es: {...} }` keyed by string id; a `data-i18n` attribute on text nodes; a toggle in nav/footer that swaps language and persists to `localStorage` (`panchito.lang`). Default to the browser language, fallback EN. All copy in this brief is provided in both languages — use it.
- **Brand tokens:** the wordmark text (`panchito`), all colors, and font families come from CSS custom properties / a small `BRAND` config object, so the identity can be replaced in one place when it's ready. Treat the current name/palette/type as **provisional**.

---

## 9. Comparison section

A compact, scannable table — "Where panchito is different." Rows = the differentiators; columns = panchito + the market. Keep it honest and confident, not trash-talking.

| | **panchito** | QA Wolf | Octomind | Meticulous | Ranger |
|---|---|---|---|---|---|
| Commit-aware blast radius | ✓ | — | — | — | partial |
| Independent 2nd-model review | ✓ | human | single-model | — | human |
| Tests live in **your** git | ✓ | service-owned | their cloud | — | ✓ |
| Change-coverage proof | ✓ | — | — | — | — |
| Runs vs your real env | ✓ | ✓ | their cloud | replay | ✓ |
| Ask-it-anything + memory | ✓ | — | — | — | — |
| Self-improving (tests itself) | ✓ | — | — | — | — |

(Designer: render with the verdict colors; `✓` in `--pass`, `—` muted. Eyebrow + short intro line above.)

---

## 10. Anti-patterns — do NOT do these

- ❌ Generic AI-SaaS look: centered hero, three feature cards with line icons, purple-blue gradient blob, "Trusted by" logo strip of fake logos.
- ❌ Lorem ipsum, fake testimonials, fake metrics ("99.9% uptime", "10,000 teams"). If a number isn't real, don't invent it.
- ❌ Stock illustrations or 3D blobs. Visuals come from the product's own surfaces (graphs, terminals, diffs, PR cards).
- ❌ Decorative parallax with no meaning. Motion must depict the product working.
- ❌ Rainbow palettes. One brand accent + the verdict semantics, nothing more.
- ❌ Heavy dependencies, build steps, or a real backend.
- ❌ Walls of text. Every claim earns a visual; every visual earns a sentence.

---

## 11. Acceptance checklist (self-verify before finishing)

- [ ] Single self-contained `index.html`, opens and runs with no build; no real backend invented.
- [ ] Hero has a subtle always-on micro-demo; two CTAs scroll to engine / Demo 1.
- [ ] Four demos implemented via the **shared player**; each has metaphor + EN/ES explanatory text; `PipelineRail` used where specified.
- [ ] Demo 1 shows multi-repo graph + growing blast radius along edges + a cross-repo relationship + assembled plan, before execution.
- [ ] Demo 2 shows typing test → 2nd-model verdict (reject then approve) → changed-line coverage glow → live terminal run → **human-readable failure** → PR/Issue toggle.
- [ ] Demo 3 chat answers from "memory"; Demo 4 shows agents → maintainer → self-PR + monitoring.
- [ ] Scenario Engine: repo field + depth stepper (last N commits) + "Full analysis" + Run; capped-demo note; mock adapter works offline; live-adapter hook + waitlist stub present.
- [ ] EN/ES toggle works and persists; all visible copy is translated.
- [ ] Brand (name, colors, fonts) is fully tokenized/swappable.
- [ ] `prefers-reduced-motion` renders final states instantly; keyboard-accessible; semantic HTML; responsive mobile→desktop.
- [ ] Bold editorial framing + authentic terminal surfaces; no anti-patterns from Section 10.
