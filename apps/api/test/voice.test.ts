import type { INestApplication } from '@nestjs/common';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VOICE_PROVIDER, type FakeVoiceProvider } from '../src/voice/voice.provider';
import { speakable } from '../src/voice/voice.service';
import { fake, installDefaultAgents } from './ai-fake';
import { addMember, ownerQuery, registerCompany, resetDb, startApp, type TestClient } from './helpers';

let app: INestApplication;
let op: TestClient;
let acme: { client: TestClient; tenantId: string };
const STORAGE = process.env.TEST_STORAGE_DIR ?? '/tmp/rakan-test-storage';
const voice = () => app.get(VOICE_PROVIDER) as FakeVoiceProvider;
const SAMPLE = Buffer.alloc(80_000, 7); // stands in for a recording of the voice owner
const setVoice = (c: TestClient, q = 'name=%D8%B1%D8%A7%D9%83%D8%A7%D9%86&consent=accepted', type = 'audio/webm') =>
  c.postRaw(`/platform/voice?${q}`, SAMPLE, { 'x-audio-type': type });

async function askOnce(c: TestClient): Promise<{ conversationId: string; replyId: number; questionId: number }> {
  const conv = (await c.post('/ai/assistant/messages', { message: 'ما زياراتي بكرة؟' }).expect(200)).body;
  const q = conv.messages.find((m: { role: string }) => m.role === 'user');
  const r = conv.messages.find((m: { role: string }) => m.role === 'assistant');
  return { conversationId: conv.id, replyId: r.id, questionId: q.id };
}
const usage = (tenantId: string) =>
  ownerQuery<{ model: string; input_tokens: number; cost_usd: string }>('SELECT model, input_tokens, cost_usd FROM ai_usage WHERE tenant_id = $1 AND agent_run_id IS NULL ORDER BY id', [tenantId]);

beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => app.close());
beforeEach(async () => {
  await resetDb();
  await ownerQuery('DELETE FROM platform_voice');
  await ownerQuery(`UPDATE platform_settings SET value = '"saudi"' WHERE key = 'speech_style'`);
  fake(app).reset();
  installDefaultAgents(fake(app));
  voice().log.length = 0;
  ({ client: op } = await registerCompany(app, { email: 'ops@rakan.sa', company: 'Rakan Ops' }));
  await ownerQuery("UPDATE users SET is_platform_admin = true WHERE email = 'ops@rakan.sa'");
  acme = await registerCompany(app, { email: 'owner@acme.sa', company: 'Acme' });
});

describe('spokesperson voice setup (platform console)', () => {
  it('is refused to company users; needs consent and a real recording', async () => {
    await setVoice(acme.client).expect(403);
    expect((await setVoice(op, 'name=x1&consent=no').expect(400)).body.error.code).toBe('CONSENT_REQUIRED');
    expect((await setVoice(op, undefined, 'text/plain').expect(400)).body.error.code).toBe('UNSUPPORTED_AUDIO');
    const short = await op.postRaw('/platform/voice?name=abc&consent=accepted', Buffer.alloc(1000), { 'x-audio-type': 'audio/webm' }).expect(400);
    expect(short.body.error.code).toBe('SAMPLE_TOO_SHORT');
    expect(voice().log).toHaveLength(0);
  });

  it('clones once, keeps only the hash, and records the consent in the platform audit', async () => {
    const before = (await op.get('/platform/voice').expect(200)).body;
    expect(before).toMatchObject({ configured: false, providerReady: true });
    expect(before.consentStatement).toContain('بصوتي');
    const v = (await setVoice(op).expect(200)).body;
    expect(v).toMatchObject({ configured: true, displayName: 'راكان', consentedByName: 'Owner Rakan Ops', sampleBytes: SAMPLE.length });
    expect(voice().log).toEqual([{ op: 'clone', arg: { name: 'Rakan spokesperson', samples: 1 } }]);
    const [row] = await ownerQuery<{ sample_sha256: string }>('SELECT sample_sha256 FROM platform_voice');
    expect(row!.sample_sha256).toMatch(/^[0-9a-f]{64}$/);
    const log = (await op.get('/platform/audit').expect(200)).body;
    expect(log[0]).toMatchObject({ action: 'platform.voice.set' });
    expect(log[0].after.consent).toContain('بصوتي');
  });

  it('replacing the voice deletes the old one at the provider', async () => {
    await setVoice(op).expect(200);
    await setVoice(op).expect(200);
    expect(voice().log.map((l) => l.op)).toEqual(['clone', 'clone', 'delete']);
    expect((await op.get('/platform/audit').expect(200)).body[0].action).toBe('platform.voice.replace');
  });
});

describe('Ask Rakan by voice', () => {
  it('status is honest before the voice exists: can listen, cannot speak', async () => {
    const s = (await acme.client.get('/ai/voice/status').expect(200)).body;
    expect(s).toMatchObject({ providerReady: true, voiceConfigured: false, enabled: true, canSpeak: false, canListen: true, maxSeconds: 60 });
    const { replyId } = await askOnce(acme.client);
    expect((await acme.client.post(`/ai/assistant/messages/${replyId}/speech`).expect(503)).body.error.code).toBe('VOICE_NOT_SET');
  });

  it('reads a reply in the spokesperson voice, meters it once and serves replays from the cache', async () => {
    await setVoice(op).expect(200);
    expect((await acme.client.get('/ai/voice/status').expect(200)).body).toMatchObject({ canSpeak: true, voiceName: 'راكان' });
    const { replyId } = await askOnce(acme.client);
    const res = await acme.client.post(`/ai/assistant/messages/${replyId}/speech`).buffer(true).expect(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['x-rakan-synthetic-voice']).toBe('1');
    expect(res.headers['cache-control']).toBe('private, no-store');
    await acme.client.post(`/ai/assistant/messages/${replyId}/speech`).expect(200);
    expect(voice().log.filter((l) => l.op === 'speak')).toHaveLength(1);
    const u = await usage(acme.tenantId);
    expect(u).toHaveLength(1);
    expect(u[0]!.model).toBe('tts:eleven_multilingual_v2');
    expect(Number(u[0]!.cost_usd)).toBeGreaterThan(0);
  });

  it('only reads replies (not questions) and only to the person who asked', async () => {
    await setVoice(op).expect(200);
    const { replyId, questionId } = await askOnce(acme.client);
    await acme.client.post(`/ai/assistant/messages/${questionId}/speech`).expect(404);
    const { client: manager } = await addMember(app, acme.client, 'manager@acme.sa', 'manager');
    await manager.post(`/ai/assistant/messages/${replyId}/speech`).expect(404);
    expect(voice().log.filter((l) => l.op === 'speak')).toHaveLength(0);
  });

  it('turns speech into text, metered by duration', async () => {
    const out = (await acme.client.postRaw('/ai/assistant/transcribe', Buffer.alloc(40_000, 1), { 'x-audio-type': 'audio/webm;codecs=opus', 'x-audio-seconds': '6' }).expect(200)).body;
    expect(out.text).toBe('ما زياراتي بكرة؟');
    const u = await usage(acme.tenantId);
    expect(u).toEqual([expect.objectContaining({ model: 'stt:scribe_v1', input_tokens: 6 })]);
    expect((await acme.client.postRaw('/ai/assistant/transcribe', Buffer.alloc(40_000, 1), { 'x-audio-type': 'video/mp4' }).expect(400)).body.error.code).toBe('UNSUPPORTED_AUDIO');
    expect((await acme.client.postRaw('/ai/assistant/transcribe', Buffer.alloc(10), { 'x-audio-type': 'audio/webm' }).expect(400)).body.error.code).toBe('EMPTY_AUDIO');
  });

  it('respects the company switch and the monthly budget', async () => {
    await setVoice(op).expect(200);
    const { replyId } = await askOnce(acme.client);
    await acme.client.patch('/ai/settings', { voiceEnabled: false }).expect(200);
    expect((await acme.client.get('/ai/voice/status').expect(200)).body).toMatchObject({ enabled: false, canSpeak: false, canListen: false });
    expect((await acme.client.post(`/ai/assistant/messages/${replyId}/speech`).expect(403)).body.error.code).toBe('VOICE_DISABLED');
    await acme.client.postRaw('/ai/assistant/transcribe', Buffer.alloc(40_000, 1), { 'x-audio-type': 'audio/webm' }).expect(403);
    await acme.client.patch('/ai/settings', { voiceEnabled: true, monthlyBudgetUsd: 0 }).expect(200);
    expect((await acme.client.post(`/ai/assistant/messages/${replyId}/speech`).expect(402)).body.error.code).toBe('AI_BUDGET_EXCEEDED');
    expect(voice().log.filter((l) => l.op !== 'clone')).toHaveLength(0);
  });

  it('deleting the voice stops it immediately and erases cached clips', async () => {
    await setVoice(op).expect(200);
    const { replyId } = await askOnce(acme.client);
    await acme.client.post(`/ai/assistant/messages/${replyId}/speech`).expect(200);
    const dir = join(STORAGE, acme.tenantId, 'voice');
    expect(readdirSync(dir).length).toBe(1);
    await acme.client.delete('/platform/voice').expect(403);
    expect((await op.delete('/platform/voice').expect(200)).body.configured).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect((await acme.client.post(`/ai/assistant/messages/${replyId}/speech`).expect(503)).body.error.code).toBe('VOICE_NOT_SET');
    expect(voice().log.map((l) => l.op)).toEqual(['clone', 'speak', 'delete']);
  });
});

describe('ready-made voice (male, general Saudi accent) and speaking style', () => {
  it('uses a library voice only after checking it exists in the provider account', async () => {
    await op.put('/platform/voice/library', { voiceId: 'bad id!', displayName: 'راكان' }).expect(400);
    expect((await op.put('/platform/voice/library', { voiceId: 'unknownVoice01', displayName: 'راكان' }).expect(400)).body.error.code).toBe('VOICE_NOT_FOUND');
    await acme.client.put('/platform/voice/library', { voiceId: 'libSaudiMale01', displayName: 'راكان' }).expect(403);
    const v = (await op.put('/platform/voice/library', { voiceId: 'libSaudiMale01', displayName: 'راكان' }).expect(200)).body;
    expect(v).toMatchObject({ configured: true, kind: 'library', displayName: 'راكان', consentedByName: null, sampleBytes: null });
    expect((await acme.client.get('/ai/voice/status').expect(200)).body).toMatchObject({ canSpeak: true, voiceName: 'راكان' });
    const { replyId } = await askOnce(acme.client);
    await acme.client.post(`/ai/assistant/messages/${replyId}/speech`).expect(200);
    expect(voice().log.find((l) => l.op === 'speak')!.arg).toMatchObject({ voiceId: 'libSaudiMale01' });
    expect((await op.get('/platform/audit').expect(200)).body[0]).toMatchObject({ action: 'platform.voice.library' });
  });

  it('switching from a cloned voice to a library voice deletes the clone; removing a library voice never deletes it at the provider', async () => {
    await setVoice(op).expect(200);
    await op.put('/platform/voice/library', { voiceId: 'libSaudiMale01', displayName: 'راكان' }).expect(200);
    await op.delete('/platform/voice').expect(200);
    expect(voice().log.map((l) => l.op)).toEqual(['clone', 'get', 'delete']);
    expect((voice().log[2]!.arg as string).startsWith('fake-voice')).toBe(true);
  });

  it('previews a fixed sentence for operators only, billed to no company', async () => {
    await op.post('/platform/voice/preview').expect(503);
    await op.put('/platform/voice/library', { voiceId: 'libSaudiMale01', displayName: 'راكان' }).expect(200);
    await acme.client.post('/platform/voice/preview').expect(403);
    const res = await op.post('/platform/voice/preview').buffer(true).expect(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect((await ownerQuery('SELECT 1 FROM ai_usage')).length).toBe(0);
  });

  it('Rakan answers in general Saudi dialect by default; operators can switch to formal Arabic', async () => {
    expect((await op.get('/platform/voice').expect(200)).body.speechStyle).toBe('saudi');
    await askOnce(acme.client);
    expect(fake(app).chats.at(-1)!.system).toContain('اللهجة السعودية العامة');
    await acme.client.put('/platform/voice/style', { style: 'msa' }).expect(403);
    await op.put('/platform/voice/style', { style: 'gulf' }).expect(400);
    expect((await op.put('/platform/voice/style', { style: 'msa' }).expect(200)).body.speechStyle).toBe('msa');
    await askOnce(acme.client);
    expect(fake(app).chats.at(-1)!.system).not.toContain('اللهجة السعودية العامة');
    await op.put('/platform/voice/style', { style: 'saudi' }).expect(200);
  });

  it('a server default voice works without any console setup', async () => {
    const other = await startApp({ ELEVENLABS_DEFAULT_VOICE_ID: 'envSaudiMale01', ELEVENLABS_DEFAULT_VOICE_NAME: 'راكان' });
    try {
      const c = await registerCompany(other, { email: 'owner@env.sa', company: 'Env Co' });
      installDefaultAgents(fake(other));
      expect((await c.client.get('/ai/voice/status').expect(200)).body).toMatchObject({ canSpeak: true, voiceName: 'راكان' });
      const conv = (await c.client.post('/ai/assistant/messages', { message: 'هلا' }).expect(200)).body;
      await c.client.post(`/ai/assistant/messages/${conv.messages.at(-1).id}/speech`).expect(200);
      expect(((other.get(VOICE_PROVIDER) as FakeVoiceProvider).log.at(-1)!.arg as { voiceId: string }).voiceId).toBe('envSaudiMale01');
    } finally {
      await other.close();
    }
  });
});

describe('speakable text', () => {
  it('drops links and markdown and caps the length at a sentence end', () => {
    expect(speakable('**مرحباً** زر https://x.sa/a\n- أولاً\n- ثانياً')).toBe('مرحباً زر ، أولاً ، ثانياً');
    const long = 'جملة قصيرة هنا. '.repeat(200);
    const out = speakable(long);
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out.endsWith('.')).toBe(true);
  });
});
