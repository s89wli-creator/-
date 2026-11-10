import type { INestApplication } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { looksLikeAudio } from '../src/field/recordings.service';
import { fake, installDefaultAgents } from './ai-fake';
import { addMember, outbox, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
  fake(app).reset();
  installDefaultAgents(fake(app));
  ({ client: owner } = await registerCompany(app, { email: 'o@field.sa', company: 'شركة الميدان' }));
});

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const account = async (c: TestClient, name = 'عميل ميداني') => (await c.post('/crm/accounts', { name, city: 'الرياض' }).expect(201)).body as { id: string };
const visit = async (c: TestClient, accountId: string, h = 1) => (await c.post('/crm/visits', { accountId, scheduledStart: inHours(h) }).expect(201)).body as { id: string };
// A tiny WebM/EBML header followed by bytes: enough for the container check.
const AUDIO = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(60, 7)]);

describe('idempotency (offline outbox replays)', () => {
  it('applies a retried mutation once and replays the first response', async () => {
    const a = await account(owner);
    const send = (body: object, key: string) => owner.post(`/crm/accounts/${a.id}/notes`, body).set('idempotency-key', key);
    const first = await send({ body: 'ملاحظة كتبت دون اتصال' }, 'note-key-000001').expect(201);
    const again = await send({ body: 'ملاحظة كتبت دون اتصال' }, 'note-key-000001').expect(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    expect((await owner.get(`/crm/accounts/${a.id}/notes`).expect(200)).body).toHaveLength(1);
    // Same key, different request: rejected.
    expect((await send({ body: 'نص آخر' }, 'note-key-000001').expect(422)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Keys are per user: another user's identical key does not collide.
    const { client: rep } = await addMember(app, owner, 'rep@field.sa', 'manager');
    await rep.post(`/crm/accounts/${a.id}/notes`, { body: 'ملاحظة كتبت دون اتصال' }).set('idempotency-key', 'note-key-000001').expect(201);
    expect((await owner.get(`/crm/accounts/${a.id}/notes`).expect(200)).body).toHaveLength(2);
    await owner.post(`/crm/accounts/${a.id}/notes`, { body: 'x' }).set('idempotency-key', 'bad key!').expect(400);
  });

  it('a failed attempt is not stored, so the retry runs again', async () => {
    const a = await account(owner);
    const v = await visit(owner, a.id);
    await owner.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested' }).set('idempotency-key', 'complete-0001').expect(400);
    const ok = await owner.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'none' }).set('idempotency-key', 'complete-0002').expect(200);
    const replay = await owner.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'none' }).set('idempotency-key', 'complete-0002').expect(200);
    expect(replay.body).toEqual(ok.body);
  });
});

describe('offline timestamps', () => {
  it('keeps the real time of an offline check-in, within 72 hours', async () => {
    const a = await account(owner);
    const v = await visit(owner, a.id);
    const at = new Date(Date.now() - 2 * 3600_000).toISOString();
    expect((await owner.post(`/crm/visits/${v.id}/check-in`, { occurredAt: new Date(Date.now() - 4 * 86400_000).toISOString() }).expect(400)).body.error.code).toBe('INVALID_OCCURRED_AT');
    expect((await owner.post(`/crm/visits/${v.id}/check-in`, { occurredAt: inHours(1) }).expect(400)).body.error.code).toBe('INVALID_OCCURRED_AT');
    const r = (await owner.post(`/crm/visits/${v.id}/check-in`, { occurredAt: at }).expect(200)).body;
    expect(r.checkInAt).toBe(at);
    const done = (await owner.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'none', occurredAt: new Date(Date.now() - 3600_000).toISOString() }).expect(200)).body;
    expect(new Date(done.checkOutAt).getTime()).toBeLessThan(Date.now() - 3500_000);
    const [audit] = await ownerQuery<{ after: { recordedOffline: boolean } }>("SELECT after FROM audit_logs WHERE action='visit.check_in'");
    expect(audit!.after.recordedOffline).toBe(true);
  });
});

describe('field pack', () => {
  it('gives a rep their own upcoming visits with accounts, contacts and tasks', async () => {
    const { client: rep, membershipId } = await addMember(app, owner, 'rep@field.sa', 'rep');
    const a = (await owner.post('/crm/accounts', { name: 'عميل المندوب', ownerMembershipId: membershipId }).expect(201)).body;
    await owner.post(`/crm/accounts/${a.id}/contacts`, { fullName: 'مدير المشتريات', phone: '0551234567' }).expect(201);
    await owner.post('/crm/visits', { accountId: a.id, scheduledStart: inHours(2), repMembershipId: membershipId }).expect(201);
    const other = await account(owner, 'عميل المالك');
    await owner.post('/crm/visits', { accountId: other.id, scheduledStart: inHours(5) }).expect(201); // owner's own visit
    await owner.post('/crm/visits', { accountId: a.id, scheduledStart: inHours(24 * 10), repMembershipId: membershipId }).expect(201); // too far
    const pack = (await rep.get('/field/today').expect(200)).body;
    expect(pack.visits).toHaveLength(1);
    expect(pack.accounts[other.id]).toBeUndefined();
    expect(pack.accounts[a.id].contacts[0].phone).toBe('+966551234567');
    expect(Array.isArray(pack.tasks)).toBe(true);
  });
});

describe('visit recordings', () => {
  async function setup() {
    const a = await account(owner);
    const v = await visit(owner, a.id);
    return { a, v };
  }

  it('requires the company setting and customer consent', async () => {
    const { v } = await setup();
    await owner.post(`/crm/visits/${v.id}/recordings`, { mimeType: 'audio/webm', totalChunks: 1, consent: true }).expect(403);
    await owner.patch('/tenant', { settings: { recordingEnabled: true } }).expect(200);
    await owner.post(`/crm/visits/${v.id}/recordings`, { mimeType: 'audio/webm', totalChunks: 1, consent: false }).expect(400);
    await owner.post(`/crm/visits/${v.id}/recordings`, { mimeType: 'video/mp4', totalChunks: 1, consent: true }).expect(400);
    await owner.post(`/crm/visits/${v.id}/recordings`, { mimeType: 'audio/webm;codecs=opus', totalChunks: 1, consent: true }).expect(201);
  });

  it('uploads in chunks, stores encrypted, plays back, transcribes manually, deletes', async () => {
    await owner.patch('/tenant', { settings: { recordingEnabled: true, recordingRetentionDays: 30 } }).expect(200);
    const { a, v } = await setup();
    const r = (await owner.post(`/crm/visits/${v.id}/recordings`, { mimeType: 'audio/webm', totalChunks: 2, durationSec: 40, consent: true }).expect(201)).body;
    expect(new Date(r.deleteAfter).getTime() - Date.now()).toBeGreaterThan(29 * 86400_000);
    await owner.putRaw(`/crm/recordings/${r.id}/chunks/0`, Buffer.from('not audio at all, just text')).expect(400);
    await owner.putRaw(`/crm/recordings/${r.id}/chunks/0`, AUDIO).expect(200);
    await owner.putRaw(`/crm/recordings/${r.id}/chunks/0`, AUDIO).expect(200); // retry is harmless
    expect((await owner.post(`/crm/recordings/${r.id}/complete`).expect(409)).body.error.code).toBe('CHUNKS_MISSING');
    const tail = Buffer.from('SECRET-AUDIO-TAIL-BYTES');
    expect((await owner.putRaw(`/crm/recordings/${r.id}/chunks/1`, tail).expect(200)).body.received).toEqual([0, 1]);
    await owner.putRaw(`/crm/recordings/${r.id}/chunks/2`, tail).expect(400);
    const done = (await owner.post(`/crm/recordings/${r.id}/complete`).expect(200)).body;
    expect(done).toMatchObject({ status: 'ready', sizeBytes: AUDIO.length + tail.length });

    // Encrypted at rest: no plaintext bytes on disk.
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
    walk('/tmp/rakan-test-storage');
    const mine = files.filter((f) => f.includes(r.id));
    expect(mine).toHaveLength(1);
    expect(readFileSync(mine[0]!).includes(tail)).toBe(false);

    const audio = await owner.get(`/crm/recordings/${r.id}/audio`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(audio.headers['content-type']).toContain('audio/webm');
    expect(Buffer.compare(audio.body as Buffer, Buffer.concat([AUDIO, tail]))).toBe(0);

    // Manual transcript feeds meeting analysis.
    await owner.patch(`/crm/recordings/${r.id}/transcript`, { transcript: 'العميل قال نحتاج ثلاث شاحنات مبردة أسبوعياً' }).expect(200);
    await owner.post(`/crm/visits/${v.id}/check-in`, {}).expect(200);
    await owner.post(`/crm/visits/${v.id}/complete`, { outcome: 'interested', nextStep: 'none', notes: 'زيارة جيدة' }).expect(200);
    await owner.post(`/ai/visits/${v.id}/insights`).expect(201);
    expect(fake(app).calls.at(-1)!.prompt).toContain('ثلاث شاحنات مبردة');

    // Reps without access to the visit cannot reach it.
    const { client: rep } = await addMember(app, owner, 'rep2@field.sa', 'rep');
    await rep.get(`/crm/recordings/${r.id}/audio`).expect(404);
    void a;

    await owner.delete(`/crm/recordings/${r.id}`).expect(204);
    expect((await owner.get(`/crm/visits/${v.id}/recordings`).expect(200)).body).toEqual([]);
    walk('/tmp/rakan-test-storage');
    expect(readdirSync('/tmp/rakan-test-storage', { recursive: true }).filter((f) => String(f).includes(r.id) && String(f).endsWith('.audio'))).toHaveLength(0);
  });

  it('deletes recordings after the retention period', async () => {
    await owner.patch('/tenant', { settings: { recordingEnabled: true } }).expect(200);
    const { v } = await setup();
    const r = (await owner.post(`/crm/visits/${v.id}/recordings`, { mimeType: 'audio/webm', totalChunks: 1, consent: true }).expect(201)).body;
    await owner.putRaw(`/crm/recordings/${r.id}/chunks/0`, AUDIO).expect(200);
    await owner.post(`/crm/recordings/${r.id}/complete`).expect(200);
    await ownerQuery("UPDATE visit_recordings SET delete_after = now() - interval '1 minute' WHERE id = $1", [r.id]);
    expect((await owner.get(`/crm/visits/${v.id}/recordings`).expect(200)).body).toEqual([]);
    await owner.get(`/crm/recordings/${r.id}/audio`).expect(404);
  });

  it('recognizes audio containers', () => {
    expect(looksLikeAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]))).toBe(true);
    expect(looksLikeAudio(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)]))).toBe(true);
    expect(looksLikeAudio(Buffer.from('<html><script>alert(1)</script>'))).toBe(false);
  });
});
