package publisher;

// Fixture variant-B publisher for the exact-join test: publishes FooCreatedEvent verbatim,
// matching service-a's FooCreatedListenerNats exactly.
public class FooEventEmitter {
    public void emit() {
        messengerClient.publishGenericMessage("subject", fooCreatedEvent, FooCreatedEvent.class);
    }
}
