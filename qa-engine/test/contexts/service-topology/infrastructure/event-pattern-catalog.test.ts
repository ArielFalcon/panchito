// test/contexts/service-topology/infrastructure/event-pattern-catalog.test.ts
// TDD (strict): write failing tests first, then implement.
// The event-pattern SHAPE catalog: each entry knows how to find listener/publisher class-based
// domain-event occurrences in a Java-ish source file. Config supplies the concrete base-type
// and method names (via EventPatternRef); the shape itself (extends/implements a base type,
// call a named method with a `.class` argument) lives here, in the core, exactly once — this is
// the ONLY place a class-based-domain-events shape is defined. Every fixture in this file uses
// generic names ("Foo", "Bar") to prove the extractor reads shape names from the ref argument,
// never a literal.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EventPatternCatalog,
  KNOWN_EVENT_PATTERN_KINDS,
  type EventPatternExtractor,
} from "@contexts/service-topology/infrastructure/event-pattern-catalog.ts";
import type { EventPatternRef } from "@contexts/service-topology/domain/index.ts";

/** Look up a catalog entry, asserting it is registered (noUncheckedIndexedAccess narrowing). */
function getExtractor(kind: string): EventPatternExtractor {
  const extractor = EventPatternCatalog[kind];
  assert.ok(extractor, `expected '${kind}' to be registered in the catalog`);
  return extractor;
}

const REF: EventPatternRef = {
  kind: "class-based-domain-events",
  listenerBaseType: "ListenerMessageDelegate",
  listenerEventCall: "convertMsgToSpecificType",
  subscriberBaseType: "DomainEventSubscriber",
  publishCall: "publishGenericMessage",
};

test("KNOWN_EVENT_PATTERN_KINDS registers class-based-domain-events", () => {
  assert.ok(KNOWN_EVENT_PATTERN_KINDS.has("class-based-domain-events"));
});

// ---- Listener extraction: extends / implements ----

test("class-based-domain-events: extracts a listener declared via `extends ListenerMessageDelegate`", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class FooCreatedListenerNats extends ListenerMessageDelegate {
      public void onMessage(Message message) {
        FooCreatedEvent fooCreatedEvent =
            messengerClient.convertMsgToSpecificType(message, FooCreatedEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const listeners = occurrences.filter((o) => o.role === "listener");
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0]?.className, "FooCreatedListenerNats");
  assert.equal(listeners[0]?.eventName, "FooCreatedEvent");
});

test("class-based-domain-events: extracts a listener declared via `implements ListenerMessageDelegate` (tolerate both)", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class FooCreatedListenerRabbit implements ListenerMessageDelegate {
      public void onMessage(Message message) {
        FooCreatedEvent fooCreatedEvent =
            messengerClient.convertMsgToSpecificType(message, FooCreatedEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const listeners = occurrences.filter((o) => o.role === "listener");
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0]?.className, "FooCreatedListenerRabbit");
  assert.equal(listeners[0]?.eventName, "FooCreatedEvent");
});

// ---- REGRESSION: fully-qualified base type (package-qualified `extends`/`implements`) ----
// The class-header regex required the base type as a SIMPLE name immediately after
// extends/implements. Real Java code sometimes references the base type fully-qualified (no
// import, or to disambiguate a name clash) — `extends com.example.pkg.ListenerMessageDelegate`
// — which the simple-name-only regex missed entirely, silently dropping the listener.

test("REGRESSION: a listener declared via a FULLY-QUALIFIED base type (`extends com.example.pkg.ListenerMessageDelegate`) is still detected", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class X extends com.example.pkg.ListenerMessageDelegate {
      public void onMessage(Message message) {
        QuxEvent quxEvent =
            messengerClient.convertMsgToSpecificType(message, QuxEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const listeners = occurrences.filter((o) => o.role === "listener");
  assert.equal(listeners.length, 1, "a fully-qualified base type must not prevent listener detection");
  assert.equal(listeners[0]?.className, "X");
  assert.equal(listeners[0]?.eventName, "QuxEvent");
});

// ---- Publisher variant A: two-file (broker interface + impl) ----

test("class-based-domain-events: extracts a variant-A publisher (broker interface + impl, two files)", () => {
  const extractor = getExtractor("class-based-domain-events");
  const brokerText = `
    public interface BarEventBroker extends DomainEventSubscriber<BarModel> {}
  `;
  const implText = `
    public class BarEventPublisherNatsImpl implements BarEventBroker {
      public void publish(BarModel model) { /* ... */ }
    }
  `;
  const brokerOccurrences = extractor(brokerText, REF);
  const brokers = brokerOccurrences.filter((o) => o.role === "broker-interface");
  assert.equal(brokers.length, 1);
  assert.equal(brokers[0]?.className, "BarEventBroker");
  assert.equal(brokers[0]?.modelName, "BarModel");

  const implOccurrences = extractor(implText, REF);
  const impls = implOccurrences.filter((o) => o.role === "broker-impl");
  assert.equal(impls.length, 1);
  assert.equal(impls[0]?.className, "BarEventPublisherNatsImpl");
  assert.equal(impls[0]?.brokerInterfaceName, "BarEventBroker");
});

test("class-based-domain-events: variant-A detection is NOT keyed off a 'Nats'/'Rabbit' substring — a RabbitImpl matches the same broker", () => {
  const extractor = getExtractor("class-based-domain-events");
  const rabbitImplText = `
    public class BarEventPublisherRabbitImpl implements BarEventBroker {
      public void publish(BarModel model) { /* ... */ }
    }
  `;
  const occurrences = extractor(rabbitImplText, REF);
  const impls = occurrences.filter((o) => o.role === "broker-impl");
  assert.equal(impls.length, 1);
  assert.equal(impls[0]?.className, "BarEventPublisherRabbitImpl");
  assert.equal(impls[0]?.brokerInterfaceName, "BarEventBroker");
});

test("REGRESSION: a broker interface declared via a FULLY-QUALIFIED subscriber base type (`extends com.example.pkg.DomainEventSubscriber<Model>`) is still detected", () => {
  const extractor = getExtractor("class-based-domain-events");
  const brokerText = `
    public interface QuxEventBroker extends com.example.pkg.DomainEventSubscriber<QuxModel> {}
  `;
  const occurrences = extractor(brokerText, REF);
  const brokers = occurrences.filter((o) => o.role === "broker-interface");
  assert.equal(brokers.length, 1, "a fully-qualified subscriber base type must not prevent broker-interface detection");
  assert.equal(brokers[0]?.className, "QuxEventBroker");
  assert.equal(brokers[0]?.modelName, "QuxModel");
});

// ---- Publisher variant B: single-file publish call ----

test("class-based-domain-events: extracts a variant-B publisher (single-file publishCall with .class arg)", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class BazEventEmitter {
      public void emit() {
        messengerClient.publishGenericMessage("subject", bazEvent, BazEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const publishers = occurrences.filter((o) => o.role === "publisher");
  assert.equal(publishers.length, 1);
  assert.equal(publishers[0]?.className, "BazEventEmitter");
  assert.equal(publishers[0]?.eventName, "BazEvent");
});

// ---- REGRESSION (found against the real nname repos, acceptance run): variant-B publisher
// with a nested method call in the subject-string argument, e.g.
// `publishGenericMessage("topic." + event.getId(), event, FooEvent.class)`. A prior version of
// extractVariantBPublishers used `[^)]*?` to skip the subject argument, which cannot cross ANY
// `)` character — including a nested, BALANCED one from a method call like `.getId()` inside the
// subject expression — so the whole call silently failed to match. This is nname's real,
// idiomatic shape (subject built by string-concatenating a dynamic id via a getter call).

test("REGRESSION: variant-B publisher matches when the subject argument contains a nested method call with its own parens", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class QuuxEventPublisherNatsImpl {
      public void publish(QuuxEvent quuxEvent) {
        messengerClient.publishGenericMessage(
            "topic.quux." + quuxEvent.getId(), quuxEvent, QuuxEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const publishers = occurrences.filter((o) => o.role === "publisher");
  assert.equal(
    publishers.length,
    1,
    "a subject argument with a nested `.getId()` call must not prevent the publish call from matching",
  );
  assert.equal(publishers[0]?.className, "QuuxEventPublisherNatsImpl");
  assert.equal(publishers[0]?.eventName, "QuuxEvent");
});

test("REGRESSION: a nested-parens publish call does not bleed into a SECOND, later publish call in the same file", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class TwoPublishersInOneFile {
      public void publishA(FirstEvent firstEvent) {
        messengerClient.publishGenericMessage("a." + firstEvent.getId(), firstEvent, FirstEvent.class);
      }
      public void publishB(SecondEvent secondEvent) {
        messengerClient.publishGenericMessage("b", secondEvent, SecondEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const publishers = occurrences.filter((o) => o.role === "publisher");
  assert.equal(publishers.length, 2, "both publish calls in the file must be extracted independently");
  const eventNames = publishers.map((p) => (p.role === "publisher" ? p.eventName : null)).sort();
  assert.deepEqual(eventNames, ["FirstEvent", "SecondEvent"]);
});

// ---- REGRESSION: string-literal-aware paren walk (findMatchingCloseParen) ----
// findMatchingCloseParen counts raw `(`/`)` characters with no string/char-literal awareness. A
// `)` inside a STRING LITERAL argument (e.g. a subject built from a literal containing a closing
// paren) closes the walk's depth count early, truncating the argument-list substring before the
// real `Name.class` argument — silently dropping the event. The fix must skip over the contents
// of double-quoted string literals and single-quoted char literals while walking, honoring
// backslash escapes, so parens INSIDE literals never affect paren depth.

test("REGRESSION: a `)` inside a string-literal argument does not truncate the paren walk (event must still be extracted)", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class ParenInStringPublisher {
      public void publish(FooEvent fooEvent) {
        messengerClient.publishGenericMessage("a)b", fooEvent, FooEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const publishers = occurrences.filter((o) => o.role === "publisher");
  assert.equal(
    publishers.length,
    1,
    "a `)` inside a string-literal subject argument must not truncate the call's own argument list",
  );
  assert.equal(publishers[0]?.className, "ParenInStringPublisher");
  assert.equal(publishers[0]?.eventName, "FooEvent");
});

test("REGRESSION: an escaped quote followed by a `)` inside a string literal is still honored as literal content", () => {
  const extractor = getExtractor("class-based-domain-events");
  // The subject literal is: a\") b  — i.e. `\"` is an ESCAPED quote (does not close the string),
  // so the following `)` is still INSIDE the literal and must not affect paren depth.
  const text = `
    public class EscapedQuoteThenParenPublisher {
      public void publish(BarEvent barEvent) {
        messengerClient.publishGenericMessage("a\\") b", barEvent, BarEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const publishers = occurrences.filter((o) => o.role === "publisher");
  assert.equal(
    publishers.length,
    1,
    "an escaped quote before a `)` inside a string literal must not prematurely end the literal or the paren walk",
  );
  assert.equal(publishers[0]?.className, "EscapedQuoteThenParenPublisher");
  assert.equal(publishers[0]?.eventName, "BarEvent");
});

test("REGRESSION: existing nested-call case (unescaped, no literal parens) keeps passing alongside string-literal awareness", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class NestedCallStillWorksPublisher {
      public void publish(BazEvent bazEvent) {
        messengerClient.publishGenericMessage("topic." + bazEvent.getId(), bazEvent, BazEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const publishers = occurrences.filter((o) => o.role === "publisher");
  assert.equal(publishers.length, 1, "the pre-existing nested-method-call regression must keep passing");
  assert.equal(publishers[0]?.className, "NestedCallStillWorksPublisher");
  assert.equal(publishers[0]?.eventName, "BazEvent");
});

// ---- REGRESSION: enclosing class, not first class in file (the deleted spike's exact bug) ----

test("REGRESSION: variant-B publisher symbol is the class ENCLOSING the publish call, not the first class in the file", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    public class UnrelatedFirstClass {
      public void doNothing() { /* no publish call here */ }
    }

    public class SecondClassWithThePublishCall {
      public void emit() {
        messengerClient.publishGenericMessage("subject", quxEvent, QuxEvent.class);
      }
    }
  `;
  const occurrences = extractor(text, REF);
  const publishers = occurrences.filter((o) => o.role === "publisher");
  assert.equal(publishers.length, 1);
  assert.equal(
    publishers[0]?.className,
    "SecondClassWithThePublishCall",
    "publisher symbol must be the enclosing class of the publish call, never the first class declared in the file",
  );
  assert.equal(publishers[0]?.eventName, "QuxEvent");
});

// ---- Comment-stripping: a commented-out class must not be extracted ----

test("comment-stripping: a `// class Foo extends ListenerMessageDelegate` line comment is NOT extracted as a real listener", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    // public class FooCreatedListenerNats extends ListenerMessageDelegate {
    //   public void onMessage(Message message) {
    //     FooCreatedEvent fooCreatedEvent =
    //         messengerClient.convertMsgToSpecificType(message, FooCreatedEvent.class);
    //   }
    // }
    public class RealClassWithNoListener {
      public void doNothing() {}
    }
  `;
  const occurrences = extractor(text, REF);
  const listeners = occurrences.filter((o) => o.role === "listener");
  assert.deepEqual(listeners, [], "a commented-out listener declaration must not be extracted");
});

test("comment-stripping: a `/* ... class Bar ... */` block comment mentioning 'class' is NOT extracted as a real listener", () => {
  const extractor = getExtractor("class-based-domain-events");
  const text = `
    /**
     * This Javadoc mentions class Bar and ListenerMessageDelegate purely in prose,
     * describing a class that extends ListenerMessageDelegate for illustration.
     */
    public class RealClassStillNoListener {
      public void doNothing() {}
    }
  `;
  const occurrences = extractor(text, REF);
  const listeners = occurrences.filter((o) => o.role === "listener");
  assert.deepEqual(listeners, [], "a Javadoc/block-comment mention of 'class' must not be extracted");
});

// ---- Fail-open: unknown kind ----

test("EventPatternCatalog: an unknown kind is not registered (lookup returns undefined)", () => {
  assert.equal(EventPatternCatalog["mystery-shape"], undefined);
});
