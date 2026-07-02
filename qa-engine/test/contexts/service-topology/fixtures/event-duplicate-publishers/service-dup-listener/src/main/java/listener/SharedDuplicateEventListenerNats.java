package listener;

// Fixture listener for the walk()-determinism regression test: consumes SharedDuplicateEvent,
// which BOTH AlphaDuplicateEventPublisher.java and ZuluDuplicateEventPublisher.java publish
// verbatim (a plausible real-world dual-transport relay/dual-publish of one event). The join's
// first-match-wins semantics means the resulting link's `from` is only deterministic if the
// publisher pool itself was collected in a stable (sorted) order.
public class SharedDuplicateEventListenerNats extends ListenerMessageDelegate {
    public void onMessage(Message message) {
        SharedDuplicateEvent sharedDuplicateEvent =
            messengerClient.convertMsgToSpecificType(message, SharedDuplicateEvent.class);
    }
}
