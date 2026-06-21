export function pay(amount: number, currency: string): void {
  console.log(`Paying ${amount} ${currency}`);
}

export async function validateCard(card: string): Promise<boolean> {
  return card.length > 0;
}

export interface Cart {
  id: string;
  total: number;
}

export class PaymentService {
  process(orderId: string): void {
    console.log(`Processing order ${orderId}`);
  }

  private refund(transactionId: string): Promise<void> {
    return Promise.resolve();
  }
}
