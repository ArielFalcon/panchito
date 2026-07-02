// Fixture listener for the AGNOSTICISM proof (Invariant #1): uses a COMPLETELY different shape
// convention (AbstractConsumer / deserialize) than nname's real convention
// (ListenerMessageDelegate / convertMsgToSpecificType) — proves the SAME EventResolver/catalog
// code resolves a link with zero code change, only the profile differs.
public class WidgetUpdatedConsumer extends AbstractConsumer {
    public void onMessage(Message message) {
        WidgetUpdatedEvent widgetUpdatedEvent =
            messengerClient.deserialize(message, WidgetUpdatedEvent.class);
    }
}
