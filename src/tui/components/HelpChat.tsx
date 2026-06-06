import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import Spinner from "ink-spinner";
import { QaClient, QaApiError } from "../client";
import { useTypewriter } from "../useTypewriter";

type ChatEntry = { id: number; role: "q" | "a" | "err"; text: string };

const MAX_INPUT = 400;
const DIV = "─".repeat(54);
const VISIBLE_ENTRIES = 10;
const CARET_BLINK_MS = 530;

let _nextId = 0;
function nextId(): number {
  return ++_nextId;
}

export function HelpChat({ client, onBack }: { client: QaClient; onBack: () => void }): React.ReactElement {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([
    { id: nextId(), role: "a", text: "panchito help — ask me anything about the QA pipeline, run modes, onboarding, configuration, or commands." },
  ]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingId, setStreamingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [caretOn, setCaretOn] = useState(true);
  const scrollRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), CARET_BLINK_MS);
    return () => clearInterval(id);
  }, []);

  const { displayed } = useTypewriter(streamingText);

  const resolveStreaming = useCallback(() => {
    if (streamingId !== null && streamingText) {
      setEntries((prev) =>
        prev.map((e) => (e.id === streamingId ? { ...e, text: streamingText } : e)),
      );
    }
    setStreamingId(null);
    setStreamingText("");
  }, [streamingId, streamingText]);

  const submit = useCallback(async () => {
    const question = input.trim();
    if (!question || loading || question.length > MAX_INPUT) return;
    setInput("");
    setLoading(true);
    resolveStreaming();

    const qEntry: ChatEntry = { id: nextId(), role: "q", text: question };
    const aId = nextId();
    setEntries((prev) => [...prev, qEntry, { id: aId, role: "a", text: "" }]);
    setStreamingId(aId);

    const history = entries
      .filter((e) => e.role === "q" || e.role === "a")
      .slice(-8)
      .map((e) => ({ role: e.role, text: e.text }));

    try {
      const { answer } = await client.help(question, history);
      setStreamingText(answer);
      scrollRef.current = 0;
    } catch (e) {
      setStreamingId(null);
      setStreamingText("");
      const msg = e instanceof QaApiError ? e.message : String(e);
      setEntries((prev) => [...prev, { id: nextId(), role: "err", text: msg }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, entries, client, resolveStreaming]);

  const handleKey = useCallback(
    (char: string, key: { escape: boolean; return: boolean; backspace: boolean; delete: boolean; upArrow: boolean; downArrow: boolean }) => {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.return) {
        void submit();
        return;
      }
      if (key.upArrow) {
        scrollRef.current = Math.min(scrollRef.current + 1, Math.max(0, entries.length - VISIBLE_ENTRIES));
        return;
      }
      if (key.downArrow) {
        scrollRef.current = Math.max(scrollRef.current - 1, 0);
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

  const renderedEntries = entries.map((entry) => {
    if (entry.id === streamingId) {
      return { ...entry, text: displayed };
    }
    return entry;
  });

  const visible = renderedEntries.slice(
    Math.max(0, renderedEntries.length - VISIBLE_ENTRIES - scrollRef.current),
    renderedEntries.length - scrollRef.current,
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
        {loading && !streamingText ? (
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
