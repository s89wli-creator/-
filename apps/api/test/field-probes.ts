import { expect } from 'vitest';
import type { CrmFixtures } from './crm-probes';
import { ownerQuery } from './helpers';

const AUDIO = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(60, 7)]);
const one = async (sql: string, p: unknown[]) => (await ownerQuery<Record<string, unknown>>(sql, p))[0];

export interface FieldFixtures { recordingId: string; noteKey: string }

/** Company B: a ready recording on its visit, and a note created with an idempotency key. */
export async function createFieldFixtures(crm: CrmFixtures): Promise<FieldFixtures> {
  const { b, a } = crm;
  await b.patch('/tenant', { settings: { recordingEnabled: true } }).expect(200);
  await a.patch('/tenant', { settings: { recordingEnabled: true } }).expect(200);
  const r = (await b.post(`/crm/visits/${crm.B.visitId}/recordings`, { mimeType: 'audio/webm', totalChunks: 1, consent: true }).expect(201)).body;
  await b.putRaw(`/crm/recordings/${r.id}/chunks/0`, AUDIO).expect(200);
  await b.post(`/crm/recordings/${r.id}/complete`).expect(200);
  await b.post(`/crm/accounts/${crm.B.accountId}/notes`, { body: 'ملاحظة ب مع مفتاح' }).set('idempotency-key', 'shared-key-0001').expect(201);
  return { recordingId: r.id, noteKey: 'shared-key-0001' };
}

export function fieldProbes(c: () => CrmFixtures, f: () => FieldFixtures): Record<string, () => Promise<void>> {
  const nf = async (p: Promise<{ status: number }> | { status: number }) => expect((await p).status).toBe(404);
  return {
    'GET /api/field/today': async () => {
      const s = JSON.stringify((await c().a.get('/field/today').expect(200)).body);
      expect(s).not.toContain(c().B.visitId);
      expect(s).not.toContain(c().B.accountId);
    },
    'GET /api/crm/visits/:id/recordings': async () => nf(c().a.get(`/crm/visits/${c().B.visitId}/recordings`)),
    'POST /api/crm/visits/:id/recordings': async () =>
      nf(c().a.post(`/crm/visits/${c().B.visitId}/recordings`, { mimeType: 'audio/webm', totalChunks: 1, consent: true })),
    'PUT /api/crm/recordings/:id/chunks/:n': async () => nf(c().a.putRaw(`/crm/recordings/${f().recordingId}/chunks/0`, AUDIO)),
    'POST /api/crm/recordings/:id/complete': async () => nf(c().a.post(`/crm/recordings/${f().recordingId}/complete`)),
    'GET /api/crm/recordings/:id/audio': async () => nf(c().a.get(`/crm/recordings/${f().recordingId}/audio`)),
    'PATCH /api/crm/recordings/:id/transcript': async () => {
      await nf(c().a.patch(`/crm/recordings/${f().recordingId}/transcript`, { transcript: 'hijack' }));
      expect((await one('SELECT transcript FROM visit_recordings WHERE id=$1', [f().recordingId]))!.transcript).toBeNull();
    },
    'DELETE /api/crm/recordings/:id': async () => {
      await nf(c().a.delete(`/crm/recordings/${f().recordingId}`));
      expect((await one('SELECT status FROM visit_recordings WHERE id=$1', [f().recordingId]))!.status).toBe('ready');
    },
  };
}

/** Idempotency keys are scoped per company and user: A reusing B's key gets its own execution, never B's response. */
export async function sharedIdempotencyKeyProbe(c: CrmFixtures, f: FieldFixtures): Promise<void> {
  const own = (await c.a.post(`/crm/accounts/${c.A.accountId}/notes`, { body: 'ملاحظة أ' }).set('idempotency-key', f.noteKey).expect(201)).body;
  expect(own.body).toBe('ملاحظة أ');
}
