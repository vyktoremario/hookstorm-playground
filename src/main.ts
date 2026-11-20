import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: Stripe signatures are computed over the exact request bytes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '127.0.0.1');
  Logger.log(`ticket shop listening on http://127.0.0.1:${port}`, 'Bootstrap');
  if (process.env.HOOKSTORM === '1') Logger.warn('HOOKSTORM=1: test-only /hookstorm routes are enabled', 'Bootstrap');
}

void bootstrap();
