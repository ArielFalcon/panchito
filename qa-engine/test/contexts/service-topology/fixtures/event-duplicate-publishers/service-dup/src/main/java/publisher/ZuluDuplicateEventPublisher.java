package publisher;

// Fixture for the walk()-determinism regression test: publishes the SAME event name
// ("SharedDuplicateEvent") as AlphaDuplicateEventPublisher.java. Filename is lexicographically
// LAST among the two publisher files, so a deterministic (sorted) walk must never pick this one
// as the join's `from` when AlphaDuplicateEventPublisher.java is present in the same directory.
public class ZuluDuplicateEventPublisher {
    public void emit() {
        messengerClient.publishGenericMessage("subject", sharedDuplicateEvent, SharedDuplicateEvent.class);
    }
}
