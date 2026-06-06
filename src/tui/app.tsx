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
import { QaClient, QaApiError } from "./client";
import { RunRecord, RunMode, TestTarget } from "../types";
import { MODE_INFO, TARGET_INFO } from "./format";

const MODES: RunMode[] = ["diff", "complete", "exhaustive", "manual"];
const TARGETS: TestTarget[] = ["e2e", "code"];

interface SelectItem { label: string; value: string }

export function Watch({ client, id }: { client: QaClient; id: string }): React.ReactElement {
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { exit } = useApp();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;

    const finish = (code: number): void => {
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
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, id, exit]);

  if (error) return <Text color="red">{`qa: ${error}`}</Text>;
  if (!record)
    return (
      <Text color="cyan">
        <Spinner type="dots" />
        {" starting…"}
      </Text>
    );
  return (
    <Box flexDirection="column">
      <Dashboard record={record} />
      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(60)}</Text>
      </Box>
      <ChatInput client={client} runId={id} />
    </Box>
  );
}

export function Launcher({ apps, defaultGuidance, onLaunch, onOnboard }: { apps: string[]; defaultGuidance?: string; onLaunch: (app: string, target: TestTarget, mode: RunMode, guidance?: string) => void; onOnboard: () => void }): React.ReactElement {
  const [app, setApp] = useState<string | null>(null);
  const [target, setTarget] = useState<TestTarget | null>(null);
  const [mode, setMode] = useState<RunMode | null>(null);

  if (app === null) {
    const items: SelectItem[] = [
      ...apps.map((a) => ({ label: a, value: a })),
      { label: "+ onboard new project", value: "__onboard__" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Select an app</Text>
        <SelectInput items={items} onSelect={(i) => { if (i.value === "__onboard__") { onOnboard(); return; } setApp(i.value); }} />
      </Box>
    );
  }

  if (target === null) {
    const items: SelectItem[] = TARGETS.map((t) => ({
      label: `${t}  (${TARGET_INFO[t]})`,
      value: t,
    }));
    return (
      <Box flexDirection="column">
        <Text bold>{`Test target for ${app}`}</Text>
        <Text dimColor>e2e: browser tests against DEV. code: source-logic tests without a browser.</Text>
        <SelectInput items={items} onSelect={(i) => setTarget(i.value as TestTarget)} />
      </Box>
    );
  }

  // Manual mode: the user must write a guidance prompt before the run starts.
  if (mode === "manual") {
    return (
      <GuidancePrompt
        app={app}
        target={target}
        onSubmit={(guidance) => onLaunch(app, target, "manual", guidance)}
        onCancel={() => setMode(null)}
      />
    );
  }

  const items: SelectItem[] = MODES.map((m) => ({
    label: `${m}  — ${MODE_INFO[m]}`,
    value: m,
  }));
  return (
    <Box flexDirection="column">
      <Text bold>{`Mode for ${app} · ${target}`}</Text>
      <SelectInput items={items} onSelect={(i) => {
        const m = i.value as RunMode;
        if (m === "manual" && !defaultGuidance) {
          setMode(m);
        } else {
          onLaunch(app, target, m, defaultGuidance);
        }
      }} />
    </Box>
  );
}

export function RunFlow({
  client,
  apps,
  refName,
  sha,
  guidance,
}: {
  client: QaClient;
  apps: string[];
  refName?: string;
  sha?: string;
  guidance?: string;
}): React.ReactElement {
  const [runId, setRunId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);

  const launch = async (app: string, target: TestTarget, mode: RunMode, g?: string): Promise<void> => {
    try {
      const res = await client.createRun({ app, target, mode, sha, ref: sha ? undefined : refName ?? "main", guidance: g ?? guidance });
      setRunId(res.id);
    } catch (e) {
      setErr(e instanceof QaApiError ? e.message : String(e));
    }
  };

  if (err) return <Text color="red">{`qa: ${err}`}</Text>;
  if (runId) return <Watch client={client} id={runId} />;
  if (onboarding) return <OnboardWizard onDone={() => setOnboarding(false)} onCancel={() => setOnboarding(false)} />;
  return <Launcher apps={apps} defaultGuidance={guidance} onLaunch={(a, t, m, g) => void launch(a, t, m, g)} onOnboard={() => setOnboarding(true)} />;
}
