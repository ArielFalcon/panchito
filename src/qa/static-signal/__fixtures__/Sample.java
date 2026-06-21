public class PaymentService {
    public void process(String orderId) {
        System.out.println("Processing: " + orderId);
    }

    private String formatAmount(double amount) {
        return String.format("%.2f", amount);
    }
}
