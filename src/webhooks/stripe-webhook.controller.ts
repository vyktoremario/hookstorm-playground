import { BadRequestException, Controller, Headers, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { OrdersService } from '../orders/orders.service';
import { STRIPE } from '../stripe.provider';

@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly orders: OrdersService,
    @Inject(STRIPE) private readonly stripe: Stripe,
  ) {}

  @Post('stripe')
  @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string) {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(req.rawBody!, signature, process.env.STRIPE_WEBHOOK_SECRET ?? '');
    } catch (err) {
      throw new BadRequestException(`Webhook signature verification failed: ${(err as Error).message}`);
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.orders.markPaid(event.data.object);
        break;
      case 'charge.refunded':
        await this.orders.markRefunded(event.data.object);
        break;
      default:
        this.logger.debug(`ignoring ${event.type}`);
    }
    return { received: true };
  }
}
