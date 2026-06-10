// Post-execution summary screen. Interactive: keyboard navigation (↑↓ expand,
// ↩ toggle detail, C/E/B/F actions). Sections collapse/expand one at a time.

import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { writeFileSync } from "node:fs";
import { Badge, Alert } from "@inkjs/ui";
import { RunRecord } from "../../types";
import { PIPELINE_STEPS, stepState, sectionLabel, shortSha, caseColor, caseIcon, formatElapsed, parseAssertionError } from "../format";
import { ChatInput } from "./ChatInput";
import type { QaClient } from "../client";

// ── log parsing ──────────────────────────────────────────────────────────────

function parseCoverageFromLogs(logs: string[]): string | null {
  for (const l of logs) {
    const m = l.match(/change-coverage:\s+(\w+)\s+—\s+(.+)/);
    if (m) return `${m[1]!}: ${m[2]!}`;
  }
  return null;
}

function parseReviewFromLogs(logs: string[]): string | null {
  for (const l of logs) {
    const m = l.match(/independent reviewer round \d\/\d: (.+)/);
    if (m) return m[1]!;
  }
  return null;
}

// Filtered tail: drop heartbeat + empty lines, keep at most `max` lines.
const HEARTBEAT_RE = /^\[qa\] agent (?:active|is working)/;
function tailLogs(logs: string[], max: number): string[] {
  const filtered = logs.filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (HEARTBEAT_RE.test(t)) return false;
    return true;
  });
  return filtered.slice(-max);
}

function runDuration(record: RunRecord): string {
  const start = Date.parse(record.at);
  if (Number.isNaN(start)) return "";
  return formatElapsed(Date.now() - start);
}

function shortId(id: string): string {
  return id.slice(0, 12);
}

// ── component ────────────────────────────────────────────────────────────────

export function RunSummary({ record, client, onBack, onContinue }: {
  record: RunRecord;
  client: QaClient;
  onBack: () => void;
  onContinue?: (cases: string[]) => void;
}): React.ReactElement {
  const [openSection, setOpenSection] = useState<string | null>("results");
  const [focusIdx, setFocusIdx] = useState(0);
  const [showChat, setShowChat] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  const { id, app, sha, target, mode, verdict, passed = 0, failed = 0, cases, specs, logs, note, retrying, parentRunId, ref: refName } = record;
  const total = cases.length;
  const failedCases = cases.filter((c: { status: string }) => c.status === "fail");
  const isShadow = logs.some((l: string) => l.includes("[SHADOW MODE]"));
  const coverageText = parseCoverageFromLogs(logs);
  const reviewText = parseReviewFromLogs(logs);
  const logTail = tailLogs(logs, 22);
  const duration = runDuration(record);

  const sections: Array<{ id: string; label: string }> = [
    { id: "pipeline", label: "Pipeline" },
    { id: "results", label: `Test results (${passed}/${total} passed${failed ? `, ${failed} failed` : ""})` },
    { id: "logs", label: `Execution logs (${logTail.length} lines)` },
    { id: "coverage", label: "Coverage" },
    ...(isShadow ? [{ id: "shadow", label: "Shadow mode feedback" }] : []),
    ...(note ? [{ id: "note", label: "Agent note" }] : []),
  ];

  const sectionCount = sections.length;

  const toggle = useCallback((id: string) => {
    setOpenSection((p) => p === id ? null : id);
  }, []);

  useInput((_char, key) => {
    if (showChat) {
      if (key.escape) { setShowChat(false); return; }
      return;
    }
    if (key.upArrow) { setFocusIdx((p) => (p - 1 + sectionCount) % sectionCount); return; }
    if (key.downArrow) { setFocusIdx((p) => (p + 1) % sectionCount); return; }
    if (key.return) { const s = sections[focusIdx]; if (s) toggle(s.id); return; }
    if (_char === "c" || _char === "C") { setShowChat((p) => !p); return; }
    if (_char === "e" || _char === "E") {
      try {
        const path = `./qa-run-${id.slice(0, 16)}.json`;
        writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
        setExported(path);
      } catch (err) {
        console.error(`[qa] export failed: ${err instanceof Error ? err.message : String(err)}`);
        setExported("(error writing file — check terminal for details)");
      }
      return;
    }
    if (_char === "f" || _char === "F") { if (failedCases.length && onContinue) onContinue(failedCases.map((c: { name: string }) => c.name)); return; }
    if (_char === "b" || _char === "B" || _char === " " || key.escape) { onBack(); return; }
  });

  const renderSection = (id: string): React.ReactElement => {
    switch (id) {
      case "pipeline": {
        const reviewInfo = reviewText
          ? reviewText.includes("approved=true")
            ? "reviewer approved"
            : reviewText.includes("corrections=")
              ? `reviewer rejected (${reviewText.match(/corrections=(\d+)/)?.[1] ?? "?"} corrections)`
              : `reviewer: ${reviewText}`
          : undefined;
        return (
          <Box flexDirection="column">
            {PIPELINE_STEPS.map((s) => {
              const st = stepState(record.step, s);
              const icon = st === "done" ? "✓" : st === "active" ? "·" : " ";
              const color = st === "done" ? "#3b7a57" : st === "active" ? "cyan" : undefined;
              const lbl = sectionLabel(s, st, { passed, failed, total }, specs?.length);
              const extra =
                s === "generate" && reviewInfo ? ` — ${reviewInfo}` :
                s === "execute" && record.stepDetail ? ` — ${record.stepDetail}` :
                s === "execute" && total > 0 && duration ? ` — ≈ ${duration}` :
                undefined;
              return (
                <Box key={s} flexDirection="column">
                  <Text>{"  "}<Text color={color}>{icon}</Text>{"  "}<Text dimColor={st === "pending"}>{lbl}</Text>{extra ? <Text dimColor>{extra}</Text> : null}</Text>
                </Box>
              );
            })}
          </Box>
        );
      }
      case "results": {
        const failedOnly = cases.filter((c: { status: string }) => c.status === "fail");
        const passedOnly = cases.filter((c: { status: string }) => c.status !== "fail");

        if (total === 0) {
          if (specs && specs.length > 0) {
            return (
              <Box flexDirection="column">
                <Text dimColor>  Specs generated ({specs.length}):</Text>
                {specs.slice(0, 15).map((s: { name: string; objective?: string }, i: number) => (
                  <Text key={i} dimColor>    · {s.name}{s.objective ? ` — ${s.objective.slice(0, 70)}` : ""}</Text>
                ))}
              </Box>
            );
          }
          return <Text dimColor>  No test results available for this run.</Text>;
        }

        return (
          <Box flexDirection="column">
            {/* Failed cases — most important, shown first with full error detail */}
            {failedOnly.map((c, i) => {
              const parsed = c.detail ? parseAssertionError(c.detail) : null;
              return (
                <Box key={`fail-${i}`} flexDirection="column">
                  <Alert variant="error">
                    <Box flexDirection="column" gap={1}>
                      <Box gap={1}>
                        <Badge color="red">FAIL</Badge>
                        <Text bold>{(c.flow ?? c.name).slice(0, 60)}</Text>
                      </Box>
                      {parsed ? (
                        <Box flexDirection="column">
                          <Text>{parsed.message.slice(0, 120)}</Text>
                          {parsed.expectLine ? <Text dimColor>  expected: {parsed.expectLine.slice(0, 60)}</Text> : null}
                          {parsed.actualLine ? <Text dimColor>  actual:   {parsed.actualLine.slice(0, 60)}</Text> : null}
                          {parsed.location ? <Text dimColor>  at {parsed.location}</Text> : null}
                        </Box>
                      ) : c.detail ? (
                        <Text dimColor>{c.detail.slice(0, 200)}</Text>
                      ) : null}
                    </Box>
                  </Alert>
                </Box>
              );
            })}

            {/* Passed cases — compact summary */}
            {passedOnly.length > 0 ? (
              <Box marginTop={failedOnly.length > 0 ? 1 : 0} flexDirection="column">
                <Text dimColor>
                  {`  ✓ ${passedOnly.length} passed: `}
                  {passedOnly.map((c, i) => (
                    <Text key={i} dimColor>
                      {(i > 0 ? ", " : "")}{(c.flow ?? c.name).slice(0, 40)}
                    </Text>
                  ))}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      }
      case "logs":
        return (
          <Box flexDirection="column">
            {logTail.length === 0 ? (
              <Text dimColor>  No logs recorded for this run.</Text>
            ) : (
              logTail.map((l, i) => (
                <Text key={i} dimColor>  {l.replace("[qa] ", "").slice(0, 140)}</Text>
              ))
            )}
          </Box>
        );
      case "coverage": {
        const covWarn = logs.find((l: string) => l.includes("CHANGE-COVERAGE INACTIVE"));
        return (
          <Box flexDirection="column">
            {coverageText ? (
              <Text dimColor>  {coverageText}</Text>
            ) : covWarn ? (
              <Box flexDirection="column">
                <Text color="#c2891b">  ⚠ Coverage measurement inactive.</Text>
                <Text dimColor>  {covWarn.replace("[qa] ", "").slice(0, 120)}</Text>
              </Box>
            ) : (
              <Text dimColor>  Coverage was not measured in this run.</Text>
            )}
          </Box>
        );
      }
      case "shadow":
        return (
          <Alert variant="warning">
            <Box flexDirection="column">
              <Text bold>Shadow mode is ON — no PRs or Issues were published</Text>
              {verdict === "pass" ? (
                <Text>A PR with {specs?.length ?? 0} spec(s) would have been opened in {app}.</Text>
              ) : verdict === "fail" ? (
                <Text>A GitHub Issue with sanitized error logs would have been opened in {app}.</Text>
              ) : verdict === "flaky" ? (
                <Text>Flaky tests would have been quarantined without PR or Issue.</Text>
              ) : (
                <Text>Shadow mode prevents publication to {app}.</Text>
              )}
            </Box>
          </Alert>
        );
      case "note":
        return <Text dimColor>  {note}</Text>;
      default:
        return <Text dimColor>  —</Text>;
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box flexDirection="column">
        <Box>
          <Text bold>{app}</Text>
          <Text dimColor>{`  ${shortId(id)}`}</Text>
        </Box>
        <Box>
          <Text>
            <Text dimColor>SHA </Text>{shortSha(sha)}
            {refName ? <Text dimColor>{`  ref ${refName}`}</Text> : null}
            <Text dimColor>{`  ${target}/${mode}`}</Text>
          </Text>
        </Box>
        {parentRunId ? (
          <Text dimColor>{`continuation of ${shortId(parentRunId)}`}</Text>
        ) : null}
        {retrying ? <Text color="#c2891b"> ↻ retried during execution</Text> : null}
        {isShadow ? <Text dimColor> [shadow mode]</Text> : null}

        <Box marginTop={1} gap={1}>
          <Badge color={verdict === "pass" || verdict === "skipped" ? "green" : verdict === "fail" || verdict === "invalid" ? "red" : verdict === "flaky" ? "yellow" : "blue"}>
            {verdict?.toUpperCase() ?? "RUNNING"}
          </Badge>
          {total > 0 ? (
            <Text dimColor>{`${passed} passed, ${failed} failed${failed ? `, ${total - passed - failed} flaky` : ""}`}</Text>
          ) : null}
        </Box>
      </Box>

      {/* Sections */}
      <Box flexDirection="column" marginTop={1}>
        {sections.map((s, i) => {
          const isOpen = openSection === s.id;
          const isFocused = focusIdx === i;
          return (
            <Box key={s.id} flexDirection="column">
              <Text>
                <Text color={isFocused ? "cyan" : undefined}>{isOpen ? "▾" : "▸"}</Text>
                {" "}<Text color={isFocused ? "cyan" : undefined}>{s.label}</Text>
              </Text>
              {isOpen ? <Box flexDirection="column" marginLeft={2}>{renderSection(s.id)}</Box> : null}
            </Box>
          );
        })}
      </Box>

      {/* Export feedback */}
      {exported ? (
        <Box marginTop={1}>
          <Text color="#3b7a57">{`✓ exported → ${exported}`}</Text>
        </Box>
      ) : null}

      {/* Footer */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{"─".repeat(60)}</Text>
        {showChat ? (
          <ChatInput client={client} runId={record.id} />
        ) : (
          <Box flexDirection="column">
            <Text dimColor>[↑↓] navigate  [↩] expand  [E]xport JSON  [C]hat  [Space/B/Esc] back</Text>
            {failedCases.length > 0 && onContinue ? (
              <Text dimColor>[F] continue — fix {failedCases.length} failed case(s)</Text>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}
