import { Injectable, Logger } from '@nestjs/common';

export interface Receipt {
  orderId: string;
  to: string;
  amount: number;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async sendReceipt(receipt: Receipt): Promise<void> {
    const base = process.env.EMAIL_API_URL;
    if (!base) {
      this.logger.log(`(no EMAIL_API_URL) receipt for order ${receipt.orderId} → ${receipt.to}`);
      return;
    }
    const res = await fetch(`${base}/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(receipt),
    });
    if (!res.ok) throw new Error(`email API answered ${res.status}`);
  }
}
