// Inline guidance prompt for manual mode. Captures free-text input using Ink's
// useInput hook. Press Enter to submit, Escape to go back.
import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";

export interface GuidancePromptProps {
  app: string;
  target: string;
  onSubmit: (guidance: string) => void;
  onCancel: () => void;
}

export function GuidancePrompt({ app, target, onSubmit, onCancel }: GuidancePromptProps): React.ReactElement {
  const [input, setInput] = useState("");

  useInput((char, key) => {
    if (key.return) {
      if (input.trim()) onSubmit(input.trim());
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (char === "\x17" || (char === "\b" && key.meta)) {
      setInput((prev) => prev.replace(/\s*\S+$/, ""));
      return;
    }
    if (char === "\x15") {
      setInput("");
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (char.length === 1 && char >= " ") {
      setInput((prev) => prev + char);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{`Manual mode for ${app} · ${target}`}</Text>
      <Text dimColor>Describe what to test — the agent will focus on this guidance.</Text>
      <Box marginTop={1}>
        <Text dimColor>{"> "}</Text>
        <Text>{input}</Text>
        <Text dimColor>_</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter: submit  |  Esc: go back</Text>
      </Box>
    </Box>
  );
}
