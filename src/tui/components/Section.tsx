// Collapsible pipeline step. Active: spinner + detail. Done: checkmark.
// Pending: dim dot, no detail.

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { PipelineStep, StepState, sectionLabel } from "../format";

export interface SectionProps {
  step: PipelineStep;
  state: StepState;
  detail?: string;
  summary?: string;
  caseCount?: { passed: number; failed: number; total: number };
  specCount?: number;
  children?: React.ReactNode;
}

export function Section({ step, state, detail, summary, caseCount, specCount, children }: SectionProps): React.ReactElement {
  const label = sectionLabel(step, state, caseCount ?? { passed: 0, failed: 0, total: 0 }, specCount);

  const icon = state === "active"
    ? <Text color="cyan"><Spinner type="dots" /></Text>
    : state === "done"
    ? <Text color="#3b7a57">✓</Text>
    : <Text dimColor>·</Text>;

  return (
    <Box flexDirection="column">
      <Text>
        {"  "}{icon}{"  "}
        <Text dimColor={state === "pending"}>{label}</Text>
        {state === "active" && detail ? <Text dimColor>{` — ${detail}`}</Text> : null}
        {state === "done" && summary ? <Text dimColor>{` — ${summary}`}</Text> : null}
      </Text>
      {state === "active" && children ? (
        <Box flexDirection="column" marginLeft={5}>
          {children}
        </Box>
      ) : null}
    </Box>
  );
}
