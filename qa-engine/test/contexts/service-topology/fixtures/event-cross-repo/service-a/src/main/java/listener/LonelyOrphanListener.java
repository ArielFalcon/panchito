package listener;

// Fixture listener with NO counterpart anywhere in the scanned repo pool — proves a listener
// with no matching publisher produces no link, and does not throw.
public class LonelyOrphanListener extends ListenerMessageDelegate {
    public void onMessage(Message message) {
        OrphanEvent orphanEvent =
            messengerClient.convertMsgToSpecificType(message, OrphanEvent.class);
    }
}
