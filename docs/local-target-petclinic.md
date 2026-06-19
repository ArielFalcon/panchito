# Validating the engine against a real local target — Spring PetClinic Microservices

The engine had only ever been pointed at a static Astro demo. This guide brings up a **real
Angular + Spring Cloud microservices app on your machine** and runs the pipeline against it in
**shadow mode** (no PRs, no Issues) so you can see whether the whole flow — classify → generate →
validate → execute against a live DEV → reviewer → change-coverage → value report — actually does
something meaningful.

It is the stack the value keystone was built for: see
[change-coverage.md](change-coverage.md) → *Activating the keystone on a watched app (Angular +
Spring)*. App config: [`config/apps/petclinic.yaml`](../config/apps/petclinic.yaml).

> **Monorepo caveat.** PetClinic keeps every service in one repo, so this does **not** exercise the
> cross-repo `services:` feature (which needs each microservice in its own repo). It does exercise
> the e2e flow, the Angular+Spring coverage keystone, the deploy-gate skip, and shadow mode.

---

## 1. Bring up the target (the "DEV site")

Prerequrisites: Docker + Docker Compose, ~6–8 GB free RAM (it's several JVMs + an Angular SPA).

```bash
git clone https://github.com/spring-petclinic/spring-petclinic-microservices
cd spring-petclinic-microservices
docker compose up --build        # first build is slow; wait for the services to settle
```

When it's up, the **Spring Cloud Gateway** serves the whole UI at **http://localhost:8080** — open
it, click around (Owners → Add, Pets, Visits, Veterinarians). That URL is the `dev.baseUrl` the
engine drives with Playwright. Leave this running in its own terminal.

> Confirm the gateway port in the project's README/compose if a release moved it; update
> `dev.baseUrl` in `config/apps/petclinic.yaml` to match.

---

## 2. Run the engine against it (shadow, manual)

In the `ai-pipeline` repo (`npm install` once if you haven't). Pick a real commit SHA from
PetClinic's history for `--sha`; in `manual` mode the generation is steered by `--guidance`:

```bash
# Easiest first run — guidance-driven, no commit classification:
npm run qa -- --app petclinic --sha <any-petclinic-sha> \
  --mode manual --guidance "register a new owner, add a pet, then schedule a visit"

# Or test the blast radius of a real commit (diff mode classifies it first):
npm run qa -- --app petclinic --sha <petclinic-commit-sha>
```

Because `shadow: true`, it generates, validates and **runs the tests against your local DEV**, then
logs what it *would* publish — without opening anything.

---

## 3. Read the result — the value report

This is the part that used to be invisible. At the end of a manual run the CLI now prints a
**Run Value Report** answering *what happened, what the verdict was, and what value it added*:

```
━━ Run Value Report · petclinic @ a1b2c3d4e ━━
  mode         diff/e2e   ·   SHADOW (preview — no PR/Issue)
  verdict      pass  —  green and stable  (3 passed · 0 failed)
  produced     3 specs: add-owner, add-pet, schedule-visit
  action       would open an auto-merge suite PR with the new tests
  ── value signals ──
  change-cov   82%  (signal · measured against the diff)
  value oracle  67%  (signal · 2/3 specs noticed corrupted backend responses)
  reviewer     approved — assertions check the persisted owner appears in the list
```

The same value tail (`· change-coverage 82% · value …`) is appended to the run **outcome**, so the
TUI summary shows it too. The full structured history is still available via:

```bash
npm run qa -- --app petclinic --learning      # last outcomes, rules, curriculum
```

**If `change-cov` says "not measured":** the keystone needs one artifact to map PetClinic's bundled,
hashed Angular bundle back to `*.component.ts`. Enable DEV source maps and re-run — `ng build
--source-map`, or in `angular.json` set the development configuration's `sourceMap: true`. The bundle
stays minified/hashed (a realistic deploy); the map rides alongside and is fetched non-invasively. No
production change required. Details in [change-coverage.md](change-coverage.md).

---

## 4. Optional — exercise code mode (Java + JaCoCo)

The above tests the **frontend through the UI**. To also see the engine test **backend logic
directly** (no browser, classified by exit code), point a second app at a service module with
`code: true` and add the JaCoCo plugin so native line coverage is emitted
(`target/site/jacoco/jacoco.xml`). The orchestrator image already ships a JDK + Maven/Gradle. See
[change-coverage.md](change-coverage.md) → *Spring microservice (code mode) → add the JaCoCo plugin*.

---

## 5. When you trust it — lift shadow

Once the value reports look right, set `shadow: false` (and fork the repo so the bot can push to
your fork) to let it open real auto-merge PRs and Issues. Keep `changeCoverage.mode: signal` until a
few runs report a real measured ratio, then consider `enforce`.
