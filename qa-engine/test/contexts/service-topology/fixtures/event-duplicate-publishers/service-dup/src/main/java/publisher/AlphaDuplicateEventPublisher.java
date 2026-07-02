package publisher;

// Fixture for the walk()-determinism regression test: publishes the SAME event name
// ("SharedDuplicateEvent") as ZuluDuplicateEventPublisher.java. Filename is lexicographically
// FIRST among the two publisher files — a deterministic (sorted) walk must always pick THIS one
// as the join's `from`, stable across runs regardless of underlying filesystem readdir order.
public class AlphaDuplicateEventPublisher {
    public void emit() {
        messengerClient.publishGenericMessage("subject", sharedDuplicateEvent, SharedDuplicateEvent.class);
    }
}
