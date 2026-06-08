// Immutable case history. Uses Ink <Static> so completed items never re-render.
// Each case shows flow as title, objective/reason as context, and colored status.

import React from "react";
import { Text, Box } from "ink";
import { QaCase } from "../../types";
import { caseColor, caseIcon } from "../format";

export interface HistoryItem {
  name: string;
  status: QaCase["status"];
  flow?: string;
  objective?: string;
  reason?: string;
  detail?: string;
}

export function toHistoryItems(cases: QaCase[]): HistoryItem[] {
  return cases.map((c) => ({
    name: c.name,
    status: c.status,
    flow: c.flow,
    objective: c.objective,
    reason: c.reason,
    detail: c.detail,
  }));
}

export function HistoryList({ items }: { items: HistoryItem[] }): React.ReactElement {
  // Only show the LAST item — during execution, the current test is the only
  // relevant one. When done, the Section label already summarizes totals.
  const last = items.length > 0 ? [items[items.length - 1]!] : [];
  return (
    <Box flexDirection="column">
      {last.map((item) => (
        <Box key={item.name} flexDirection="column">
          <Text>
            {"  "}
            <Text color={caseColor(item.status)}>{caseIcon(item.status)}</Text>
            {" "}
            <Text>{(item.flow ?? item.name).slice(0, 60)}</Text>
          </Text>
          {item.detail && item.status === "fail" ? (
            <Text color="#c0392b">{`     ${item.detail.slice(0, 120)}`}</Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
