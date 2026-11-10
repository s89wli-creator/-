import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { loadConfig, type AppConfig } from '../src/config';
import { MailService } from '../src/identity/mail.service';

export const PASSWORD = 'correct-horse-battery';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    MAIL_TRANSPORT: 'memory',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    RATE_LIMIT_PER_MINUTE: '100000',
    AUTH_RATE_LIMIT_PER_MINUTE: '100000',
    WEB_ORIGIN: 'http://localhost:3000',
    AI_PROVIDER: 'fake',
    STORAGE_DIR: process.env.TEST_STORAGE_DIR ?? '/tmp/rakan-test-storage',
    ...overrides,
  });
}

export async function startApp(overrides: Record<string, string> = {}): Promise<INestApplication> {
  const app = await createApp(testConfig(overrides));
  await app.init();
  return app;
}

/** Wipes all data using the owner role (TRUNCATE is not subject to RLS). */
export async function resetDb(): Promise<void> {
  const c = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await c.connect();
  await c.query('TRUNCATE users, tenants, sessions, password_reset_tokens, audit_logs RESTART IDENTITY CASCADE');
  await c.end();
}

export async function ownerQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export function outbox(app: INestApplication) {
  return app.get(MailService).outbox;
}

/** Browser-like client: persistent cookies + CSRF header on unsafe methods. */
export class TestClient {
  readonly agent: ReturnType<typeof request.agent>;
  private csrf = '';

  constructor(app: INestApplication) {
    this.agent = request.agent(app.getHttpServer());
  }

  async init(): Promise<this> {
    const res = await this.agent.get('/api/auth/csrf').expect(200);
    this.csrf = res.body.csrfToken;
    return this;
  }

  get(url: string) {
    return this.agent.get(`/api${url}`);
  }
  post(url: string, body?: object) {
    return this.agent.post(`/api${url}`).set('x-csrf-token', this.csrf).send(body ?? {});
  }
  patch(url: string, body?: object) {
    return this.agent.patch(`/api${url}`).set('x-csrf-token', this.csrf).send(body ?? {});
  }
  put(url: string, body?: object) {
    return this.agent.put(`/api${url}`).set('x-csrf-token', this.csrf).send(body ?? {});
  }
  putRaw(url: string, data: Buffer) {
    return this.agent.put(`/api${url}`).set('x-csrf-token', this.csrf).set('content-type', 'application/octet-stream').send(data);
  }
  delete(url: string) {
    return this.agent.delete(`/api${url}`).set('x-csrf-token', this.csrf);
  }
  upload(url: string, content: Buffer, filename: string) {
    return this.agent.post(`/api${url}`).set('x-csrf-token', this.csrf).attach('file', content, filename);
  }
}

export async function client(app: INestApplication): Promise<TestClient> {
  return new TestClient(app).init();
}

export async function registerCompany(app: INestApplication, opts: { email: string; company: string; name?: string }) {
  const c = await client(app);
  await c
    .post('/auth/register', { fullName: opts.name ?? 'Owner ' + opts.company, email: opts.email, password: PASSWORD, companyName: opts.company })
    .expect(201);
  const me = (await c.get('/auth/me').expect(200)).body;
  return { client: c, me, tenantId: me.activeTenant.id as string };
}

/** Invites `email` with `role` from `inviter`, then accepts as a new account. Returns the new user's client. */
export async function addMember(
  app: INestApplication,
  inviter: TestClient,
  email: string,
  role: 'owner' | 'manager' | 'rep' | 'readonly',
) {
  await inviter.post('/team/invitations', { email, role }).expect(201);
  const mail = outbox(app).filter((m) => m.to === email).pop()!;
  const token = decodeURIComponent(mail.text.match(/\/invite\/([^\s]+)/)![1]!);
  const c = await client(app);
  await c.post('/invitations/accept', { token, fullName: 'Member ' + email, password: PASSWORD }).expect(200);
  const members = (await inviter.get('/team/members').expect(200)).body as { id: string; email: string }[];
  return { client: c, membershipId: members.find((m) => m.email === email)!.id, token };
}
