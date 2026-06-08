// The real-time activity feed shown under the active phase: the agent's todo
// checklist (its plan), the files it has written (+ count), and the commands it
// has run. Fed by the pure deriveActivityView; this component only places strings.

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { ActivityView, TodoStatus, truncate } from "../format";

const GUTTER = 7; // width of the "plan"/"wrote"/"ran" label column

function gutter(label: string): string {
  return (label + " ".repeat(GUTTER)).slice(0, GUTTER);
}

function TodoIcon({ status }: { status: TodoStatus }): React.ReactElement {
  if (status === "completed") return <Text color="#3b7a57">✓</Text>;
  if (status === "in_progress") return <Text color="cyan"><Spinner type="dots" /></Text>;
  return <Text dimColor>·</Text>;
}

export function LiveActivity({ view }: { view: ActivityView }): React.ReactElement | null {
  const { todos, filesWritten, fileCount, commands } = view;
  if (todos.length === 0 && filesWritten.length === 0 && commands.length === 0) return null;

  const shownFiles = filesWritten.slice(-3);
  const extraFiles = fileCount - shownFiles.length;
  const shownCmds = commands.slice(-2);

  return (
    <Box flexDirection="column">
      {todos.map((t, i) => (
        <Text key={`todo-${i}`}>
          <Text dimColor>{gutter(i === 0 ? "plan" : "")}</Text>
          <TodoIcon status={t.status} />
          {" "}
          <Text dimColor={t.status === "pending"}>{truncate(t.text, 52)}</Text>
        </Text>
      ))}
      {filesWritten.length > 0 ? (
        <Text>
          <Text dimColor>{gutter("wrote")}</Text>
          <Text dimColor>
            {shownFiles.join(" · ")}
            {extraFiles > 0 ? `   +${extraFiles}` : ""}
          </Text>
        </Text>
      ) : null}
      {commands.length > 0 ? (
        <Text>
          <Text dimColor>{gutter("ran")}</Text>
          <Text dimColor>{shownCmds.map((c) => truncate(c, 40)).join(" · ")}</Text>
        </Text>
      ) : null}
    </Box>
  );
}
