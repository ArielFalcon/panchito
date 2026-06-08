// The live run dashboard. Uses Section for collapsible pipeline steps and HistoryList
// for immutable case rendering.

import React from "react";
import { Box, Text } from "ink";
import { RunRecord } from "../../types";
import { PIPELINE_STEPS, stepState, progressBar, verdictColor, verdictIcon, shortSha } from "../format";
import { Section } from "./Section";
import { HistoryList, toHistoryItems } from "./HistoryList";

function stepDetail(record: RunRecord, step: string, isActive: boolean): string | undefined {
  const { passed = 0, failed = 0, cases, specs, stepDetail: sd, note, retrying, target, logs } = record;
  const total = cases.length;

  if (!isActive) return undefined;
  if (retrying && step === "execute") return note || sd || "re-generating with failure feedback...";

  switch (step) {
    case "generate":
      if (specs?.length) return `${specs.length} spec(s) written so far`;
      if (sd) return sd;
      // Fallback: show the last meaningful SSE event (file write, tool run, todo)
      return lastMeaningfulLog(logs) || undefined;
    case "execute":
      if (total > 0) return `${total} case(s) — ${passed} passed, ${failed} failed`;
      if (target === "code") return "running test suite...";
      return sd || undefined;
    default:
      return sd || undefined;
  }
}

// Returns the last log line that carries actionable information — file writes,
// tool executions, or todo updates. Skips heartbeats and empty/whitespace lines.
function lastMeaningfulLog(logs: string[]): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i]!.replace(/^\[qa\] /, "");
    if (!line.trim()) continue;
    if (line.startsWith("agent active")) continue;
    if (line.startsWith("agent is working")) continue;
    return line.slice(0, 80);
  }
  return null;
}

export function Dashboard({ record }: { record: RunRecord }): React.ReactElement {
  const { app, sha, target, mode, step, verdict, passed = 0, failed = 0, cases, specs } = record;
  const total = cases.length;
  const isCode = target === "code";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold>{app}</Text>
        {` · ${shortSha(sha)} · `}
        <Text color={isCode ? "magenta" : "cyan"}>{target}</Text>
        {`/${mode}`}
        {record.retrying ? <Text color="#c2891b">{"  ↻ retrying"}</Text> : null}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {PIPELINE_STEPS.map((s) => {
          const st = stepState(step, s);
          const cc = { passed, failed, total };
          const isActive = s === step || (step === "retry" && s === "execute");

          return (
            <Section
              key={s}
              step={s}
              state={st}
              detail={stepDetail(record, s, isActive)}
              caseCount={s === "execute" ? cc : undefined}
              specCount={s === "generate" ? specs?.length : undefined}
            >
              {/* Execute: case history with pending specs */}
              {s === "execute" && total > 0 ? (
                <Box flexDirection="column">
                  <HistoryList items={toHistoryItems(cases)} />
                  <Text>
                    {"  "}
                    <Text color={failed > 0 ? "#c0392b" : "#3b7a57"}>
                      {progressBar(passed, total)}
                    </Text>
                    {`  ${passed}/${total}`}
                  </Text>
                </Box>
              ) : null}
              {/* Execute: pending specs (not yet run), shown only when execute is active/pending */}
              {s === "execute" && total === 0 && st !== "done" && specs?.length ? (
                <Box flexDirection="column" marginLeft={3}>
                  {specs.map((sp) => (
                    <Text key={sp.name} dimColor>{`· ${sp.name}`}</Text>
                  ))}
                </Box>
              ) : null}
            </Section>
          );
        })}
      </Box>

      {/* Code target: binary result */}
      {isCode && total === 0 && verdict ? (
        <Box marginTop={1}>
          <Text dimColor>
            code tests: {verdict === "pass" ? "all passed" : "failures detected"} (binary pass/fail)
          </Text>
        </Box>
      ) : null}

      {/* Verdict */}
      {verdict ? (
        <Box marginTop={1}>
          <Text color={verdictColor(verdict)} bold>
            {`${verdictIcon(verdict)} verdict: ${verdict}`}
          </Text>
          {record.note ? <Text dimColor>{` — ${record.note}`}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
