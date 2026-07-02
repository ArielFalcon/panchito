package publisher;

// Fixture variant-A broker interface for the stem-join test: the generic type argument is "Bar"
// (a domain model with no suffix) — service-a's BarModelListenerNats listens for BarEvent, so
// only a stem match (both sides strip to "Bar") joins them.
public interface BarEventBroker extends DomainEventSubscriber<Bar> {
}
