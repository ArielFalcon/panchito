import React, { useCallback, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { QaClient } from "../client";
import { RunFlow } from "../app";
import { OnboardWizard } from "./OnboardWizard";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { HelpChat } from "./HelpChat";

interface SelectItem {
  label: string;
  value: string;
}

type View = "home" | "run" | "onboard" | "help" | "status" | "delete-list" | "delete";

const W = 54;

const BANNER = [
  "  ╭──────────────────────────────────────────────────╮",
  "  │                                                  │",
  "  │                [✓]  panchito                     │",
  "  │          Autonomous E2E QA for every deploy      │",
  "  │                                                  │",
  "  ╰──────────────────────────────────────────────────╯",
];

const TIP_LINES = [
  "  i  Run 'panchito --help' for all CLI commands.",
  "  i  Start with shadow mode when onboarding a new repo.",
  "  i  Use 'manual' mode + guidance to target a specific feature.",
];

export function HomeScreen({
  client,
  onExit,
}: {
  client: QaClient;
  onExit: () => void;
}): React.ReactElement {
  const [view, setView] = useState<View>("home");
  const [apps, setApps] = useState<string[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);

  const MENU_ITEMS: SelectItem[] = [
    { label: "▶  Run QA", value: "run" },
    { label: "+  Add New Project", value: "onboard" },
    { label: "-  Delete Project", value: "delete" },
    { label: "?  Help", value: "help" },
    { label: "⊞  Status", value: "status" },
    { label: "✕  Exit", value: "exit" },
  ];

  const fetchApps = useCallback(async () => {
    setAppsLoading(true);
    try {
      const list = await client.listApps();
      const names = list.map((a) => a.name);
      const selfIdx = names.indexOf("ai-pipeline");
      if (selfIdx >= 0 && names[selfIdx] === "ai-pipeline") {
        names.splice(selfIdx, 1);
        names.unshift("ai-pipeline");
      }
      setApps(names);
    } catch {
      setApps([]);
    } finally {
      setAppsLoading(false);
    }
  }, [client]);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusText(null);
    try {
      const q = await client.getQueue();
      const list = await client.listApps();
      let txt = `Queue: ${q.pending} pending  ·  running: ${q.running ? `${q.running.id.slice(0, 8)} (${q.running.app})` : "—"}\n\n`;
      txt += `Apps (${list.length}):\n`;
      for (const a of list.slice(0, 12)) {
        const where = a.code ? "code mode" : a.baseUrl || "—";
        const repo = a.repo ?? "—";
        txt += `  ${a.name.padEnd(14)} → ${repo.padEnd(30)} ${where}${a.shadow ? "  (shadow)" : ""}\n`;
      }
      if (list.length > 12) txt += `  … and ${list.length - 12} more\n`;
      setStatusText(txt);
    } catch (e) {
      setStatusText(
        `Could not reach the orchestrator.\n\nIs the service running?\n  docker compose up\n\nError: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setStatusLoading(false);
    }
  }, [client]);

  const handleSelect = useCallback((item: SelectItem) => {
    switch (item.value) {
      case "run":
        setView("run");
        break;
      case "onboard":
        setView("onboard");
        break;
      case "delete":
        void fetchApps();
        setView("delete-list");
        break;
      case "help":
        setView("help");
        break;
      case "status":
        setView("status");
        break;
      case "exit":
        onExit();
        break;
    }
  }, [onExit, fetchApps]);

  useInput(
    useCallback(
      (_char: string, key: { escape: boolean }) => {
        if (
          key.escape &&
          (view === "status" || view === "onboard" || view === "help" || view === "delete-list" || view === "delete")
        ) {
          setSelectedApp(null);
          setView("home");
        }
      },
      [view],
    ),
  );

  const tipIdx = useMemo(() => Math.floor(Math.random() * TIP_LINES.length), []);

  if (view === "run") {
    if (apps.length === 0 && !appsLoading) {
      fetchApps();
    }
    if (appsLoading) {
      return (
        <Box paddingX={1} paddingY={1}>
          <Text color="cyan">
            <Spinner type="dots" />
            {" loading apps…"}
          </Text>
        </Box>
      );
    }
    return <RunFlow client={client} apps={apps} />;
  }

  if (view === "onboard") {
    return (
      <OnboardWizard
        client={client}
        onDone={() => setView("home")}
        onCancel={() => setView("home")}
      />
    );
  }

  if (view === "delete-list") {
    if (appsLoading) {
      return (
        <Box paddingX={1} paddingY={1}>
          <Text color="cyan">
            <Spinner type="dots" />
            {" loading apps…"}
          </Text>
        </Box>
      );
    }
    if (apps.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>No apps configured.</Text>
          <Text dimColor>Esc → back to home</Text>
        </Box>
      );
    }
    const items: SelectItem[] = apps.map((a) => ({ label: a, value: a }));
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Select a project to delete</Text>
        <SelectInput
          items={items}
          onSelect={(i) => {
            setSelectedApp(i.value);
            setView("delete");
          }}
        />
        <Box marginTop={1}>
          <Text dimColor>Esc → back to home</Text>
        </Box>
      </Box>
    );
  }

  if (view === "delete" && selectedApp) {
    return (
      <DeleteProjectDialog
        client={client}
        appName={selectedApp}
        onDone={() => {
          setSelectedApp(null);
          void fetchApps();
          setView("home");
        }}
        onCancel={() => {
          setSelectedApp(null);
          setView("home");
        }}
      />
    );
  }

  if (view === "help") {
    return <HelpChat client={client} onBack={() => setView("home")} />;
  }

  if (view === "status") {
    if (!statusText && !statusLoading) {
      loadStatus();
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="column">
          <Text bold color="cyan">
            ╭{"─".repeat(W)}╮
          </Text>
          <Text bold color="cyan">
            {"│"}  <Text color="#c24e2c">⊞ Status</Text>
            {" ".repeat(W - 14)}<Text color="cyan">│</Text>
          </Text>
          <Text bold color="cyan">
            ╰{"─".repeat(W)}╯
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          {statusLoading ? (
            <Text color="cyan">  Loading…</Text>
          ) : statusText ? (
            statusText.split("\n").map((line, i) => (
              <Text key={i}>
                {line.startsWith("Could") || line.startsWith("Error") ? (
                  <Text color="#c0392b">{line}</Text>
                ) : (
                  <Text dimColor>{`  ${line}`}</Text>
                )}
              </Text>
            ))
          ) : null}
        </Box>

        <Box marginTop={2}>
          <Text dimColor>Esc → back to home</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box flexDirection="column">
        <Text dimColor>{BANNER[0]}</Text>
        <Text dimColor>{BANNER[1]}</Text>
        <Text dimColor>
          {"  │                "}
          <Text dimColor>{"["}</Text>
          <Text color="#c24e2c">✓</Text>
          <Text dimColor>{"]"}</Text>
          {"  "}<Text bold>panchito</Text>
          {"                     │"}
        </Text>
        <Text dimColor>{BANNER[4]}</Text>
        <Text dimColor>{BANNER[3]}</Text>
        <Text dimColor>{BANNER[5]}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(W + 4)}</Text>
      </Box>

      <Box marginTop={2} flexDirection="column">
        <SelectInput
          items={MENU_ITEMS}
          onSelect={handleSelect}
        />
      </Box>

      <Box marginTop={2}>
        <Text dimColor>{"─".repeat(W + 4)}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{TIP_LINES[tipIdx] ?? TIP_LINES[0]}</Text>
      </Box>
    </Box>
  );
}
