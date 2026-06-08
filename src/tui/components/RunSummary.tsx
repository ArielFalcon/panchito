// Post-execution summary screen. Interactive: keyboard navigation (↑↓ expand,
// ↩ toggle detail, C/R/B/F actions). Sections collapse/expand one at a time.

import React, { useCallback, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { RunRecord } from "../../types";
import { PIPELINE_STEPS, stepState, sectionLabel, verdictColor, verdictIcon, shortSha, caseColor, caseIcon } from "../format";
import { ChatInput } from "./ChatInput";
import type { QaClient } from "../client";

export function RunSummary({ record, client, onBack, onContinue }: {
  record: RunRecord;
  client: QaClient;
  onBack: () => void;
  onContinue?: (cases: string[]) => void;
}): React.ReactElement {
  const [openSection, setOpenSection] = useState<string | null>("results");
  const [focusIdx, setFocusIdx] = useState(0);
  const [showChat, setShowChat] = useState(false);

  const { app, sha, target, mode, verdict, passed = 0, failed = 0, cases, specs, logs, note, retrying } = record;
  const total = cases.length;
  const isCode = target === "code";
  const failedCases = cases.filter((c: { status: string }) => c.status === "fail");
  // Detect shadow mode from the first pipeline log line: "[SHADOW MODE]"
  const isShadow = logs.some((l: string) => l.includes("[SHADOW MODE]"));

  const sections: Array<{ id: string; label: string; always?: boolean }> = [
    { id: "pipeline", label: "Pipeline" },
    { id: "results", label: "Test results", always: true },
    { id: "coverage", label: "Coverage" },
    ...(isShadow ? [{ id: "shadow", label: "Shadow mode feedback", always: true }] : []),
    ...(note ? [{ id: "note", label: "Agent note" }] : []),
  ];

  const visible = sections.filter(() => true);
  const sectionCount = visible.length;

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
    if (key.return) { const s = visible[focusIdx]; if (s) toggle(s.id); return; }
    if (_char === "c" || _char === "C") { setShowChat((p) => !p); return; }
    if (_char === "f" || _char === "F") { if (failedCases.length && onContinue) onContinue(failedCases.map((c: { name: string }) => c.name)); return; }
    if (_char === "b" || _char === "B" || key.escape) { onBack(); return; }
  });

  const renderSection = (id: string): React.ReactElement => {
    switch (id) {
      case "pipeline":
        return (
          <Box flexDirection="column">
            {PIPELINE_STEPS.map((s) => {
              const st = stepState(record.step, s);
              const icon = st === "done" ? "✓" : st === "active" ? "·" : " ";
              const color = st === "done" ? "#3b7a57" : st === "active" ? "cyan" : undefined;
              const lbl = sectionLabel(s, st, { passed, failed, total }, specs?.length);
              return <Text key={s}>{"  "}<Text color={color}>{icon}</Text>{"  "}<Text dimColor={st === "pending"}>{lbl}</Text></Text>;
            })}
          </Box>
        );
      case "results": {
        // Correlate execution cases with generation specs by matching the spec
        // file name (or flow prefix) to the case name. For e2e, each Playwright
        // test carries its spec file. For code, the agent's specs are listed
        // alongside the parsed test counts.
        const specMap = new Map<string, { name: string; flow?: string; objective?: string }>();
        if (specs) {
          for (const s of specs) {
            const key = s.flow || s.name;
            if (key && !specMap.has(key)) specMap.set(key, s);
          }
        }

        // Group cases by their flow prefix (first word or text before " › ").
        const casesByFlow = new Map<string, typeof cases>();
        for (const c of cases) {
          const flowFromName = c.name.split(" › ")[0]?.trim() || c.name;
          const key = c.flow || flowFromName;
          const existing = casesByFlow.get(key) || [];
          existing.push(c);
          casesByFlow.set(key, existing);
        }

        // Build display: for each spec, show its cases. For unmatched cases, show separately.
        const displayed: Array<{ label: string; flow: string; cases: typeof cases; isSpec: boolean }> = [];

        // First: specs with their cases
        for (const [flow, spec] of specMap) {
          const flowCases = casesByFlow.get(flow) || [];
          casesByFlow.delete(flow);
          const pass = flowCases.filter((c: { status: string }) => c.status !== "fail").length;
          displayed.push({
            label: spec.objective || spec.name,
            flow,
            cases: flowCases,
            isSpec: true,
          });
        }

        // Then: unmatched cases
        for (const [flow, flowCases] of casesByFlow) {
          const pass = flowCases.filter((c: { status: string }) => c.status !== "fail").length;
          displayed.push({ label: flow, flow, cases: flowCases, isSpec: false });
        }

        // If nothing to show, fall back to simple output
        if (displayed.length === 0) {
          if (total > 0) {
            return (
              <Box flexDirection="column">
                {cases.map((c, i) => (
                  <Box key={i} flexDirection="column">
                    <Text>{"  "}<Text color={caseColor(c.status)}>{caseIcon(c.status)}</Text>{" "}{c.flow ?? c.name.slice(0, 70)}</Text>
                    {c.status === "fail" && c.detail ? <Text color="#c0392b">     {c.detail.slice(0, 200)}</Text> : null}
                  </Box>
                ))}
              </Box>
            );
          }
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
            {displayed.map((d) => {
              const failCount = d.cases.filter((c: { status: string }) => c.status === "fail").length;
              const passCount = d.cases.length - failCount;
              const allPass = failCount === 0 && d.cases.length > 0;
              const icon = d.cases.length === 0 ? "·" : allPass ? "✓" : "✗";
              const color = d.cases.length === 0 ? undefined : allPass ? "#3b7a57" : "#c0392b";
              return (
                <Box key={d.flow} flexDirection="column">
                  <Text>{"  "}<Text color={color}>{icon}</Text>{" "}{d.label}{d.cases.length > 0 ? ` — ${passCount}/${d.cases.length} passed` : " — not executed"}</Text>
                  {d.cases.filter((c: { status: string }) => c.status === "fail").map((c, i) => (
                    <Box key={i} flexDirection="column" marginLeft={4}>
                      <Text color="#c0392b">✗ {c.name.slice(0, 80)}</Text>
                      {c.detail ? <Text color="#c0392b">  {c.detail.slice(0, 200)}</Text> : null}
                    </Box>
                  ))}
                </Box>
              );
            })}
            {verdict === "infra-error" && note ? (
              <Box marginTop={1}><Text color="#4a6877">  {note}</Text></Box>
            ) : null}
          </Box>
        );
      }
      case "coverage": {
        const covLog = logs.find((l: string) => l.includes("change-coverage:"));
        const covWarn = logs.find((l: string) => l.includes("CHANGE-COVERAGE INACTIVE"));
        return (
          <Box flexDirection="column">
            {covLog ? (
              <Text dimColor>  {covLog.replace("[qa] change-coverage: ", "")}</Text>
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
          <Box flexDirection="column">
            <Text dimColor>  Shadow mode is ON — no PRs or Issues were published.</Text>
            {verdict === "pass" ? (
              <Text dimColor>  If shadow were off: a PR with {specs?.length ?? 0} spec(s){'\n'}  would have been opened in {app}. The reviewer{'\n'}  {specs?.length ? 'approved.' : 'did not review.'}</Text>
            ) : verdict === "fail" ? (
              <Text dimColor>  If shadow were off: a GitHub Issue with sanitized{'\n'}  error logs would have been opened in {app}.</Text>
            ) : verdict === "flaky" ? (
              <Text dimColor>  If shadow were off: flaky tests would have been{'\n'}  quarantined without PR or Issue.</Text>
            ) : (
              <Text dimColor>  Shadow mode prevents publication to {app}.</Text>
            )}
          </Box>
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
        <Text>
          <Text bold>{app}</Text>
          {` · ${shortSha(sha)} · `}
          <Text color={isCode ? "magenta" : "cyan"}>{target}</Text>
          {`/${mode}`}
          {retrying ? <Text color="#c2891b">{"  ↻ retrying"}</Text> : null}
          {isShadow ? <Text dimColor>{"  [shadow]"}</Text> : null}
        </Text>
        <Box marginTop={1}>
          <Text color={verdictColor(verdict)} bold>
            {`${verdictIcon(verdict)} verdict: ${verdict ?? "running"}`}
          </Text>
          {total > 0 ? <Text dimColor>{` — ${passed} passed, ${failed} failed`}</Text> : null}
        </Box>
      </Box>

      {/* Sections */}
      <Box flexDirection="column" marginTop={1}>
        {visible.map((s, i) => {
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

      {/* Footer */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{"─".repeat(60)}</Text>
        {showChat ? (
          <ChatInput client={client} runId={record.id} />
        ) : (
          <Box flexDirection="column">
            <Text dimColor>[↑↓] navigate  [↩] expand  [C]hat  [B]ack  [Esc] quit</Text>
            {failedCases.length > 0 && onContinue ? (
              <Text dimColor>[F] continue — fix {failedCases.length} failed case(s)</Text>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}
