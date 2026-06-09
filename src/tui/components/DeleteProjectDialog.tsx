import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { QaClient } from "../client";

type Phase = "choose" | "confirm" | "deleting" | "done" | "error";

interface SelectItem { label: string; value: string }

export function DeleteProjectDialog({
  client,
  appName,
  onDone,
  onCancel,
}: {
  client: QaClient;
  appName: string;
  onDone: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("choose");
  const [purge, setPurge] = useState(false);
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (key.escape) {
      if (phase === "done") onDone();
      else onCancel();
    }
    if (phase === "done" && key.return) onDone();
  });

  const run = async (): Promise<void> => {
    setPhase("deleting");
    try {
      const r = await client.deleteApp(appName, purge);
      setRemoved(r.removed);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  if (phase === "choose") {
    const items: SelectItem[] = [
      { label: "Config only (config/apps/*.yaml; keeps run history + mirror)", value: "config" },
      { label: "Config + mirror + run history (full purge)", value: "purge" },
      { label: "Cancel", value: "cancel" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Delete project &apos;{appName}&apos; — what should be removed?</Text>
        <SelectInput items={items} onSelect={(i) => {
          if (i.value === "cancel") return onCancel();
          setPurge(i.value === "purge");
          setPhase("confirm");
        }} />
      </Box>
    );
  }

  if (phase === "confirm") {
    const items: SelectItem[] = [
      { label: "Yes — delete", value: "yes" },
      { label: "No — cancel", value: "no" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold color="#c0392b">This removes:</Text>
        <Text>  - config/apps/{appName}.yaml</Text>
        {purge ? <Text>  - the repo mirror (regenerable cache)</Text> : null}
        {purge ? <Text>  - ALL run history for &apos;{appName}&apos; (not recoverable)</Text> : null}
        <Text dimColor>  The watched repo itself is NEVER touched.</Text>
        <SelectInput items={items} onSelect={(i) => (i.value === "yes" ? void run() : onCancel())} />
      </Box>
    );
  }

  if (phase === "deleting") {
    return <Text color="cyan"><Spinner type="dots" /> deleting…</Text>;
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column">
        <Text color="#c0392b">✗ {error}</Text>
        <Text dimColor>Esc to go back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="#3b7a57">✓ deleted: {removed.join(", ")}</Text>
      <Text dimColor>Enter/Esc to continue</Text>
    </Box>
  );
}
