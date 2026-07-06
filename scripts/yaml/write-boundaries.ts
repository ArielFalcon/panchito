// scripts/yaml/write-boundaries.ts
// Hand-built writer for an app's `boundaries:` block in config/apps/<app>.yaml — the exact
// inverse of the READ side (yaml-boundary-profile.adapter.ts's REQUIRED_HTTP_STRING_FIELDS /
// REQUIRED_EVENT_PATTERN_STRING_FIELDS). Deliberately does NOT run `yaml.stringify` on the whole
// document: that would drop comments and re-flow unrelated `${VAR}` placeholders, churning the
// diff for a human reviewer (design §D). Instead this module:
//   1. serializeBoundary(profile) — hand-builds the lines for ONE profile, mirroring
//      config/apps/example.yaml's boundaries[] format verbatim.
//   2. spliceBoundariesBlock(doc, lines) — detects an existing top-level `boundaries:` key (plus
//      its indented children, up to the next top-level key or EOF) and REPLACES it in place;
//      appends a new block when absent. Every other line in the document — comments, other
//      `${VAR}` placeholders — survives byte-identical, because only the `boundaries:` span is
//      ever touched.
import type { BoundaryProfile } from "../../qa-engine/src/contexts/service-topology/domain/index.ts";

const INDENT = "  ";

/** Escapes `value` per the YAML double-quoted-scalar rules (YAML 1.1/1.2 §7.3.1) so it can be
 *  interpolated into a bare `"..."` scalar and read back byte-for-byte by the real parser.
 *  Every LLM-sourced free-form string passed to serializeBoundary goes through this — an
 *  unescaped `"`, `\`, or control character (notably a raw newline) either throws a
 *  YAMLParseError on the read side or, worse, is silently reinterpreted as a DIFFERENT escape
 *  sequence (e.g. a literal `\a` decodes to a BEL control character), corrupting the value
 *  without ever failing loudly. Backslash MUST be escaped first — escaping it after the other
 *  substitutions would double-escape the backslashes those substitutions just introduced. */
function escapeYamlDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Wraps `value` in a properly escaped YAML double-quoted scalar. */
function quoted(value: string): string {
  return `"${escapeYamlDoubleQuoted(value)}"`;
}

/** Hand-builds the `boundaries:` entry lines for a single profile — the exact inverse of
 *  parseHttpBoundaryProfile / parseEventBoundaryProfile. Field order mirrors
 *  config/apps/example.yaml so a human reviewer sees the familiar shape. Every free-form string
 *  value (including `kind` fields, which are schema-unconstrained today) is emitted through
 *  `quoted()` so no interpolated value can corrupt the surrounding YAML structure. */
export function serializeBoundary(profile: BoundaryProfile): string[] {
  if (profile.transport === "http") {
    const callSite = profile.frontCallSite.receiver
      ? `{ kind: ${quoted(profile.frontCallSite.kind)}, receiver: ${quoted(profile.frontCallSite.receiver)} }`
      : `{ kind: ${quoted(profile.frontCallSite.kind)} }`;
    return [
      `${INDENT}- transport: http`,
      `${INDENT}${INDENT}frontFiles: ${quoted(profile.frontFiles)}`,
      `${INDENT}${INDENT}frontCallSite: ${callSite}`,
      `${INDENT}${INDENT}servicePrefixTemplate: ${quoted(profile.servicePrefixTemplate)}`,
      `${INDENT}${INDENT}serviceRepoTemplate: ${quoted(profile.serviceRepoTemplate)}`,
      `${INDENT}${INDENT}openApiPath: ${quoted(profile.openApiPath)}`,
    ];
  }

  return [
    `${INDENT}- transport: event`,
    `${INDENT}${INDENT}files: ${quoted(profile.files)}`,
    `${INDENT}${INDENT}eventPattern:`,
    `${INDENT}${INDENT}${INDENT}kind: ${quoted(profile.eventPattern.kind)}`,
    `${INDENT}${INDENT}${INDENT}listenerBaseType: ${quoted(profile.eventPattern.listenerBaseType)}`,
    `${INDENT}${INDENT}${INDENT}listenerEventCall: ${quoted(profile.eventPattern.listenerEventCall)}`,
    `${INDENT}${INDENT}${INDENT}subscriberBaseType: ${quoted(profile.eventPattern.subscriberBaseType)}`,
    `${INDENT}${INDENT}${INDENT}publishCall: ${quoted(profile.eventPattern.publishCall)}`,
  ];
}

/** True for a line that ENDS the spliced block's span: a new top-level key (column 0, `key:`
 *  shape), a top-level (column 0) `#` comment, or a blank separator line. The block's own
 *  children (built by `serializeBoundary`) are always non-blank INDENTED lines, so a
 *  non-indented comment can only be a document-level comment describing whatever follows the
 *  block — it is never part of the block itself. An indented comment (e.g.
 *  `    # some note`) is still inside the block's own content and must NOT end the span here;
 *  only a column-0 `#` does. */
function endsBoundariesBlock(line: string): boolean {
  return line === "" || /^[A-Za-z0-9_]+:/.test(line) || /^#/.test(line);
}

/** Splices a `boundaries:\n<entries>` block into `doc`, replacing any existing top-level
 *  `boundaries:` key (and its indented children, until the next top-level key or EOF) or
 *  appending a new block when absent. `entryLines` is the concatenation of one or more
 *  `serializeBoundary()` results. Every other line — comments, other `${VAR}` placeholders,
 *  content before/after the block — is preserved byte-identical; this never re-serializes the
 *  whole document. Idempotent: splicing the same profile twice yields the same output. */
export function spliceBoundariesBlock(doc: string, entryLines: readonly string[]): string {
  const lines = doc.split("\n");
  const newBlock = ["boundaries:", ...entryLines];

  const startIndex = lines.findIndex((line) => line === "boundaries:");
  if (startIndex === -1) {
    // Append: keep exactly one blank-line separator if the doc doesn't already end in one, and
    // preserve whatever trailing-newline shape the doc already had (so a second splice — which
    // now takes the replace branch below — produces byte-identical output; idempotency check).
    const endsWithBlankLine = lines.length > 0 && lines[lines.length - 1] === "";
    const base = endsWithBlankLine ? lines.slice(0, -1) : lines;
    const needsSeparator = base.length > 0 && base[base.length - 1] !== "";
    const tail = endsWithBlankLine ? [""] : [];
    return [...base, ...(needsSeparator ? [""] : []), ...newBlock, ...tail].join("\n");
  }

  let endIndex = startIndex + 1;
  while (endIndex < lines.length && !endsBoundariesBlock(lines[endIndex] ?? "")) {
    endIndex += 1;
  }

  const before = lines.slice(0, startIndex);
  const after = lines.slice(endIndex);
  return [...before, ...newBlock, ...after].join("\n");
}
