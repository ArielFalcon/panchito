// The live run dashboard. Uses Section for collapsible pipeline steps and HistoryList
// for immutable case rendering. Specs are always visible (not hidden when step completes).

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { RunRecord } from "../../types";
import { PIPELINE_STEPS, stepState, progressBar, verdictColor, verdictIcon, shortSha } from "../format";
import { Section } from "./Section";
import { HistoryList, toHistoryItems } from "./HistoryList";

export function Dashboard({ record }: { record: RunRecord }): React.ReactElement {
  const { app, sha, target, mode, step, verdict, passed = 0, failed = 0, cases, specs } = record;
  const total = cases.length;
  const isCode = target === "code";

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Text>
        <Text bold>{app}</Text>
        {` · ${shortSha(sha)} · `}
        <Text color={isCode ? "magenta" : "cyan"}>{target}</Text>
        {`/${mode}`}
        {record.retrying ? <Text color="yellow">{"  ↻ retrying"}</Text> : null}
      </Text>

      {/* Pipeline sections */}
      <Box flexDirection="column" marginTop={1}>
        {PIPELINE_STEPS.map((s) => {
          const st = stepState(step, s);
          const cc = { passed, failed, total };

          return (
            <Section
              key={s}
              step={s}
              state={st}
              detail={s === step ? record.stepDetail : undefined}
              caseCount={s === "execute" ? cc : undefined}
              specCount={s === "generate" ? specs?.length : undefined}
            >
              {/* Execute: immutable case history */}
              {s === "execute" && total > 0 ? (
                <Box flexDirection="column">
                  <HistoryList items={toHistoryItems(cases)} />
                  <Text>
                    {"  "}
                    <Text color={failed > 0 ? "red" : "green"}>
                      {progressBar(passed, total)}
                    </Text>
                    {`  ${passed}/${total}`}
                  </Text>
                </Box>
              ) : null}
            </Section>
          );
        })}
      </Box>

      {/* Specs: always visible when present, not hidden when generate completes */}
      {specs?.length ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={3}>
          {specs.map((sp) => (
            <Box key={sp.name} flexDirection="column">
              <Text dimColor>{sp.name}</Text>
              {sp.objective ? <Text dimColor>{`  objective: ${sp.objective}`}</Text> : null}
              {sp.flow ? <Text dimColor>{`  flow: ${sp.flow}`}</Text> : null}
            </Box>
          ))}
        </Box>
      ) : null}

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
      ) : (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" />
            {" running…"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
