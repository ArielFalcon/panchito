package listener;

// Fixture listener for the stem-join test: consumes BarEvent. service-b's variant-A publisher
// chain publishes the domain model "Bar" (no suffix) — no exact string match, but stripping the
// trailing Event/Model suffix from both sides yields the same stem "Bar" → confidence 0.7.
public class BarModelListenerNats extends ListenerMessageDelegate {
    public void onMessage(Message message) {
        BarEvent barEvent =
            messengerClient.convertMsgToSpecificType(message, BarEvent.class);
    }
}
