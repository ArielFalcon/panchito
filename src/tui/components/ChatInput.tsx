import React, { useCallback, useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import Spinner from "ink-spinner";
import { QaClient } from "../client";
import { useTypewriter } from "../useTypewriter";

type ChatEntry = { id: number; role: "q" | "a" | "err"; text: string };

const CARET_BLINK_MS = 530;

let _id = 0;
function nextId(): number {
  return ++_id;
}

export interface ChatInputProps {
  client: QaClient;
  runId: string;
}

export function ChatInput({ client, runId }: ChatInputProps): React.ReactElement {
  const [input, setInput] = useState("");
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingId, setStreamingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caretOn, setCaretOn] = useState(true);

  const { displayed } = useTypewriter(streamingText);

  useEffect(() => {
    const id = setInterval(() => setCaretOn((v) => !v), CARET_BLINK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setInput("");
    setEntries([]);
    setStreamingText("");
    setStreamingId(null);
    setError(null);
    setLoading(false);
  }, [runId]);

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
    if (!question || loading) return;
    setInput("");
    setLoading(true);
    setError(null);
    resolveStreaming();

    const qId = nextId();
    const aId = nextId();
    setEntries((prev) => [...prev, { id: qId, role: "q", text: question }, { id: aId, role: "a", text: "" }]);
    setStreamingId(aId);

    try {
      const { answer } = await client.ask(runId, question);
      setStreamingText(answer);
    } catch (e) {
      setStreamingId(null);
      setStreamingText("");
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [input, loading, client, runId, resolveStreaming]);

  useInput((char, key) => {
    if (key.return) {
      void submit();
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

  const rendered = entries.map((e) =>
    e.id === streamingId ? { ...e, text: displayed } : e,
  );
  const last = rendered.slice(-2); // only the most recent Q+A pair

  return (
    <Box flexDirection="column" marginTop={1}>
      {last.map((entry) => (
        <Box key={entry.id} flexDirection="column">
          {entry.role === "q" ? (
            <Text dimColor>{"▶ "}{entry.text}</Text>
          ) : entry.role === "err" ? (
            <Text color="#c0392b">{"  "}{entry.text}</Text>
          ) : (
            <Text>{entry.text || (loading && !streamingText ? " " : "")}</Text>
          )}
        </Box>
      ))}

      {loading && !streamingText ? (
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
