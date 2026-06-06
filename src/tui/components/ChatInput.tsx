import React, { useCallback, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { QaClient } from "../client";

export interface ChatInputProps {
  client: QaClient;
  runId: string;
}

type ChatEntry = { role: "q" | "a"; text: string };

export function ChatInput({ client, runId }: ChatInputProps): React.ReactElement {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInput("");
    setEntries([]);
    setError(null);
    setLoading(false);
  }, [runId]);

  const submit = useCallback(async () => {
    const question = input.trim();
    if (!question || loading) return;
    setInput("");
    setLoading(true);
    setError(null);
    setEntries((prev) => [...prev, { role: "q", text: question }]);
    try {
      const { answer } = await client.ask(runId, question);
      setEntries((prev) => [...prev, { role: "a", text: answer }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [input, loading, client, runId]);

  useInput((char, key) => {
    if (key.return) {
      submit();
      return;
    }
    if (key.escape) {
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
    <Box flexDirection="column" marginTop={1}>
      {entries.map((entry, i) => (
        <Box key={i} flexDirection="column">
          <Text dimColor={entry.role === "q"}>
            {entry.role === "q" ? "▸ " : "  "}
            {entry.text}
          </Text>
        </Box>
      ))}

      {error ? (
        <Box>
          <Text color="red">  {error}</Text>
        </Box>
      ) : null}

      <Box>
        <Text dimColor>{"ask > "}</Text>
        <Text>{input}</Text>
        {loading ? <Text color="cyan"> …</Text> : null}
      </Box>
    </Box>
  );
}
