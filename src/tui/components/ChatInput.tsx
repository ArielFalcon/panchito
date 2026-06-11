import React, { useCallback, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import Spinner from "ink-spinner";
import { QaClient } from "../client";

type ChatEntry = { id: number; role: "q" | "a" | "err"; text: string };

const CARET_BLINK_MS = 530;
const MAX_INPUT = 400;

let _id = 0;
function nextId(): number {
  return ++_id;
}

export interface ChatInputProps {
  client: QaClient;
  runId: string;
  // Watch-screen command keys, honored only while the ask buffer is EMPTY:
  // 'q'/Esc → detach, 'x' → cancel. Any other keystroke reports "other" (the
  // watch uses it to disarm a pending cancel confirmation) and is then handled
  // as normal input. Once the user starts typing, every key is just text.
  onWatchKey?: (k: "detach" | "cancel" | "other") => void;
}

export function ChatInput({ client, runId, onWatchKey }: ChatInputProps): React.ReactElement {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caretOn, setCaretOn] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), CARET_BLINK_MS);
    return () => clearInterval(id);
  }, []);

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

    const qId = nextId();
    const aId = nextId();
    setEntries((prev) => [...prev, { id: qId, role: "q", text: question }, { id: aId, role: "a", text: "" }]);

    try {
      const history = entries.map((e) => ({ role: e.role, text: e.text }));
      const { answer } = await client.ask(runId, question, history);
      // Answers are plain JSON (no streaming) — render them immediately in full.
      setEntries((prev) => prev.map((e) => (e.id === aId ? { ...e, text: answer } : e)));
    } catch (e) {
      setEntries((prev) => prev.filter((e2) => e2.id !== aId));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [input, loading, entries, client, runId]);

  useInput((char, key) => {
    // Reserved keys are commands only while the buffer is empty.
    if (onWatchKey && input.length === 0) {
      if (key.escape || char === "q") {
        onWatchKey("detach");
        return;
      }
      if (char === "x") {
        onWatchKey("cancel");
        return;
      }
      onWatchKey("other");
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.escape) {
      setInput("");
      return;
    }
    // Word delete: Ctrl+W (\x17) or Ctrl+Backspace on macOS
    if (char === "\x17" || char === "\b" && key.meta) {
      setInput((prev) => prev.replace(/\s*\S+$/, ""));
      return;
    }
    // Delete entire line: Ctrl+U
    if (char === "\x15") {
      setInput("");
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (char.length === 1 && char >= " ") {
      setInput((prev) => (prev.length < MAX_INPUT ? prev + char : prev));
    }
  });

  const last = entries.slice(-2); // only the most recent Q+A pair

  return (
    <Box flexDirection="column" marginTop={1}>
      {last.map((entry) => (
        <Box key={entry.id} flexDirection="column">
          {entry.role === "q" ? (
            <Text dimColor>{"▶ "}{entry.text}</Text>
          ) : entry.role === "err" ? (
            <Text color="#c0392b">{"  "}{entry.text}</Text>
          ) : (
            <Text>{entry.text || (loading ? " " : "")}</Text>
          )}
        </Box>
      ))}

      {loading ? (
        <Text color="cyan">
          <Spinner type="dots" />
          {" thinking…"}
        </Text>
      ) : null}

      {error ? (
        <Box>
          <Text color="#c0392b">  {error}</Text>
        </Box>
      ) : null}

      <Box>
        <Text dimColor>{"ask > "}</Text>
        <Text>{input}</Text>
        {caretOn ? <Text color="#c24e2c">▌</Text> : <Text> </Text>}
        {loading ? <Text color="cyan"> …</Text> : null}
      </Box>
    </Box>
  );
}
