// Immutable case history. Shows the current running test during execution, and 
// a full pass/fail summary when done. Failures render with Alert for visibility.
import React from "react";
import { Text, Box } from "ink";
import { Alert, Badge } from "@inkjs/ui";
import { QaCase } from "../../types";
import { caseColor, caseIcon, parseAssertionError } from "../format";

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
  const last = items.length > 0 ? [items[items.length - 1]!] : [];
  return (
    <Box flexDirection="column">
      {last.map((item) => {
        if (item.status === "fail" && item.detail) {
          const parsed = parseAssertionError(item.detail);
          return (
            <Box key={item.name} flexDirection="column">
              <Alert variant="error">
                <Box flexDirection="column" gap={1}>
                  <Box gap={1}>
                    <Badge color={caseColor(item.status)}>FAIL</Badge>
                    <Text bold>{(item.flow ?? item.name).slice(0, 60)}</Text>
                  </Box>
                  <Text>{parsed.message.slice(0, 100)}</Text>
                  {parsed.expectLine ? <Text dimColor>  expected: {parsed.expectLine.slice(0, 60)}</Text> : null}
                  {parsed.actualLine ? <Text dimColor>  actual:   {parsed.actualLine.slice(0, 60)}</Text> : null}
                  {parsed.location ? <Text dimColor>  at {parsed.location}</Text> : null}
                </Box>
              </Alert>
            </Box>
          );
        }
        return (
          <Box key={item.name} flexDirection="column">
            <Text>
              {"  "}
              <Text color={caseColor(item.status)}>{caseIcon(item.status)}</Text>
              {" "}
              <Text dimColor={item.status === "pass"}>{(item.flow ?? item.name).slice(0, 60)}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
