import { Module } from '@nestjs/common';
import { DatabaseService } from './db/database.service';
import { EmailService } from './email/email.service';
import { HookstormController } from './hookstorm/hookstorm.controller';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { stripeProvider } from './stripe.provider';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';

const testOnly = process.env.HOOKSTORM === '1' ? [HookstormController] : [];

@Module({
  controllers: [OrdersController, StripeWebhookController, ...testOnly],
  providers: [DatabaseService, EmailService, OrdersService, stripeProvider],
})
export class AppModule {}
