import React, { useCallback, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import Spinner from "ink-spinner";
import { QaClient, QaApiError } from "../client";

type ChatEntry = { id: number; role: "q" | "a" | "err"; text: string };

const MAX_INPUT = 400;
const DIV = "─".repeat(54);
const VISIBLE_ENTRIES = 10;
const CARET_BLINK_MS = 530;

let _nextId = 0;
function nextId(): number {
  return ++_nextId;
}

export function HelpChat({ client, onBack, context }: { client: QaClient; onBack: () => void; context?: string }): React.ReactElement {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([
    { id: nextId(), role: "a", text: context ? `panchito help — ${context}` : "panchito help — ask me anything about the QA pipeline, run modes, onboarding, configuration, or commands." },
  ]);
  const [loading, setLoading] = useState(false);
  const [caretOn, setCaretOn] = useState(true);
  // Scroll offset is state, not a ref: ↑/↓ must repaint the transcript immediately.
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), CARET_BLINK_MS);
    return () => clearInterval(id);
  }, []);

  const submit = useCallback(async () => {
    const question = input.trim();
    if (!question || loading || question.length > MAX_INPUT) return;
    setInput("");
    setLoading(true);

    const qEntry: ChatEntry = { id: nextId(), role: "q", text: question };
    const aId = nextId();
    setEntries((prev) => [...prev, qEntry, { id: aId, role: "a", text: "" }]);

    const history = entries
      .filter((e) => e.role === "q" || e.role === "a")
      .slice(-8)
      .map((e) => ({ role: e.role, text: e.text }));

    try {
      const { answer } = await client.help(question, history);
      // Answers are plain JSON (no streaming) — render them immediately in full.
      setEntries((prev) => prev.map((e) => (e.id === aId ? { ...e, text: answer } : e)));
      setScroll(0);
    } catch (e) {
      const msg = e instanceof QaApiError ? e.message : String(e);
      setEntries((prev) => [...prev.filter((e2) => e2.id !== aId), { id: nextId(), role: "err", text: msg }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, entries, client]);

  const handleKey = useCallback(
    (char: string, key: { escape: boolean; return: boolean; backspace: boolean; delete: boolean; meta?: boolean; upArrow: boolean; downArrow: boolean }) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.return) {
        void submit();
        return;
      }
      if (key.upArrow) {
        setScroll((prev) => Math.min(prev + 1, Math.max(0, entries.length - VISIBLE_ENTRIES)));
        return;
      }
      if (key.downArrow) {
        setScroll((prev) => Math.max(prev - 1, 0));
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
      if (char.length === 1 && char >= " " && input.length < MAX_INPUT) {
        setInput((prev) => prev + char);
      }
    },
    [onBack, submit, input.length, entries.length],
  );

  useInput(handleKey);

  const visible = entries.slice(
    Math.max(0, entries.length - VISIBLE_ENTRIES - scroll),
    entries.length - scroll,
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        <Text bold color="cyan">
          ╭{"─".repeat(54)}╮
        </Text>
        <Text bold color="cyan">
          {"│"}  <Text color="#c24e2c">? panchito help</Text>
          {" ".repeat(37)}<Text color="cyan">│</Text>
        </Text>
        <Text bold color="cyan">
          ╰{"─".repeat(54)}╯
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{DIV}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} minHeight={16}>
        {visible.length === 0 && !loading ? (
          <Text dimColor>  Start typing a question…</Text>
        ) : (
          visible.map((entry) => (
            <Box key={entry.id} flexDirection="column" marginBottom={entry.role === "a" || entry.role === "err" ? 1 : 0}>
              {entry.role === "q" ? (
                <Text color="#3b7a57">{"▶ "}{entry.text}</Text>
              ) : entry.role === "err" ? (
                <Text color="#c0392b">{"  ✗ "}{entry.text}</Text>
              ) : (
                <Text>{entry.text}</Text>
              )}
            </Box>
          ))
        )}
        {loading ? (
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
              {" thinking…"}
            </Text>
          </Box>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{DIV}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color="cyan" bold>
          {"ask > "}
        </Text>
        <Text>{input}</Text>
        {caretOn ? <Text color="#c24e2c">▌</Text> : <Text> </Text>}
        {input.length === 0 && !loading ? <Text dimColor> type a question…</Text> : null}
        {input.length >= MAX_INPUT - 10 ? (
          <Text dimColor>{` ${input.length}/${MAX_INPUT}`}</Text>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Esc → back  ·  Enter → send  ·  ↑↓ scroll</Text>
      </Box>
    </Box>
  );
}
