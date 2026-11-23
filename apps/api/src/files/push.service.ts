import { Inject, Injectable, Logger } from '@nestjs/common';
import { pushSubscriptions } from '@rakan/db';
import type { PushConfigDto } from '@rakan/shared';
import { and, eq, sql } from 'drizzle-orm';
import webpush from 'web-push';
import type { TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { APP_CONFIG, type AppConfig } from '../config';

export interface PushMessage { title: string; url: string; tag?: string }
export interface PushSender {
  readonly ready: boolean;
  send(sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<{ gone: boolean }>;
}
export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** Standard Web Push (VAPID). Free: delivery goes through the browser vendor's push service. */
export class VapidSender implements PushSender {
  readonly ready: boolean;
  constructor(publicKey: string | undefined, privateKey: string | undefined, subject: string) {
    this.ready = !!(publicKey && privateKey);
    if (this.ready) webpush.setVapidDetails(subject, publicKey!, privateKey!);
  }
  async send(sub: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<{ gone: boolean }> {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 12 * 3600, urgency: 'normal' });
      return { gone: false };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return { gone: true };
      throw e;
    }
  }
}

/** For tests only (refused in production by config validation). */
export class FakePushSender implements PushSender {
  readonly ready = true;
  readonly sent: { endpoint: string; payload: unknown }[] = [];
  gone = new Set<string>();
  async send(sub: { endpoint: string }, payload: string): Promise<{ gone: boolean }> {
    if (this.gone.has(sub.endpoint)) return { gone: true };
    this.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { gone: false };
  }
}

/**
 * Push notifications to the person's phones/browsers. Only a short title and an app link are sent
 * (no customer details): the full text stays in the app behind sign-in.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger('Push');

  constructor(
    private readonly db: DbService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async getConfig(auth: TenantAuthContext): Promise<PushConfigDto> {
    const [r] = await this.db.tenant(auth, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(pushSubscriptions).where(and(eq(pushSubscriptions.tenantId, auth.tenantId), eq(pushSubscriptions.userId, auth.userId))),
    );
    return { enabled: this.sender.ready, publicKey: this.sender.ready ? (this.config.VAPID_PUBLIC_KEY ?? 'test') : null, devices: r?.n ?? 0 };
  }

  async subscribe(auth: TenantAuthContext, input: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string | null): Promise<PushConfigDto> {
    await this.db.tenant(auth, (tx) =>
      tx
        .insert(pushSubscriptions)
        .values({ tenantId: auth.tenantId, userId: auth.userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent })
        // The same browser signing in as someone else takes the subscription over.
        .onConflictDoUpdate({ target: [pushSubscriptions.tenantId, pushSubscriptions.endpoint], set: { userId: auth.userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent } }),
    );
    return this.getConfig(auth);
  }

  async unsubscribe(auth: TenantAuthContext, endpoint: string): Promise<void> {
    await this.db.tenant(auth, (tx) =>
      tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.tenantId, auth.tenantId), eq(pushSubscriptions.userId, auth.userId), eq(pushSubscriptions.endpoint, endpoint))),
    );
  }

  /** Best effort: a failed push never fails the action that triggered it. */
  async notify(tenantId: string, userId: string, msg: PushMessage): Promise<number> {
    if (!this.sender.ready) return 0;
    const subs = await this.db.run({ tenantId }, (tx) =>
      tx.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.tenantId, tenantId), eq(pushSubscriptions.userId, userId))),
    );
    let sent = 0;
    const payload = JSON.stringify({ title: msg.title.slice(0, 120), url: msg.url, tag: msg.tag ?? null });
    for (const s of subs) {
      try {
        const r = await this.sender.send(s, payload);
        await this.db.run({ tenantId }, (tx) =>
          r.gone
            ? tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.tenantId, tenantId), eq(pushSubscriptions.id, s.id)))
            : tx.update(pushSubscriptions).set({ lastOkAt: new Date() }).where(and(eq(pushSubscriptions.tenantId, tenantId), eq(pushSubscriptions.id, s.id))),
        );
        if (!r.gone) sent++;
      } catch (e) {
        this.log.warn({ err: e }, 'push failed');
      }
    }
    return sent;
  }
}
