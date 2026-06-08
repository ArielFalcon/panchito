// Stateful TUI components: the live Watch (polls the run to a verdict) and the
// interactive Launcher/RunFlow (TTY-only: pick app + target + mode, then watch).
// These are the glue around the presentational Dashboard; the testable logic lives
// in client.ts / format.ts / Dashboard.tsx.

import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import { Dashboard } from "./components/Dashboard";
import { ChatInput } from "./components/ChatInput";
import { OnboardWizard } from "./components/OnboardWizard";
import { GuidancePrompt } from "./components/GuidancePrompt";
import { RunSummary } from "./components/RunSummary";
import { QaClient, QaApiError } from "./client";
import { RunRecord, RunMode, TestTarget } from "../types";
import { MODE_INFO, TARGET_INFO } from "./format";

const MODES: RunMode[] = ["diff", "complete", "exhaustive", "manual"];
const TARGETS: TestTarget[] = ["e2e", "code"];

interface SelectItem { label: string; value: string }

export function Watch({ client, id, onDone }: { client: QaClient; id: string; onDone?: () => void }): React.ReactElement {
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { exit } = useApp();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;

    const finish = (code: number): void => {
      if (onDone && code !== 99) { onDone(); return; }
      process.exitCode = code;
      timer = setTimeout(() => exit(), 80);
    };

    const tick = async (): Promise<void> => {
      try {
        const r = await client.getRun(id);
        if (!alive) return;
        misses = 0;
        setRecord(r);
        if (r.verdict) {
          if (onDone) { timer = setTimeout(() => onDone(), 600); return; }
          finish(r.verdict === "pass" || r.verdict === "skipped" ? 0 : 1);
          return;
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof QaApiError && e.status === undefined && ++misses >= 5) {
          setError(e.message);
          finish(1);
          return;
        }
      }
      if (alive) timer = setTimeout(() => void tick(), 1200);
    };

    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [client, id, exit, onDone]);

  if (error) return <Text color="red">{`qa: ${error}`}</Text>;
  if (!record) return <Text color="cyan"><Spinner type="dots" />{" starting…"}</Text>;
  return (
    <Box flexDirection="column">
      <Dashboard record={record} />
      <Box marginTop={1}><Text dimColor>{"─".repeat(60)}</Text></Box>
      <ChatInput client={client} runId={id} />
    </Box>
  );
}

export function Launcher({ apps, defaultGuidance, onLaunch, onOnboard }: { apps: string[]; defaultGuidance?: string; onLaunch: (app: string, target: TestTarget, mode: RunMode, guidance?: string, shadow?: boolean) => void; onOnboard: () => void }): React.ReactElement {
  const [app, setApp] = useState<string | null>(null);
  const [target, setTarget] = useState<TestTarget | null>(null);
  const [mode, setMode] = useState<RunMode | null>(null);
  const [shadow, setShadow] = useState<boolean | null>(null);
  const [manualGuidance, setManualGuidance] = useState<string | undefined>(undefined);

  if (app === null) {
    const items: SelectItem[] = [...apps.map((a) => ({ label: a, value: a })), { label: "+ onboard new project", value: "__onboard__" }];
    return (
      <Box flexDirection="column">
        <Text bold>Select an app</Text>
        <SelectInput items={items} onSelect={(i) => { if (i.value === "__onboard__") { onOnboard(); return; } setApp(i.value); }} />
      </Box>
    );
  }
  if (target === null) {
    const items: SelectItem[] = TARGETS.map((t) => ({ label: `${t}  (${TARGET_INFO[t]})`, value: t }));
    return (
      <Box flexDirection="column">
        <Text bold>{`Test target for ${app}`}</Text>
        <Text dimColor>e2e: browser tests against DEV. code: source-logic tests without a browser.</Text>
        <SelectInput items={items} onSelect={(i) => setTarget(i.value as TestTarget)} />
      </Box>
    );
  }
  if (mode === "manual" && manualGuidance === undefined && shadow === null) {
    return <GuidancePrompt app={app} target={target!} onSubmit={(guidance) => setManualGuidance(guidance)} onCancel={() => setMode(null)} />;
  }
  if (mode !== null && shadow === null) {
    const items: SelectItem[] = [
      { label: "No  — publish PRs and open Issues (normal mode)", value: "false" },
      { label: "Yes — run silently, no PRs or Issues (shadow mode)", value: "true" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>{`Shadow mode for ${app} · ${target} · ${mode}`}</Text>
        <Text dimColor>Shadow mode runs the full pipeline but does not publish PRs or open Issues.</Text>
        <SelectInput items={items} onSelect={(i) => {
          const s = i.value === "true";
          setShadow(s);
          onLaunch(app!, target!, mode!, mode === "manual" ? manualGuidance : defaultGuidance, s);
        }} />
      </Box>
    );
  }
  const items: SelectItem[] = MODES.map((m) => ({ label: `${m}  — ${MODE_INFO[m]}`, value: m }));
  return (
    <Box flexDirection="column">
      <Text bold>{`Mode for ${app} · ${target}`}</Text>
      <SelectInput items={items} onSelect={(i) => { const m = i.value as RunMode; setMode(m); }} />
    </Box>
  );
}

export function RunFlow({ client, apps, refName, sha, guidance }: {
  client: QaClient; apps: string[]; refName?: string; sha?: string; guidance?: string;
}): React.ReactElement {
  const [runId, setRunId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [done, setDone] = useState(false);

  const launch = async (app: string, target: TestTarget, mode: RunMode, g?: string, shadow?: boolean): Promise<void> => {
    try { setDone(false); const res = await client.createRun({ app, target, mode, sha, ref: sha ? undefined : refName ?? "main", guidance: g ?? guidance, shadow }); setRunId(res.id); }
    catch (e) { setErr(e instanceof QaApiError ? e.message : String(e)); }
  };

  if (err) return <Text color="red">{`qa: ${err}`}</Text>;
  if (runId && !done) return <Watch client={client} id={runId} onDone={() => setDone(true)} />;
  if (runId && done) return <SummaryScreen client={client} id={runId} onBack={() => { setRunId(null); setDone(false); }} />;
  if (onboarding) return <OnboardWizard onDone={() => setOnboarding(false)} onCancel={() => setOnboarding(false)} />;
  return <Launcher apps={apps} defaultGuidance={guidance} onLaunch={(a, t, m, g, s) => void launch(a, t, m, g, s)} onOnboard={() => setOnboarding(true)} />;
}

function SummaryScreen({ client, id, onBack }: { client: QaClient; id: string; onBack: () => void }): React.ReactElement {
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [continueId, setContinueId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    client.getRun(id).then((r) => { if (alive) setRecord(r); }).catch(() => {});
    return () => { alive = false; };
  }, [client, id]);

  const handleContinue = async (cases: string[]) => {
    try {
      const res = await client.continueRun(id, cases);
      if (res?.id) setContinueId(res.id);
    } catch { /* continue failed — stay on summary */ }
  };

  if (continueId) return <Watch client={client} id={continueId} onDone={() => {}} />;
  if (!record) return <Text color="cyan"><Spinner type="dots" />{" loading result…"}</Text>;
  return <RunSummary record={record} client={client} onBack={onBack} onContinue={handleContinue} />;
}
