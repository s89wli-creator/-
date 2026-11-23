import { Injectable } from '@nestjs/common';
import { notifications, type Tx } from '@rakan/db';
import type { NotificationDto, NotificationListDto } from '@rakan/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { notFound } from '../common/errors';
import { PushService } from '../files/push.service';

export interface NewNotification { tenantId: string; userId: string; kind: string; title: string; body?: string; links?: { label: string; href: string }[] }

/** In-app notifications. Each person sees only their own. */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DbService,
    private readonly push: PushService,
  ) {}

  /** In-app notification + push to the person's devices (title and link only). Call outside other transactions. */
  async notify(n: NewNotification): Promise<void> {
    await this.db.run({ tenantId: n.tenantId }, (tx) => this.add(tx, n));
    await this.push.notify(n.tenantId, n.userId, { title: n.title, url: n.links?.[0]?.href ?? '/home', tag: n.kind });
  }

  async add(tx: Tx, n: NewNotification): Promise<void> {
    await tx.insert(notifications).values({ tenantId: n.tenantId, userId: n.userId, kind: n.kind, title: n.title, body: n.body ?? '', links: n.links ?? [] });
  }

  async list(auth: TenantAuthContext): Promise<NotificationListDto> {
    return this.db.tenant(auth, async (tx) => {
      const mine = and(eq(notifications.tenantId, auth.tenantId), eq(notifications.userId, auth.userId));
      const rows = await tx.select().from(notifications).where(mine).orderBy(desc(notifications.createdAt)).limit(50);
      const [u] = await tx.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(mine, isNull(notifications.readAt)));
      return {
        unread: u?.n ?? 0,
        items: rows.map((r): NotificationDto => ({
          id: r.id, kind: r.kind, title: r.title, body: r.body, links: r.links, readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
        })),
      };
    });
  }

  async read(auth: TenantAuthContext, id: string): Promise<void> {
    const r = await this.db.tenant(auth, (tx) =>
      tx.update(notifications).set({ readAt: new Date() })
        .where(and(eq(notifications.tenantId, auth.tenantId), eq(notifications.userId, auth.userId), eq(notifications.id, id)))
        .returning({ id: notifications.id }),
    );
    if (!r.length) throw notFound('Notification');
  }

  async readAll(auth: TenantAuthContext): Promise<void> {
    await this.db.tenant(auth, (tx) =>
      tx.update(notifications).set({ readAt: new Date() })
        .where(and(eq(notifications.tenantId, auth.tenantId), eq(notifications.userId, auth.userId), isNull(notifications.readAt))),
    );
  }
}
