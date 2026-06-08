// Post-execution summary screen. Shown after a run reaches a verdict.
// Interactive: keyboard navigation (↑↓ expand sections, C/R/B actions).
// Sections: Pipeline steps, Test results, Coverage, Shadow feedback, Agent note.

import React, { useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import { RunRecord } from "../../types";
import { PIPELINE_STEPS, stepState, sectionLabel, progressBar, verdictColor, verdictIcon, shortSha, caseColor, caseIcon } from "../format";
import type { PipelineStep, StepState } from "../format";
import { ChatInput } from "./ChatInput";
import type { QaClient } from "../client";

interface SectionDef {
  id: string;
  label: string;
  render(open: boolean): React.ReactElement;
  defaultOpen?: boolean;
}

export function RunSummary({ record, client, onBack }: {
  record: RunRecord;
  client: QaClient;
  onBack: () => void;
}): React.ReactElement {
  const [openSection, setOpenSection] = useState<string | null>("results");
  const [focusIdx, setFocusIdx] = useState(0);
  const [selectedCase, setSelectedCase] = useState<number | null>(null);
  const [showChat, setShowChat] = useState(false);

  const { app, sha, target, mode, verdict, passed = 0, failed = 0, cases, specs, logs, note, retrying } = record;
  const total = cases.length;
  const isCode = target === "code";

  const sections: SectionDef[] = [
    {
      id: "pipeline",
      label: "Pipeline",
      defaultOpen: false,
      render: (open) => (
        <Box flexDirection="column">
          {PIPELINE_STEPS.map((s) => {
            const st = stepState(record.step, s);
            const icon = st === "done" ? "✓" : st === "active" ? "·" : " ";
            const color = st === "done" ? "#3b7a57" : st === "active" ? "cyan" : undefined;
            const lbl = sectionLabel(s, st, { passed, failed, total: cases.length }, specs?.length);
            return (
              <Text key={s}>
                {"  "}<Text color={color}>{icon}</Text>{"  "}<Text dimColor={st === "pending"}>{lbl}</Text>
              </Text>
            );
          })}
        </Box>
      ),
    },
    {
      id: "results",
      label: "Test results",
      defaultOpen: true,
      render: (open) => (
        <Box flexDirection="column">
          {cases.length === 0 ? (
            <Text dimColor>  No test cases recorded for this run.</Text>
          ) : (
            cases.map((c, i) => (
              <Box key={i} flexDirection="column">
                <Text>
                  {"  "}
                  <Text color={caseColor(c.status)}>{caseIcon(c.status)}</Text>
                  {" "}{c.flow ?? c.name}
                </Text>
                {c.flow && isCode ? (
                  <Text dimColor>    {c.flow}</Text>
                ) : null}
                {c.detail && c.status === "fail" && (selectedCase === i || selectedCase === null) ? (
                  <Text color="#c0392b">    {c.detail.slice(0, 200)}</Text>
                ) : null}
                {c.status === "fail" && c.detail && (selectedCase !== i) ? (
                  <Text dimColor>    [↩] ver detalle</Text>
                ) : null}
              </Box>
            ))
          )}
          {specs && specs.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>  Specs generated ({specs.length}):</Text>
              {specs.slice(0, 12).map((s: { name: string; objective?: string }) => (
                <Text key={s.name} dimColor>    · {s.name}{s.objective ? ` — ${s.objective.slice(0, 80)}` : ""}</Text>
              ))}
              {specs.length > 12 ? <Text dimColor>    … and {specs.length - 12} more</Text> : null}
            </Box>
          ) : null}
        </Box>
      ),
    },
    {
      id: "shadow",
      label: isCode ? "What would happen (shadow mode)" : "Shadow mode",
      render: () => (
        <Box flexDirection="column">
          {record.note && record.note.includes("shadow") ? (
            <Text dimColor>  {record.note}</Text>
          ) : verdict === "pass" ? (
            <Text dimColor>  Si no estuviera en shadow mode, se habría abierto un PR{'\n'}  en {app} con los tests generados. El reviewer {'\n'}  {specs?.length ? `aprobó ${specs.length} specs.` : "aprobó los tests."}</Text>
          ) : verdict === "fail" ? (
            <Text dimColor>  Si no estuviera en shadow mode, se habría abierto un{'\n'}  GitHub Issue en {app} con los logs de error.</Text>
          ) : verdict === "flaky" ? (
            <Text dimColor>  Tests inestables — se habrían puesto en cuarentena.{'\n'}  No se habría abierto PR ni Issue.</Text>
          ) : (
            <Text dimColor>  Shadow mode activo — no se publicaron PRs ni Issues.</Text>
          )}
        </Box>
      ),
    },
    {
      id: "coverage",
      label: "Coverage",
      render: () => {
        const covLog = logs.find((l: string) => l.includes("change-coverage:"));
        const covWarn = logs.find((l: string) => l.includes("CHANGE-COVERAGE INACTIVE"));
        return (
          <Box flexDirection="column">
            {covLog ? (
              <Text dimColor>  {covLog.replace("[qa] change-coverage: ", "")}</Text>
            ) : covWarn ? (
              <Box flexDirection="column">
                <Text color="#c2891b">  ⚠ No se pudo medir cobertura.</Text>
                <Text dimColor>  {covWarn.replace("[qa] ", "").slice(0, 100)}</Text>
              </Box>
            ) : (
              <Text dimColor>  No se midió cobertura en este run.</Text>
            )}
          </Box>
        );
      },
    },
    ...(note ? [{
      id: "note",
      label: "Agent note",
      render: () => <Text dimColor>  {note}</Text>,
    }] : []),
  ];

  // Keyboard navigation
  useInput((_char, key) => {
    if (showChat) return;
    if (key.upArrow) { setFocusIdx((p) => Math.max(0, p - 1)); return; }
    if (key.downArrow) { setFocusIdx((p) => Math.min(sections.length - 1, p + 1)); return; }
    if (key.return) {
      const id = sections[focusIdx]?.id;
      if (id) setOpenSection((p) => p === id ? null : id);
      else if (focusIdx === sections.length) setSelectedCase((p) => p === null ? 0 : null);
      return;
    }
    if (_char === "c" || _char === "C") { setShowChat(true); return; }
    if (_char === "b" || _char === "B" || key.escape) { onBack(); return; }
  });

  // Filter sections for display
  const visible = sections.filter((s) => {
    if (s.id === "shadow" && (!record.note || !record.note.includes("shadow"))) return true; // always show when shadow is relevant
    if (s.id === "shadow") return record.verdict !== undefined; // show shadow info for any completed run
    return true;
  });

  // Focus includes case items for drill-down
  const caseFocusStart = visible.length;

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
        </Text>
        <Box marginTop={1}>
          <Text color={verdictColor(verdict)} bold>
            {`${verdictIcon(verdict)} verdict: ${verdict ?? "running"}`}
          </Text>
          {passed !== undefined && failed !== undefined && total > 0 ? (
            <Text dimColor>{` — ${passed} passed, ${failed} failed`}</Text>
          ) : null}
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
                <Text color={isFocused ? "cyan" : undefined}>
                  {isOpen ? "▾" : "▸"}
                </Text>
                {" "}{s.label}
              </Text>
              {isOpen ? (
                <Box flexDirection="column" marginLeft={2}>
                  {s.render(true)}
                </Box>
              ) : null}
            </Box>
          );
        })}

        {/* Case detail drill-down */}
        {cases.filter((c: { status: string }) => c.status === "fail").length > 0 && openSection === "results" ? (
          <Box marginTop={1}>
            <Text dimColor>
              [↩] on a failed case to toggle detail
            </Text>
          </Box>
        ) : null}
      </Box>

      {/* Footer */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{"─".repeat(60)}</Text>
        {showChat ? (
          <ChatInput client={client} runId={record.id} />
        ) : (
          <Box flexDirection="column">
            <Text dimColor>
              {"[↑↓] navegar  [↩] expandir  [C]hat  [B]ack  [Esc] salir"}
            </Text>
            {cases.some((c: { status: string }) => c.status === "fail") ? (
              <Text dimColor>
                {"[F]ix failed cases"}
              </Text>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}
