package listener;

// Fixture listener for the exact-join test: consumes FooCreatedEvent, which service-b's
// variant-B publisher (FooEventEmitter) also publishes verbatim — exact string match →
// confidence 1.0.
public class FooCreatedListenerNats extends ListenerMessageDelegate {
    public void onMessage(Message message) {
        FooCreatedEvent fooCreatedEvent =
            messengerClient.convertMsgToSpecificType(message, FooCreatedEvent.class);
    }
}
