// Fixture publisher for the AGNOSTICISM proof (Invariant #1): uses the alt profile's `emit`
// publishCall — publishes WidgetUpdatedEvent verbatim, matching WidgetUpdatedConsumer exactly.
public class WidgetEventEmitter {
    public void run() {
        messengerClient.emit("subject", widgetUpdatedEvent, WidgetUpdatedEvent.class);
    }
}
