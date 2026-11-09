import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let owner: TestClient;

beforeAll(async () => {
  app = await startApp({ IMPORT_MAX_ROWS: '50' });
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  ({ client: owner } = await registerCompany(app, { email: 'owner@acme.sa', company: 'Acme' }));
});

const CSV = [
  'اسم الشركة,السجل التجاري,المدينة,الهاتف,اسم المسؤول,جوال المسؤول,ملاحظات,عمود غير معروف',
  'مصنع الأمل للأغذية,1010000001,الرياض,0112223333,سعد,0501112222,عميل محتمل قوي,x',
  ',1010000002,جدة,,,,,x', // no name -> invalid
  'شركة موجودة مسبقاً,1010999999,الدمام,,,,,x', // duplicate of an existing account (same CR)
  'شركة مصنع الأمل للأغذية المحدودة,,الرياض,,,,,x', // in-file duplicate of row 1 (same name, legal suffix differs, same city)
  'مستودعات الشمال,1010000005,حائل,123,,,,x', // invalid phone -> warning only
].join('\n');

describe('account import', () => {
  it('upload -> auto-map -> review (validation, duplicates) -> resolve -> execute', async () => {
    const existing = (await owner.post('/crm/accounts', { name: 'اسم قديم', crNumber: '1010999999' }).expect(201)).body;

    const job = (await owner.upload('/crm/imports', Buffer.from(CSV), 'عملاء.csv').expect(201)).body;
    expect(job.filename).toBe('عملاء.csv');
    expect(job.stats.rows).toBe(5);
    expect(job.suggestedMapping).toMatchObject({
      name: 'اسم الشركة', crNumber: 'السجل التجاري', city: 'المدينة', phone: 'الهاتف',
      'contact.fullName': 'اسم المسؤول', 'contact.phone': 'جوال المسؤول', note: 'ملاحظات',
    });

    // Must confirm lawful use of the data.
    expect((await owner.put(`/crm/imports/${job.id}/mapping`, { mapping: job.suggestedMapping })).status).toBe(400);
    expect((await owner.put(`/crm/imports/${job.id}/mapping`, { mapping: { ...job.suggestedMapping, name: 'nope' }, dataPermissionConfirmed: true })).body.error.code).toBe('INVALID_MAPPING');

    const reviewed = (await owner.put(`/crm/imports/${job.id}/mapping`, { mapping: job.suggestedMapping, dataPermissionConfirmed: true }).expect(200)).body;
    expect(reviewed.status).toBe('review');
    expect(reviewed.stats).toMatchObject({ rows: 5, valid: 4, invalid: 1, duplicates: 2, warnings: 1 });

    const dups = (await owner.get(`/crm/imports/${job.id}/rows?filter=duplicates`).expect(200)).body.items;
    const dbDup = dups.find((r: { rowNumber: number }) => r.rowNumber === 3);
    expect(dbDup).toMatchObject({ duplicateOfId: existing.id, duplicateOfName: 'اسم قديم', duplicateReason: 'cr_number', resolution: 'skip' });
    expect(dups.find((r: { rowNumber: number }) => r.rowNumber === 4)).toMatchObject({ duplicateReason: 'in_file', resolution: 'skip' });
    const invalid = (await owner.get(`/crm/imports/${job.id}/rows?filter=invalid`).expect(200)).body.items[0];
    expect(invalid).toMatchObject({ rowNumber: 2, resolution: null, errors: [{ field: 'name', code: 'required' }] });
    const warn = (await owner.get(`/crm/imports/${job.id}/rows?filter=warnings`).expect(200)).body.items;
    expect(warn.find((r: { rowNumber: number }) => r.rowNumber === 5).errors).toEqual([{ field: 'phone', code: 'warning:invalid' }]);

    // Resolutions: merge the DB duplicate; invalid rows cannot be imported; only DB duplicates can merge.
    await owner.patch(`/crm/imports/${job.id}/rows/${dbDup.id}`, { resolution: 'merge' }).expect(200);
    expect((await owner.patch(`/crm/imports/${job.id}/rows/${invalid.id}`, { resolution: 'create' })).body.error.code).toBe('INVALID_ROW');
    const inFile = dups.find((r: { rowNumber: number }) => r.rowNumber === 4);
    expect((await owner.patch(`/crm/imports/${job.id}/rows/${inFile.id}`, { resolution: 'merge' })).body.error.code).toBe('INVALID_RESOLUTION');

    const done = (await owner.post(`/crm/imports/${job.id}/execute`).expect(200)).body;
    expect(done.status).toBe('completed');
    expect(done.stats).toMatchObject({ created: 2, merged: 1, skipped: 2 });
    await owner.post(`/crm/imports/${job.id}/execute`).expect(409); // not twice

    const accounts = (await owner.get('/crm/accounts?pageSize=100&sort=name').expect(200)).body.items;
    expect(accounts.map((a: { name: string }) => a.name).sort()).toEqual(['اسم قديم', 'مستودعات الشمال', 'مصنع الأمل للأغذية'].sort());
    const amal = accounts.find((a: { name: string }) => a.name === 'مصنع الأمل للأغذية');
    expect(amal).toMatchObject({ crNumber: '1010000001', city: 'الرياض', phone: '+966112223333', leadSource: 'import' });
    // Merge filled empty fields only (name and CR kept).
    const merged = accounts.find((a: { id: string }) => a.id === existing.id);
    expect(merged).toMatchObject({ name: 'اسم قديم', city: 'الدمام', crNumber: '1010999999' });

    const contacts = (await owner.get(`/crm/accounts/${amal.id}/contacts`).expect(200)).body;
    expect(contacts).toEqual([expect.objectContaining({ fullName: 'سعد', phone: '+966501112222', isPrimary: true })]);
    expect((await owner.get(`/crm/accounts/${amal.id}/notes`)).body[0].body).toBe('عميل محتمل قوي');
    const actions = (await ownerQuery<{ action: string }>(`SELECT action FROM audit_logs WHERE entity_type = 'import' ORDER BY id`)).map((r) => r.action);
    expect(actions).toEqual(['import.upload', 'import.map', 'import.execute']);
  });

  it('imports XLSX with track mapping and default owner', async () => {
    const s = (await owner.post('/crm/tracks', { key: 'shipper', name: 'طالبو النقل' }).expect(201)).body;
    const ownerMember = (await owner.get('/team/members')).body[0].id;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Company Name', 'City', 'Track']);
    ws.addRow(['Fast Foods Co', 'Riyadh', 'طالبو النقل']);
    ws.addRow(['Cold Store LLC', 'Jeddah', 'unknown-track']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const job = (await owner.upload('/crm/imports', buf, 'leads.xlsx').expect(201)).body;
    expect(job.suggestedMapping).toMatchObject({ name: 'Company Name', city: 'City', track: 'Track' });
    const r = (await owner.put(`/crm/imports/${job.id}/mapping`, { mapping: job.suggestedMapping, defaults: { ownerMembershipId: ownerMember }, dataPermissionConfirmed: true }).expect(200)).body;
    expect(r.stats).toMatchObject({ valid: 2, warnings: 1 });
    await owner.post(`/crm/imports/${job.id}/execute`).expect(200);
    const items = (await owner.get('/crm/accounts').expect(200)).body.items;
    expect(items.find((a: { name: string }) => a.name === 'Fast Foods Co').trackId).toBe(s.tracks[0].id);
    expect(items.every((a: { ownerMembershipId: string }) => a.ownerMembershipId === ownerMember)).toBe(true);
  });

  it('rejects oversized and unsupported files; cancel removes raw rows', async () => {
    const big = 'name\n' + Array.from({ length: 51 }, (_, i) => `company ${i}`).join('\n');
    expect((await owner.upload('/crm/imports', Buffer.from(big), 'big.csv')).body.error.code).toBe('TOO_MANY_ROWS');
    expect((await owner.upload('/crm/imports', Buffer.alloc(6 * 1024 * 1024, 65), 'huge.csv')).status).toBe(413);
    expect((await owner.upload('/crm/imports', Buffer.from('x'), 'legacy.xls')).body.error.code).toBe('UNSUPPORTED_FILE');
    const job = (await owner.upload('/crm/imports', Buffer.from('name\nشركة'), 'a.csv').expect(201)).body;
    await owner.post(`/crm/imports/${job.id}/cancel`).expect(200);
    expect(await ownerQuery('SELECT 1 FROM import_rows WHERE import_job_id = $1', [job.id])).toHaveLength(0);
  });
});

describe('account export', () => {
  it('exports CSV (BOM, formula-safe) and XLSX, and audits the export', async () => {
    await owner.post('/crm/accounts', { name: '=HYPERLINK("http://evil")', city: 'الرياض' }).expect(201);
    await owner.post('/crm/accounts', { name: 'شركة عادية', city: 'جدة' }).expect(201);
    const csv = await owner.get('/crm/accounts/export?format=csv').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(csv.status).toBe(200);
    const text = (csv.body as Buffer).toString('utf8');
    expect(text.startsWith('﻿الاسم,')).toBe(true);
    expect(text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    const xlsx = await owner.get('/crm/accounts/export?format=xlsx&city=جدة').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    expect(wb.worksheets[0]!.rowCount).toBe(2); // header + 1 filtered row
    const logs = await ownerQuery<{ after: { count: number } }>(`SELECT after FROM audit_logs WHERE action = 'account.export' ORDER BY id`);
    expect(logs.map((l) => l.after.count)).toEqual([2, 1]);
  });
});
