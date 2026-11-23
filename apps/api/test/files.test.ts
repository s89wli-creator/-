import type { INestApplication } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanName, sniff } from '../src/files/attachments.service';
import { FakePushSender, PUSH_SENDER } from '../src/files/push.service';
import { fake, installDefaultAgents } from './ai-fake';
import { addMember, outbox, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;
let tenantId: string;
let accountId: string;
const STORAGE = process.env.TEST_STORAGE_DIR ?? '/tmp/rakan-test-storage';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 32), Buffer.from('\n%%EOF')]);
const push = () => app.get(PUSH_SENDER) as FakePushSender;

const upload = (c: TestClient, entityType: string, entityId: string, data: Buffer, name: string) =>
  c.uploadWith('/crm/attachments', { entityType, entityId }, data, name);

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  outbox(app).length = 0;
  fake(app).reset();
  installDefaultAgents(fake(app));
  push().sent.length = 0;
  push().gone.clear();
  ({ client: owner, tenantId } = await registerCompany(app, { email: 'owner@acme.sa', company: 'Acme' }));
  accountId = (await owner.post('/crm/accounts', { name: 'مصنع الشرقية' }).expect(201)).body.id;
});

describe('file checks', () => {
  it('detects the real type from the content and cleans names', () => {
    expect(sniff(PDF, 'x.pdf')).toBe('application/pdf');
    expect(sniff(Buffer.from('<html><script>alert(1)</script>'), 'invoice.pdf')).toBeNull();
    expect(sniff(Buffer.from('PK\x03\x04rest'), 'a.docx')).toContain('wordprocessingml');
    expect(sniff(Buffer.from('PK\x03\x04rest'), 'a.zip')).toBeNull();
    expect(sniff(Buffer.from('الاسم,المدينة\nأ,جدة'), 'list.csv')).toBe('text/csv');
    expect(sniff(Buffer.from([0x4d, 0x5a, 0, 0]), 'list.txt')).toBeNull();
    expect(cleanName('../../etc/pa<s>s"wd.pdf')).toBe('passwd.pdf');
    expect(cleanName(Buffer.from('عرض.pdf').toString('latin1'))).toBe('عرض.pdf');
  });
});

describe('attachments', () => {
  it('uploads, lists and downloads safely, with an Arabic name', async () => {
    const res = await upload(owner, 'account', accountId, PDF, 'عقد التوريد.pdf').expect(201);
    expect(res.body).toMatchObject({ filename: 'عقد التوريد.pdf', mimeType: 'application/pdf', sizeBytes: PDF.length, uploadedByName: 'Owner Acme' });
    expect((await owner.get(`/crm/attachments?entityType=account&entityId=${accountId}`).expect(200)).body).toHaveLength(1);
    const file = await owner.get(`/crm/attachments/${res.body.id}/file`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe(`attachment; filename="file.pdf"; filename*=UTF-8''${encodeURIComponent('عقد التوريد.pdf')}`);
    expect(file.headers['content-security-policy']).toBe("default-src 'none'");
    const timeline = await ownerQuery<{ type: string }>('SELECT type FROM activities WHERE account_id = $1', [accountId]);
    expect(timeline.map((t) => t.type)).toContain('attachment_added');
  });

  it('refuses disguised or unknown files and oversize uploads', async () => {
    expect((await upload(owner, 'account', accountId, Buffer.from('<html>evil</html>'), 'invoice.pdf').expect(400)).body.error.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
    expect((await upload(owner, 'account', accountId, Buffer.from('MZ\x90\x00'), 'setup.exe').expect(400)).body.error.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
    await upload(owner, 'account', accountId, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 + 10)]), 'big.pdf').expect(413);
    await upload(owner, 'account', '00000000-0000-0000-0000-000000000000', PDF, 'a.pdf').expect(404);
  });

  it('follows the record: reps only for their customers, read-only cannot upload', async () => {
    const { client: rep, membershipId } = await addMember(app, owner, 'rep@acme.sa', 'rep');
    const a = (await upload(owner, 'account', accountId, PDF, 'a.pdf').expect(201)).body;
    await rep.get(`/crm/attachments?entityType=account&entityId=${accountId}`).expect(404);
    await rep.get(`/crm/attachments/${a.id}/file`).expect(404);
    await upload(rep, 'account', accountId, PDF, 'b.pdf').expect(404);
    await owner.patch(`/crm/accounts/${accountId}`, { ownerMembershipId: membershipId }).expect(200);
    await rep.get(`/crm/attachments/${a.id}/file`).expect(200);
    const v = (await rep.post('/crm/visits', { accountId, scheduledStart: new Date(Date.now() + 3600_000).toISOString() }).expect(201)).body;
    await upload(rep, 'visit', v.id, Buffer.from('ملاحظات الزيارة'), 'notes.txt').expect(201);
    const { client: ro } = await addMember(app, owner, 'ro@acme.sa', 'readonly');
    await ro.get(`/crm/attachments?entityType=visit&entityId=${v.id}`).expect(200);
    await upload(ro, 'visit', v.id, PDF, 'c.pdf').expect(403);
    const p = (await owner.post('/crm/proposals', { accountId, title: 'عرض' }).expect(201)).body;
    await upload(owner, 'proposal', p.id, PDF, 'spec.pdf').expect(201);
    expect((await ro.get(`/crm/attachments?entityType=proposal&entityId=${p.id}`).expect(200)).body).toHaveLength(1);
  });

  it('deleting removes the file from storage; storage counts toward the plan', async () => {
    const a = (await upload(owner, 'account', accountId, PDF, 'a.pdf').expect(201)).body;
    const path = join(STORAGE, tenantId, 'attachments', a.id);
    expect(existsSync(path)).toBe(true);
    const [s] = await ownerQuery<{ storage_bytes: string }>('SELECT storage_bytes FROM platform_tenant_stats($1)', [tenantId]);
    expect(Number(s!.storage_bytes)).toBe(PDF.length);
    await owner.delete(`/crm/attachments/${a.id}`).expect(204);
    expect(existsSync(path)).toBe(false);
    await owner.get(`/crm/attachments/${a.id}/file`).expect(404);
    expect((await ownerQuery<{ action: string }>("SELECT action FROM audit_logs WHERE action LIKE 'attachment.%' ORDER BY id")).map((r) => r.action)).toEqual(['attachment.upload', 'attachment.delete']);

    await ownerQuery(`UPDATE plans SET limits = limits || '{"storageMb":0}'::jsonb WHERE key = 'team'`);
    expect((await upload(owner, 'account', accountId, PDF, 'a.pdf').expect(409)).body.error.code).toBe('PLAN_LIMIT_STORAGE');
  });
});

describe('push notifications', () => {
  const sub = (n: number) => ({ endpoint: `https://push.example.com/sub/${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });

  it('registers devices and pushes a title and link only (no customer details)', async () => {
    expect((await owner.get('/push').expect(200)).body).toMatchObject({ enabled: true, devices: 0 });
    await owner.post('/push/subscriptions', { endpoint: 'http://insecure.example.com/x', keys: sub(1).keys }).expect(400);
    expect((await owner.post('/push/subscriptions', sub(1)).expect(200)).body.devices).toBe(1);

    // A rep asks to send a proposal -> the owner (an approver) gets a push.
    const { client: rep, membershipId } = await addMember(app, owner, 'rep@acme.sa', 'rep');
    await owner.patch(`/crm/accounts/${accountId}`, { ownerMembershipId: membershipId }).expect(200);
    const price = (await owner.post('/brain/items', { section: 'pricing', title: 'سعر', fields: { product: 'نقل', price: 100 } }).expect(201)).body;
    await owner.post(`/brain/items/${price.id}/approve`).expect(200);
    const p = (await rep.post('/crm/proposals', { accountId, title: 'عرض', items: [{ brainItemId: price.id, quantity: 1 }] }).expect(201)).body;
    await rep.post(`/crm/proposals/${p.id}/submit`).expect(200);
    expect(push().sent).toEqual([{ endpoint: sub(1).endpoint, payload: { title: 'طلب موافقة جديد بانتظارك', url: '/approvals', tag: 'approval' } }]);
    expect(JSON.stringify(push().sent)).not.toContain('مصنع الشرقية');
    expect((await owner.get('/notifications').expect(200)).body.items[0].body).toContain('مصنع الشرقية'); // details stay in the app
  });

  it('drops devices the push service reports as gone; unsubscribe removes the device', async () => {
    await owner.post('/push/subscriptions', sub(1)).expect(200);
    await owner.post('/push/subscriptions', sub(2)).expect(200);
    push().gone.add(sub(1).endpoint);
    await owner.patch('/automation/jobs/morning_brief', { enabled: true }).expect(200);
    await owner.post('/crm/tasks', { title: 'مهمة', dueAt: new Date(Date.now() - 3600_000).toISOString() }).expect(201);
    await owner.post('/automation/jobs/morning_brief/run').expect(200);
    expect(push().sent.map((s) => s.endpoint)).toEqual([sub(2).endpoint]);
    expect((await owner.get('/push').expect(200)).body.devices).toBe(1);
    await owner.post('/push/subscriptions/remove', { endpoint: sub(2).endpoint }).expect(204);
    expect((await owner.get('/push').expect(200)).body.devices).toBe(0);
  });
});
