// service-topology/infrastructure/event-pattern-catalog.ts
// The event-pattern SHAPE catalog: each entry knows how to find listener/publisher class-based
// domain-event occurrences in a Java-ish source file. Config supplies the concrete base-type
// and method names (via EventPatternRef); the shape itself — extends/implements a base type,
// call a named method with a `.class` argument, an interface extending a generic subscriber
// type — lives here, in the core, exactly once. This is the ONLY place the class-based-events
// shape is defined; every literal identifier used in the regexes below comes from the
// EventPatternRef argument, never a hardcoded string (Invariant #1: app-specificity lives only
// in config, never a literal in src/).
import type { EventPatternRef } from "../domain/index.ts";

/** Escape regex metacharacters so a config-supplied type/method name is matched literally. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A single occurrence found in one file's text, discriminated by `role`. Kept as ONE union
 *  (rather than 4 separate extractor functions) so `event-resolver.adapter.ts` can run one
 *  extraction pass per file and then dispatch by role — the catalog owns 100% of the
 *  parsing/regex logic, the resolver owns 100% of the cross-repo JOIN logic. */
export type EventPatternOccurrence =
  | { role: "listener"; className: string; eventName: string }
  | { role: "broker-interface"; className: string; modelName: string }
  | { role: "broker-impl"; className: string; brokerInterfaceName: string }
  | { role: "publisher"; className: string; eventName: string };

/** Extracts event-pattern occurrences from one file's text, guided by the config-supplied ref. */
export type EventPatternExtractor = (fileText: string, ref: EventPatternRef) => EventPatternOccurrence[];

// ---- Comment stripping ----
// Strip `//` line comments and `/* ... */` block comments BEFORE running any class-detection
// regex. Without this, the word "class" (or a base-type/method name) appearing in prose/Javadoc
// would be mistaken for a real declaration by the class-boundary scan below. Replacing with
// spaces (not deleting) preserves character offsets, which the enclosing-class backward scan
// relies on to stay aligned with the ORIGINAL text's brace structure.
function stripComments(text: string): string {
  // Block comments first (they may contain `//` inside, e.g. a URL in a Javadoc).
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  // Line comments: from `//` to end-of-line, preserving the newline itself.
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

// ---- Enclosing-class detection (class-level granularity, no method-level needed here) ----
// A brace-aware backward scan: from the publish-call match index, walk backward counting braces.
// Every unmatched `}` encountered while scanning backward means "I've exited one nested scope
// deeper" — increment depth. Every `{` decrements depth; when depth goes negative, that `{` is
// the opening brace of the scope directly enclosing the call-site. From there, scan further
// backward for the nearest `class <Name>` declaration — that is the enclosing class.
// This is simpler than an AST walk and suffices because we only need class-level granularity
// (see EventPatternRef design note in the domain — no method name is emitted here).
const CLASS_DECL_RE = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/** Find the nearest `class <Name>` declaration whose body encloses `matchIndex`, by walking
 *  backward from `matchIndex`, tracking brace depth, until the opening `{` of the immediately
 *  enclosing block is found, then taking the LAST class declaration before that point. This is
 *  the exact fix for the deleted spike's bug: "take the first class in the file" is replaced by
 *  "take the class whose braces actually contain the call-site". */
function findEnclosingClass(text: string, matchIndex: number): string | null {
  let depth = 0;
  let openBraceIndex = -1;
  for (let i = matchIndex - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        openBraceIndex = i;
        break;
      }
      depth--;
    }
  }
  if (openBraceIndex === -1) return null; // no enclosing block found — malformed/truncated input
  // Walk backward from the enclosing brace for the nearest preceding `class <Name>` — this is
  // the class whose body starts at (or before) openBraceIndex and therefore contains matchIndex.
  const before = text.slice(0, openBraceIndex);
  let lastName: string | null = null;
  CLASS_DECL_RE.lastIndex = 0;
  for (let m; (m = CLASS_DECL_RE.exec(before)) !== null;) {
    const name = m[1];
    if (name) lastName = name; // keep the LAST (nearest) match — classes can nest/repeat
  }
  return lastName;
}

// ---- Listener extraction ----
// Shape: `class <ListenerName> extends|implements <listenerBaseType> { ... <listenerEventCall>(message, <EventName>.class) ... }`
// The listener's own class name and the base-type relation (extends OR implements — both
// tolerated) are found together; the consumed event name comes from the SAME class body's
// listenerEventCall invocation, so we scan the class body text between this class's opening
// brace and its matching closing brace (found via a forward brace-depth walk).

/** Find the character range [start, end) of the body of the class starting at `classNameEnd`
 *  (the index right after the class name, before "extends"/"implements"/"{"). Returns null if
 *  no balanced opening/closing brace pair is found. */
function findClassBodyRange(text: string, searchFrom: number): { start: number; end: number } | null {
  const openIdx = text.indexOf("{", searchFrom);
  if (openIdx === -1) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: openIdx + 1, end: i };
    }
  }
  return null; // unbalanced — malformed/truncated input
}

function extractListeners(text: string, ref: EventPatternRef): EventPatternOccurrence[] {
  const base = escapeRegExp(ref.listenerBaseType);
  const eventCall = escapeRegExp(ref.listenerEventCall);
  // `(?:[A-Za-z_$][\w$]*\.)*` optionally tolerates a fully-qualified package prefix before the
  // base-type token (e.g. `extends com.example.pkg.ListenerMessageDelegate`) — real Java code
  // sometimes references a base type fully-qualified (no import, or to disambiguate a name
  // clash). Without this, the simple-name-only regex missed such listeners entirely.
  const classRe = new RegExp(
    `\\bclass\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s+(?:extends|implements)\\s+(?:[A-Za-z_$][\\w$]*\\.)*${base}\\b`,
    "g",
  );
  const eventCallRe = new RegExp(`\\b${eventCall}\\s*\\([^,]+,\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\.\\s*class\\s*\\)`);

  const results: EventPatternOccurrence[] = [];
  for (let m; (m = classRe.exec(text)) !== null;) {
    const className = m[1];
    if (!className) continue;
    const body = findClassBodyRange(text, classRe.lastIndex);
    if (!body) continue;
    const bodyText = text.slice(body.start, body.end);
    const eventMatch = eventCallRe.exec(bodyText);
    const eventName = eventMatch?.[1];
    if (!eventName) continue; // listener class found but no recognizable event-consume call — skip
    results.push({ role: "listener", className, eventName });
  }
  return results;
}

// ---- Publisher variant A: broker interface (one file) + broker impl (a separate file) ----
// Broker interface shape: `interface <BrokerName> extends <subscriberBaseType><ModelName>>`
// Broker impl shape: `class <ImplName> implements <BrokerName>` — NOT keyed off any "Nats"/
// "Rabbit" substring; detection is purely the (impl class) -> (implemented interface name) pair,
// so a *NatsImpl and a *RabbitImpl implementing the SAME broker interface both match uniformly.

function extractBrokerInterfaces(text: string, ref: EventPatternRef): EventPatternOccurrence[] {
  const subscriberBase = escapeRegExp(ref.subscriberBaseType);
  // Same fully-qualified-base-type tolerance as extractListeners' classRe above (e.g.
  // `extends com.example.pkg.DomainEventSubscriber<Model>`) — the analogous simple-name
  // assumption existed here too, for the subscriber base type.
  const re = new RegExp(
    `\\binterface\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s+extends\\s+(?:[A-Za-z_$][\\w$]*\\.)*${subscriberBase}\\s*<\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*>`,
    "g",
  );
  const results: EventPatternOccurrence[] = [];
  for (let m; (m = re.exec(text)) !== null;) {
    const className = m[1];
    const modelName = m[2];
    if (!className || !modelName) continue;
    results.push({ role: "broker-interface", className, modelName });
  }
  return results;
}

function extractBrokerImpls(text: string): EventPatternOccurrence[] {
  // Generic `class <ImplName> implements <SomeInterfaceName>` — the interface name is
  // resolved against the broker-interface map by the RESOLVER (cross-file join), not here;
  // this function only reports the raw (impl, implementedInterface) pair.
  const re = /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+implements\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  const results: EventPatternOccurrence[] = [];
  for (let m; (m = re.exec(text)) !== null;) {
    const className = m[1];
    const brokerInterfaceName = m[2];
    if (!className || !brokerInterfaceName) continue;
    results.push({ role: "broker-impl", className, brokerInterfaceName });
  }
  return results;
}

// ---- Publisher variant B: single-file publish call with a `.class` argument ----
// Shape: `<publishCall>(<subject>, <eventVar>, <EventName>.class)` — the LAST argument before
// `.class` is the event name. The publisher symbol is the class ENCLOSING the call (found via
// findEnclosingClass), never "the first class in the file" — this is the exact bug the deleted
// spike had and the reason this whole catalog exists.
//
// Finding the call's OWN closing paren cannot be a simple `[^)]*?` regex: real-world publish
// calls often have a nested method call in an EARLIER argument (e.g. a subject string built via
// `"prefix." + event.getUserId()`), and `getUserId()` contains a `)` that a naive
// exclude-any-close-paren regex trips on, causing the whole match to fail. Instead: find the
// call's opening paren via a plain regex, then walk FORWARD counting paren depth to find the
// call's OWN matching closing paren (correctly skipping over any nested calls of any depth),
// then search only within that isolated argument-list substring for the trailing `Name.class`.
const EVENT_CLASS_ARG_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*class\b/g;

/** Find the character range of the argument-list substring (between the parens) for the call
 *  whose opening paren is at `openParenIndex`. Returns null on unbalanced parens.
 *
 *  STRING/CHAR-LITERAL AWARENESS: a naive raw-character paren count is fooled by a `)` (or `(`)
 *  appearing INSIDE a string or char literal argument (e.g. a subject built from a literal
 *  containing a closing paren) — that literal `)` decrements depth early and truncates the
 *  argument-list substring before the real trailing `Name.class` argument, silently dropping the
 *  event. Fix: while walking, track whether the scan is currently inside a double-quoted string
 *  (`"..."`) or single-quoted char (`'...'`) literal; while inside one, parens are skipped
 *  entirely (they don't affect depth), and a backslash-escaped quote (`\"` / `\'`) or any other
 *  backslash escape (`\\`) does not end the literal — only an UNESCAPED matching quote does. */
function findMatchingCloseParen(text: string, openParenIndex: number): number | null {
  let depth = 1;
  let stringQuote: '"' | "'" | null = null; // the quote char of the literal we're inside, or null
  for (let i = openParenIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (stringQuote !== null) {
      if (ch === "\\") {
        i++; // skip the escaped character (e.g. `\"`, `\\`) — it can never end the literal
      } else if (ch === stringQuote) {
        stringQuote = null; // unescaped matching quote — literal ends here
      }
      continue; // parens (and everything else) inside a literal never affect paren depth
    }
    if (ch === '"' || ch === "'") {
      stringQuote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null; // unbalanced — malformed/truncated input
}

function extractVariantBPublishers(text: string, ref: EventPatternRef): EventPatternOccurrence[] {
  const publishCall = escapeRegExp(ref.publishCall);
  const callRe = new RegExp(`\\b${publishCall}\\s*\\(`, "g");
  const results: EventPatternOccurrence[] = [];
  for (let m; (m = callRe.exec(text)) !== null;) {
    const openParenIndex = m.index + m[0].length - 1; // index of the "(" itself
    const closeParenIndex = findMatchingCloseParen(text, openParenIndex);
    if (closeParenIndex === null) continue; // unbalanced — skip this occurrence
    const argsText = text.slice(openParenIndex + 1, closeParenIndex);

    // The event's `.class` argument is the LAST one in the argument list — take the LAST
    // "Name.class" match within the isolated argument-list substring (an earlier argument could
    // coincidentally contain a `.class` reference, e.g. a comment already stripped, or a
    // different `.class`-shaped expression; the last one is authoritative for this shape).
    let eventName: string | undefined;
    EVENT_CLASS_ARG_RE.lastIndex = 0;
    for (let cm; (cm = EVENT_CLASS_ARG_RE.exec(argsText)) !== null;) {
      eventName = cm[1];
    }
    if (!eventName) continue; // publishCall found but no trailing "Name.class" arg — skip

    const className = findEnclosingClass(text, m.index);
    if (!className) continue; // no enclosing class found — malformed/truncated input, skip
    results.push({ role: "publisher", className, eventName });
  }
  return results;
}

/** class-based-domain-events: the ONLY entry today. Strips comments first (so a commented-out
 *  or Javadoc-mentioned "class"/base-type/method never becomes a false occurrence), then runs
 *  all four occurrence extractors and concatenates their results. Fail-open by construction:
 *  every extractor is a pure regex scan that returns [] on no match, never throws. */
const classBasedDomainEvents: EventPatternExtractor = (fileText, ref) => {
  const stripped = stripComments(fileText);
  return [
    ...extractListeners(stripped, ref),
    ...extractBrokerInterfaces(stripped, ref),
    ...extractBrokerImpls(stripped),
    ...extractVariantBPublishers(stripped, ref),
  ];
};

/** In-core registry of event-pattern shapes, keyed by `EventPatternRef.kind`. */
export const EventPatternCatalog: Record<string, EventPatternExtractor> = {
  "class-based-domain-events": classBasedDomainEvents,
};

/** The event-pattern shape kinds the core can extract (the keys of EventPatternCatalog). A
 *  profile whose `eventPattern.kind` is not here cannot be resolved, so config validation
 *  rejects it up front (loud, at load time) instead of letting it degrade to zero extracted
 *  occurrences downstream — mirrors KNOWN_CALL_SITE_KINDS from call-site-catalog.ts. */
export const KNOWN_EVENT_PATTERN_KINDS: ReadonlySet<string> = new Set(Object.keys(EventPatternCatalog));
