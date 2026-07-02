package publisher;

// Fixture publisher with NO counterpart anywhere in the scanned repo pool — proves a publisher
// with no matching listener produces no link, and does not throw.
public class LonelyPublisher {
    public void emit() {
        messengerClient.publishGenericMessage("subject", strandedEvent, StrandedEvent.class);
    }
}
