// Stateful TUI components: the live Watch (polls the run to a verdict) and the
// interactive Launcher/RunFlow (TTY-only: pick app + target + mode, then watch).
// These are the glue around the presentational Dashboard; the testable logic lives
// in client.ts / format.ts / Dashboard.tsx.
//
// Watch key model: leaving the watch NEVER cancels the run. 'q'/Esc detach (the
// run keeps going server-side; so does closing the terminal or Ctrl+C). Only an
// explicit 'x' pressed twice cancels.

import React, { useEffect, useState, useRef, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import { Dashboard } from "./components/Dashboard";
import { ChatInput } from "./components/ChatInput";
import { OnboardWizard } from "./components/OnboardWizard";
import { GuidancePrompt } from "./components/GuidancePrompt";
import { RunSummary } from "./components/RunSummary";
import { QaClient, QaApiError, QueueStatus } from "./client";
import { RUN_MODES, RunRecord, RunMode, TestTarget } from "../types";
import { MODE_INFO, TARGET_INFO } from "./format";

const TARGETS: TestTarget[] = ["e2e", "code"];

interface SelectItem { label: string; value: string }

export function Watch({ client, id, onDone, onDetach }: {
  client: QaClient;
  id: string;
  onDone?: () => void;
  // Interactive flows pass this: invoked with a notice when the user detaches or
  // cancels, so the caller returns to its launcher instead of exiting the app.
  onDetach?: (notice: string) => void;
}): React.ReactElement {
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armCancel, setArmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exitMsg, setExitMsg] = useState<string | null>(null);
  const { exit } = useApp();
  const finishedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;

    const finish = (code: number): void => {
      finishedRef.current = true;
      if (onDone && code !== 99) { onDone(); return; }
      process.exitCode = code;
      timer = setTimeout(() => exit(), 80);
    };

    const tick = async (): Promise<void> => {
      if (finishedRef.current) return;
      try {
        const r = await client.getRun(id);
        if (!alive || finishedRef.current) return;
        misses = 0;
        setRecord(r);
        if (r.status === "enqueued") {
          // Show the queue depth while we wait for our turn.
          client.getQueue().then((q) => { if (alive) setQueue(q); }).catch(() => {});
        } else {
          setQueue(null);
        }
        if (r.verdict) {
          if (onDone) { finishedRef.current = true; timer = setTimeout(() => onDone(), 600); return; }
          finish(r.verdict === "pass" || r.verdict === "skipped" ? 0 : 1);
          return;
        }
      } catch (e) {
        if (!alive || finishedRef.current) return;
        if (e instanceof QaApiError && ++misses >= 5) {
          setError(e.message);
          finish(1);
          return;
        }
      }
      if (alive) timer = setTimeout(() => void tick(), 1200);
    };

    void tick();
    // Unmount only stops polling — the run keeps going server-side (detach semantics).
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, id, exit, onDone]);

  const detach = useCallback((): void => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const notice = `run ${id} continues in the background — follow it with 'panchito status' or 'panchito logs'`;
    if (onDetach) { onDetach(notice); return; }
    setExitMsg(`detached — ${notice}`);
    process.exitCode = 0;
    setTimeout(() => exit(), 80);
  }, [id, onDetach, exit]);

  const requestCancel = useCallback((): void => {
    if (finishedRef.current) return;
    if (!armCancel) { setArmCancel(true); return; }
    finishedRef.current = true;
    setArmCancel(false);
    setCancelling(true);
    const leave = (notice: string): void => {
      if (onDetach) { onDetach(notice); return; }
      setCancelling(false);
      setExitMsg(notice);
      process.exitCode = 1;
      setTimeout(() => exit(), 80);
    };
    client.cancelRun(id).then(
      () => leave(`run ${id} cancelled by operator`),
      (e: unknown) => leave(`cancel failed: ${e instanceof Error ? e.message : String(e)} — the run may have already finished`),
    );
  }, [armCancel, client, id, onDetach, exit]);

  const handleWatchKey = useCallback((k: "detach" | "cancel" | "other"): void => {
    if (k === "detach") { detach(); return; }
    if (k === "cancel") { requestCancel(); return; }
    setArmCancel(false);
  }, [detach, requestCancel]);

  // While the dashboard (and its ChatInput) is not mounted yet, the watch handles
  // its own keys; afterwards ChatInput forwards them while its buffer is empty.
  useInput((input, key) => {
    if (key.escape || input === "q") { handleWatchKey("detach"); return; }
    if (input === "x") { handleWatchKey("cancel"); return; }
    handleWatchKey("other");
  }, { isActive: record === null && !exitMsg && !cancelling && !error });

  if (exitMsg) return <Text color="yellow">{`qa: ${exitMsg}`}</Text>;
  if (cancelling) return <Text color="yellow"><Spinner type="dots" />{" cancelling run…"}</Text>;
  if (error) return <Text color="red">{`qa: ${error}`}</Text>;

  const footer = armCancel ? (
    <Text color="#c2891b">{"press x again to cancel the run · any other key keeps it running"}</Text>
  ) : (
    <Text dimColor>{"q detach · x cancel · type to ask the assistant"}</Text>
  );

  if (!record) {
    return (
      <Box flexDirection="column">
        <Text color="cyan"><Spinner type="dots" />{" starting…"}</Text>
        <Box marginTop={1}>{footer}</Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Dashboard record={record} queue={queue} />
      <Box marginTop={1}><Text dimColor>{"─".repeat(60)}</Text></Box>
      <ChatInput client={client} runId={id} onWatchKey={handleWatchKey} />
      <Box marginTop={1}>{footer}</Box>
    </Box>
  );
}

export function Launcher({ apps, initialApp, defaultGuidance, onLaunch, onOnboard, onBack }: { apps: string[]; initialApp?: string; defaultGuidance?: string; onLaunch: (app: string, target: TestTarget, mode: RunMode, guidance?: string, shadow?: boolean) => void; onOnboard: () => void; onBack?: () => void }): React.ReactElement {
  const [app, setApp] = useState<string | null>(initialApp ?? null);
  const [target, setTarget] = useState<TestTarget | null>(null);
  const [mode, setMode] = useState<RunMode | null>(null);
  const [shadow, setShadow] = useState<boolean | null>(null);
  const [manualGuidance, setManualGuidance] = useState<string | undefined>(undefined);

  useInput((_, key) => {
    if (!key.escape) return;
    if (app === null) { onBack?.(); return; }
    if (target === null) { setApp(null); return; }
    if (mode === "manual" && manualGuidance === undefined && shadow === null) return; // GuidancePrompt handles
    // Backing out past the guidance step discards the typed guidance — re-picking
    // "manual" must always prompt again, never reuse a stale answer.
    if (mode !== null && shadow === null) { setMode(null); setManualGuidance(undefined); return; }
    setTarget(null);
  });

  if (app === null) {
    const items: SelectItem[] = [...apps.map((a) => ({ label: a, value: a })), { label: "+ onboard new project", value: "__onboard__" }];
    return (
      <Box flexDirection="column">
        <Text bold>Select an app</Text>
        <SelectInput items={items} onSelect={(i) => { if (i.value === "__onboard__") { onOnboard(); return; } setApp(i.value); }} />
        {onBack ? <Box marginTop={1}><Text dimColor>Esc → back</Text></Box> : null}
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
        <Box marginTop={1}><Text dimColor>Esc → back</Text></Box>
      </Box>
    );
  }
  if (mode === "manual" && manualGuidance === undefined && shadow === null) {
    return <GuidancePrompt app={app} target={target!} onSubmit={(guidance) => setManualGuidance(guidance)} onCancel={() => { setMode(null); setManualGuidance(undefined); }} />;
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
        <Box marginTop={1}><Text dimColor>Esc → back</Text></Box>
      </Box>
    );
  }
  const items: SelectItem[] = RUN_MODES.map((m) => ({ label: `${m}  — ${MODE_INFO[m]}`, value: m }));
  return (
    <Box flexDirection="column">
      <Text bold>{`Mode for ${app} · ${target}`}</Text>
      <SelectInput items={items} onSelect={(i) => { const m = i.value as RunMode; setManualGuidance(undefined); setMode(m); }} />
      <Box marginTop={1}><Text dimColor>Esc → back</Text></Box>
    </Box>
  );
}

export function RunFlow({ client, apps, initialApp, refName, sha, guidance, onBack }: {
  client: QaClient; apps: string[]; initialApp?: string; refName?: string; sha?: string; guidance?: string; onBack?: () => void;
}): React.ReactElement {
  const [runId, setRunId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The app list is local state so onboarding inside the flow can refresh it —
  // the prop is the initial snapshot (fetched once by the caller).
  const [appList, setAppList] = useState<string[]>(apps);
  const [preselect, setPreselect] = useState<string | undefined>(initialApp);

  useEffect(() => { setAppList(apps); }, [apps]);

  const refreshApps = async (newApp: string): Promise<void> => {
    try {
      const fresh = (await client.listApps()).map((a) => a.name);
      setAppList(fresh.includes(newApp) ? fresh : [...fresh, newApp]);
    } catch {
      setAppList((prev) => (prev.includes(newApp) ? prev : [...prev, newApp]));
    }
  };

  const launch = async (app: string, target: TestTarget, mode: RunMode, g?: string, shadow?: boolean): Promise<void> => {
    try { setNotice(null); setDone(false); const res = await client.createRun({ app, target, mode, sha, ref: sha ? undefined : refName ?? "main", guidance: g ?? guidance, shadow }); setRunId(res.id); }
    catch (e) { setErr(e instanceof QaApiError ? e.message : String(e)); }
  };

  if (err) return <Text color="red">{`qa: ${err}`}</Text>;
  if (runId && !done) {
    return (
      <Watch
        client={client}
        id={runId}
        onDone={() => setDone(true)}
        onDetach={(n) => { setNotice(n); setRunId(null); setDone(false); setPreselect(undefined); }}
      />
    );
  }
  if (runId && done) return <SummaryScreen client={client} id={runId} onBack={() => { setRunId(null); setDone(false); setPreselect(undefined); }} />;
  if (onboarding) {
    return (
      <OnboardWizard
        client={client}
        onDone={(appName) => { setOnboarding(false); setPreselect(appName); void refreshApps(appName); }}
        onCancel={() => setOnboarding(false)}
      />
    );
  }
  return (
    <Box flexDirection="column">
      {notice ? <Box marginBottom={1}><Text color="#c2891b">{`⚠ ${notice}`}</Text></Box> : null}
      <Launcher
        key={preselect ?? ""}
        apps={appList}
        initialApp={preselect}
        defaultGuidance={guidance}
        onLaunch={(a, t, m, g, s) => void launch(a, t, m, g, s)}
        onOnboard={() => setOnboarding(true)}
        onBack={onBack}
      />
    </Box>
  );
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

  if (continueId) {
    return (
      <Watch
        client={client}
        id={continueId}
        onDone={() => setContinueId(null)}
        onDetach={() => setContinueId(null)}
      />
    );
  }
  if (!record) return <Text color="cyan"><Spinner type="dots" />{" loading result…"}</Text>;
  return <RunSummary record={record} client={client} onBack={onBack} onContinue={handleContinue} />;
}
