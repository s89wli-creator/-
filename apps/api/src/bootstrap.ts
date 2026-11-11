import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { AppConfig } from './config';

/** Shared by main.ts and the integration tests so tests exercise the real HTTP stack. */
export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '100kb' });
  // Spokesperson voice sample (platform console only), up to 12 MB. Registered first so it wins for this path.
  app.useBodyParser('raw', {
    limit: '12mb',
    type: (req: { url?: string; headers: Record<string, unknown> }) =>
      req.headers['content-type'] === 'application/octet-stream' && (req.url ?? '').split('?')[0] === '/api/platform/voice',
  });
  // Recording chunks (PUT /api/crm/recordings/:id/chunks/:n), 1 MB each.
  app.useBodyParser('raw', { limit: '1100kb', type: 'application/octet-stream' });
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
