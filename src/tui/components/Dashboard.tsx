// The live run dashboard. Uses Section for collapsible pipeline steps and HistoryList
// for immutable case rendering.

import React from "react";
import { Box, Text } from "ink";
import { RunRecord } from "../../types";
import {
  PIPELINE_STEPS, stepState, progressBar, verdictColor, verdictIcon, shortSha,
  deriveActivityView, formatElapsed, ActivityView,
} from "../format";
import { Section } from "./Section";
import { HistoryList, toHistoryItems } from "./HistoryList";
import { FocusCard } from "./FocusCard";
import { LiveActivity } from "./LiveActivity";
import { listLearningRules, loadCurriculum } from "../../server/history";

function learningSummary(app: string): string | null {
  try {
    const rules = listLearningRules(app, 50);
    const curriculum = loadCurriculum(app);
    const activeRules = rules.filter((r) => r.status === "active" || r.status === "candidate");
    const proven = curriculum?.archetypes.filter((a) => a.caughtRealBug).length ?? 0;
    const total = curriculum?.archetypes.length ?? 10;
    if (activeRules.length === 0 && proven === 0) return null;
    const parts: string[] = [];
    if (activeRules.length > 0) parts.push(`${activeRules.length} rules`);
    if (proven > 0) parts.push(`${proven}/${total} archetypes`);
    return `📊 learning: ${parts.join(", ")}`;
  } catch {
    return null;
  }
}

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
    default:
      return sd || undefined;
  }
}

export function Dashboard({ record }: { record: RunRecord }): React.ReactElement {
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

      {/* Learning state summary */}
      {verdict ? (() => { const ls = learningSummary(app); return ls ? <Box marginTop={0}><Text dimColor>{ls}</Text></Box> : null; })() : null}
    </Box>
  );
}
