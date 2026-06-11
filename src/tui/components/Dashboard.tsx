// The live run dashboard. Uses Section for collapsible pipeline steps and HistoryList
// for immutable case rendering.

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { Badge, ProgressBar } from "@inkjs/ui";
import { RunRecord } from "../../types";
import { QueueStatus } from "../client";
import {
  PIPELINE_STEPS, stepState, shortSha, verdictColor, verdictIcon,
  deriveActivityView, formatElapsed, ActivityView,
} from "../format";
import { Section } from "./Section";
import { HistoryList, toHistoryItems } from "./HistoryList";
import { FocusCard } from "./FocusCard";
import { LiveActivity } from "./LiveActivity";

function stepDetail(record: RunRecord, step: string, isActive: boolean, view: ActivityView): string | undefined {
  const { passed = 0, failed = 0, cases, specs, stepDetail: sd, note, retrying, target } = record;
  const total = cases.length;

  if (!isActive) return undefined;
  if (retrying && step === "execute") return note || sd || "re-generating with failure feedback...";

  const elapsed = view.elapsedMs > 0 ? ` · ${formatElapsed(view.elapsedMs)}` : "";

  switch (step) {
    case "generate": {
      // specs is populated only when the agent finishes; until then, files written
      // are the live proxy for "how much has it produced".
      const n = specs?.length ?? view.fileCount;
      const head = n > 0 ? `${n} spec${n !== 1 ? "s" : ""}` : "working";
      return `${head}${elapsed}`;
    }
    case "execute":
      if (total > 0) return `${total} case(s) — ${passed} passed, ${failed} failed`;
      if (target === "code") return `running test suite...${elapsed}`;
      return (sd || "running") + elapsed;
    case "coverage":
      return (sd || "mapping executed code to the diff") + elapsed;
    default:
      return sd || undefined;
  }
}

export function Dashboard({ record, queue }: { record: RunRecord; queue?: QueueStatus | null }): React.ReactElement {
  const { app, sha, target, mode, step, verdict, passed = 0, failed = 0, cases, specs } = record;
  const total = cases.length;
  const isCode = target === "code";

  // Aggregate the structured activity feed once per render (re-derived each poll,
  // so the elapsed clock ticks ~every 1.2s).
  const view = deriveActivityView(record.activity, { stepStartedAt: record.stepStartedAt });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold>{app}</Text>
        {` · ${shortSha(sha)} · `}
        <Text color={isCode ? "magenta" : "cyan"}>{target}</Text>
        {`/${mode}`}
        {record.retrying ? <Text color="#c2891b">{"  ↻ retrying"}</Text> : null}
      </Text>

      {/* Enqueued: the run has not started — make the waiting state unmistakable */}
      {record.status === "enqueued" ? (
        <Box marginTop={1} gap={1}>
          <Badge color="#c2891b">QUEUED</Badge>
          <Text color="#c2891b"><Spinner type="dots" /></Text>
          <Text dimColor>
            {"waiting for the queue"}
            {queue ? ` — ${queue.pending} pending${queue.running ? ` · running: ${queue.running.app}` : ""}` : ""}
          </Text>
        </Box>
      ) : null}

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
              detail={stepDetail(record, s, isActive, view)}
              caseCount={s === "execute" ? cc : undefined}
              specCount={s === "generate" ? specs?.length : undefined}
            >
              {/* Generate: the live panel — focus card + plan/wrote/ran feed */}
              {s === "generate" && isActive ? (
                <Box flexDirection="column">
                  {view.focus ? <FocusCard focus={view.focus} elapsed={formatElapsed(view.elapsedMs)} /> : null}
                  <LiveActivity view={view} />
                </Box>
              ) : null}
              {/* Execute (live): the test running right now (in-progress activity todo) */}
              {s === "execute" && isActive && !verdict && view.focus ? (
                <FocusCard focus={view.focus} label="running" elapsed={formatElapsed(view.elapsedMs)} />
              ) : null}
              {/* Execute: case history with the pass/fail bar */}
              {s === "execute" && total > 0 ? (
                <Box flexDirection="column">
                  <HistoryList items={toHistoryItems(cases)} />
                  <Box gap={1}>
                    <Text dimColor>Tests</Text>
                    <ProgressBar value={total > 0 ? (passed / total) * 100 : 0} />
                    <Text dimColor>{passed}/{total}</Text>
                  </Box>
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

      {/* Verdict — color/icon come from the shared format palette (one identity per verdict) */}
      {verdict ? (
        <Box marginTop={1} gap={1}>
          <Badge color={verdictColor(verdict)}>
            {`${verdictIcon(verdict)} ${verdict.toUpperCase()}`}
          </Badge>
          {record.note ? <Text dimColor>{record.note}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
