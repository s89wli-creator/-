import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { idempotencyKeys } from '@rakan/db';
import { and, eq, lt } from 'drizzle-orm';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { DbService } from './db.service';
import type { RakanRequest } from './decorators';
import { AppError, badRequest, conflict } from './errors';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RETENTION_MS = 7 * 86400_000;

/**
 * Idempotency for mutations (used by the field app's offline outbox).
 * A request with an `Idempotency-Key` header is executed at most once per user and company:
 * a retry with the same key and the same request gets the first successful response back;
 * the same key with a different request is rejected. Failed attempts are not stored, so they can be retried.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly db: DbService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RakanRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.headers['idempotency-key'];
    const auth = req.auth;
    if (!UNSAFE.has(req.method) || typeof key !== 'string' || !auth?.tenantId) return next.handle();
    if (!KEY.test(key)) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Invalid Idempotency-Key');
    // Nest applies @HttpCode after interceptors run, so the status is read from the route metadata.
    const declared = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as number | undefined;
    const status = declared ?? (req.method === 'POST' ? 201 : 200);
    const ctx = { tenantId: auth.tenantId, userId: auth.userId };
    const where = and(eq(idempotencyKeys.tenantId, auth.tenantId), eq(idempotencyKeys.userId, auth.userId), eq(idempotencyKeys.key, key));
    const body = Buffer.isBuffer(req.body) ? req.body.toString('base64') : JSON.stringify(req.body ?? null);
    const requestHash = createHash('sha256').update(`${req.method} ${req.originalUrl.split('?')[0]} ${body}`).digest('hex');

    return from(
      (async () => {
        const inserted = await this.db.run(ctx, (tx) =>
          tx
            .insert(idempotencyKeys)
            .values({ tenantId: auth.tenantId!, userId: auth.userId, key, requestHash })
            .onConflictDoNothing()
            .returning({ key: idempotencyKeys.key }),
        );
        if (!inserted.length) {
          const [row] = await this.db.run(ctx, (tx) => tx.select().from(idempotencyKeys).where(where));
          if (!row) throw conflict('IDEMPOTENCY_IN_PROGRESS', 'The same request is being processed');
          if (row.requestHash !== requestHash) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This key was used for a different request');
          if (row.status !== 'done') throw conflict('IDEMPOTENCY_IN_PROGRESS', 'The same request is being processed');
          res.status(row.responseCode ?? 200);
          res.setHeader('idempotent-replay', 'true');
          return row.responseBody ?? undefined;
        }
        try {
          const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
          await this.db.run(ctx, async (tx) => {
            await tx.update(idempotencyKeys).set({ status: 'done', responseCode: status, responseBody: (result ?? null) as unknown }).where(where);
            if (Math.random() < 0.02) await tx.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - RETENTION_MS)));
          });
          return result;
        } catch (e) {
          await this.db.run(ctx, (tx) => tx.delete(idempotencyKeys).where(where)).catch(() => undefined);
          throw e;
        }
      })(),
    );
  }
}
