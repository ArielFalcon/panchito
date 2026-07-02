package publisher;

// Fixture variant-A publisher impl: implements BarEventBroker, so the resolved event/model name
// ("Bar", from the broker interface's generic argument) joins to BarModelListenerNats via
// stem matching.
public class BarEventPublisherNatsImpl implements BarEventBroker {
    public void publish(Bar model) { /* ... */ }
}
