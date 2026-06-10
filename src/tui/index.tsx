// TUI entry point. `panchito <command>` talks to a RUNNING orchestrator over the
// control API. The live `run --watch` view is rendered with Ink (Dashboard); the
// list commands print plainly and exit. Two `qa`s on purpose: `npm run qa`
// (src/cli.ts) runs the pipeline in-process; this talks to the service.

import React from "react";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { ThemeWrapper } from "./theme";
import { createClient, QaApiError, QaClient } from "./client";
import { Watch, RunFlow } from "./app";
import { HomeScreen } from "./components/HomeScreen";
import { OnboardWizard } from "./components/OnboardWizard";
import { caseIcon } from "./format";
import { RunMode, TestTarget } from "../types";

const MODES: RunMode[] = ["diff", "complete", "exhaustive", "manual"];
const DIV = "─".repeat(60);

function resolveToken(): string | undefined {
  if (process.env.QA_API_TOKEN) return process.env.QA_API_TOKEN;
  const tuiDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "config", ".api_token"),
    join(tuiDir, "..", "..", "config", ".api_token"),
  ];
  for (const p of candidates) {
    try { return readFileSync(p, "utf8").trim() || undefined; } catch { /* not found */ }
  }
  return undefined;
}

function fail(msg: string): never {
  console.error(`qa: ${msg}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): void {
  console.log(`panchito — launch and watch QA runs (needs the service: docker compose up)

Usage: panchito <command> [options]
  run [<app>]   Trigger a run (interactive launcher if <app> is omitted on a TTY)
    --target <t> | --ref <r> | --latest | --sha <s> | --mode <m> | --guidance ".." | -w/--watch
  status [app]  Queue status, or the last run for an app
  apps          List configured apps
  logs <app>    Show a run's logs           [--last N]
  history <app> Recent runs for an app      [--limit N]
  ask <id> ".." Ask the read-only assistant about a run
  continue <id> Re-run fixing marked failures with guidance  --cases "a,b" [--guidance ".."] [-w]
  onboard        Add a new project (interactive wizard)

Env: QA_HOST (default localhost:8080) · QA_API_TOKEN (if the service requires auth)`);
}

async function cmdRun(client: QaClient, args: string[]): Promise<void> {
  let app: string | undefined;
  let target: TestTarget = "e2e";
  let mode: RunMode = "diff";
  let ref: string | undefined;
  let sha: string | undefined;
  let guidance: string | undefined;
  let watch = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--target") { const v = args[++i]; target = v === "code" ? "code" : "e2e"; }
    else if (a === "--ref") ref = args[++i];
    else if (a === "--latest") ref = "main";
    else if (a === "--sha") sha = args[++i];
    else if (a === "--mode") mode = (MODES as string[]).includes(args[i + 1] ?? "") ? (args[++i] as RunMode) : fail(`invalid --mode (diff|complete|exhaustive|manual)`);
    else if (a === "--guidance") guidance = args[++i];
    else if (a === "-w" || a === "--watch") watch = true;
    else if (a.startsWith("-")) fail(`unknown flag: ${a}`);
    else app = a;
  }

  if (!app) {
    if (!process.stdout.isTTY) fail("<app> is required (e.g. 'panchito run portfolio --watch')");
    const apps = (await client.listApps()).map((x) => x.name);
    if (apps.length === 0) fail("no apps configured — run 'panchito onboard' to add a project");
    // Default: pre-select the self-repo (ai-pipeline) if configured, so the user can
    // immediately run QA on the tool itself without picking from the list.
    const selfIdx = apps.indexOf("ai-pipeline");
    if (selfIdx >= 0) {
      apps.splice(selfIdx, 1);
      apps.unshift("ai-pipeline");
    }
    render(<ThemeWrapper><RunFlow client={client} apps={apps} refName={ref} sha={sha} guidance={guidance} /></ThemeWrapper>);
    return;
  }

  const res = await client.createRun({ app, target, mode, sha, ref: sha ? undefined : ref ?? "main", guidance });
  if (watch) {
    render(<ThemeWrapper><Watch client={client} id={res.id} /></ThemeWrapper>);
  } else {
    console.log(`▶ ${res.app} · ${ref ?? sha ?? "main"} → ${res.sha.slice(0, 7)} · ${res.mode}  (${res.id})`);
    process.exit(0);
  }
}

async function cmdStatus(client: QaClient, app?: string): Promise<void> {
  if (!app) {
    const q = await client.getQueue();
    console.log(`queue: ${q.pending} pending  ·  running: ${q.running ? `${q.running.id} (${q.running.app})` : "-"}`);
  } else {
    const runs = await client.listRuns(app, 1);
    const r = runs[0];
    if (!r) console.log(`no runs yet for ${app}`);
    else console.log(`last: ${r.sha.slice(0, 7)} · ${r.mode} · ${r.verdict ?? "running"} · ${r.passed ?? "-"}/${(r.passed ?? 0) + (r.failed ?? 0)} passed`);
  }
  process.exit(0);
}

async function cmdApps(client: QaClient): Promise<void> {
  for (const a of await client.listApps()) {
    const where = a.code ? "code mode (no web env)" : a.baseUrl;
    console.log(`  ${a.name.padEnd(15)} → ${a.repo.padEnd(32)} ${where}${a.shadow ? "  (shadow)" : ""}`);
  }
  process.exit(0);
}

async function cmdLogs(client: QaClient, args: string[]): Promise<void> {
  const app = args.find((a) => !a.startsWith("-"));
  if (!app) fail("<app> is required");
  const last = Number(flag(args, "--last")) || 1;
  const runs = await client.listRuns(app, last);
  const r = runs[last - 1];
  if (!r) fail(`no run #${last} for ${app}`);
  console.log(DIV);
  console.log(`run: ${r.id}  app: ${r.app}  sha: ${r.sha.slice(0, 7)}  target: ${r.target ?? "e2e"}  mode: ${r.mode}`);
  console.log(`verdict: ${r.verdict ?? "running"}  passed: ${r.passed ?? "-"}  failed: ${r.failed ?? "-"}`);
  console.log(DIV);
  for (const l of r.logs) console.log(l);
  if (r.cases.length) {
    console.log(DIV);
    for (const c of r.cases) console.log(`  ${caseIcon(c.status)} ${c.name}${c.detail ? ` — ${c.detail.slice(0, 120)}` : ""}`);
  }
  process.exit(0);
}

async function cmdContinue(client: QaClient, args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  const casesArg = flag(args, "--cases");
  const guidance = flag(args, "--guidance");
  const watch = args.includes("-w") || args.includes("--watch");
  if (!id || !casesArg) fail('usage: panchito continue <runId> --cases "name1,name2" [--guidance ".."] [-w]');
  const cases = casesArg.split(",").map((s) => s.trim()).filter(Boolean);
  // Validate case names exist in the parent run before sending to the API.
  const parent = await client.getRun(id);
  const validNames = new Set(parent.cases.map((c) => c.name));
  const invalid = cases.filter((c) => !validNames.has(c));
  if (invalid.length) fail(`case(s) not found in run ${id}: ${invalid.join(", ")}`);
  const res = await client.continueRun(id, cases, guidance);
  if (watch) {
    render(<ThemeWrapper><Watch client={client} id={res.id} /></ThemeWrapper>);
  } else {
    console.log(`▶ continue ${res.parentRunId} → ${res.id}`);
    process.exit(0);
  }
}

async function cmdAsk(client: QaClient, args: string[]): Promise<void> {
  const id = args[0];
  const question = args.slice(1).join(" ").trim();
  if (!id || !question) fail('usage: panchito ask <runId> "<question>"');
  const { answer } = await client.ask(id, question);
  console.log(answer);
  process.exit(0);
}

async function cmdHistory(client: QaClient, args: string[]): Promise<void> {
  const app = args.find((a) => !a.startsWith("-"));
  if (!app) fail("<app> is required");
  const limit = Number(flag(args, "--limit")) || 10;
  for (const r of await client.listRuns(app, limit)) {
    console.log(`  ${r.id.padEnd(22)} ${r.target ?? "e2e"}/${r.mode.padEnd(11)} ${(r.verdict ?? "running").padEnd(11)} ${r.passed ?? "-"}/${(r.passed ?? 0) + (r.failed ?? 0)}  ${r.at.slice(0, 16).replace("T", " ")}`);
  }
  process.exit(0);
}

function cmdOnboard(): void {
  render(<ThemeWrapper><OnboardWizard onDone={() => process.exit(0)} onCancel={() => process.exit(0)} /></ThemeWrapper>);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const client = createClient({ token: resolveToken() });
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(client, rest);
      case "status":
        return await cmdStatus(client, rest[0]);
      case "apps":
        return await cmdApps(client);
      case "logs":
        return await cmdLogs(client, rest);
      case "history":
        return await cmdHistory(client, rest);
      case "ask":
        return await cmdAsk(client, rest);
      case "continue":
        return await cmdContinue(client, rest);
      case "onboard":
        return cmdOnboard();
      case undefined:
        if (!process.stdout.isTTY) return usage();
        render(<ThemeWrapper><HomeScreen client={client} onExit={() => process.exit(0)} /></ThemeWrapper>);
        return;
      case "-h":
      case "--help":
        return usage();
      default:
        fail(`unknown command '${cmd}'`);
    }
  } catch (e) {
    if (e instanceof QaApiError) fail(e.message);
    throw e;
  }
}

void main();
