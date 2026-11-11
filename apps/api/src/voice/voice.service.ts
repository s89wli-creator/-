import { Inject, Injectable, Logger } from '@nestjs/common';
import { aiUsage, assistantConversations, assistantMessages, platformAudit, platformSettings, platformVoice, tenants, users } from '@rakan/db';
import { SPEECH_STYLES, VOICE_CONSENT_STATEMENT, type PlatformVoiceDto, type SpeechStyle, type VoiceStatusDto } from '@rakan/shared';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { AuthContext, RequestMeta, TenantAuthContext } from '../common/auth-context';
import { DbService } from '../common/db.service';
import { AppError, badRequest, notFound } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config';
import { AiRuntimeService } from '../ai/runtime.service';
import { StorageService } from '../field/storage.service';
import { VOICE_PROVIDER, type VoiceProvider } from './voice.provider';

/** Longest reply read aloud (characters). Longer replies are cut at a sentence end. */
export const MAX_SPOKEN_CHARS = 1200;
/** Longest question spoken by a user, in seconds (the browser stops recording there too). */
export const MAX_LISTEN_SECONDS = 60;
const SAMPLE_MIN_BYTES = 30_000;
const SAMPLE_MAX_BYTES = 12 * 1024 * 1024;
/** Fixed sentence for previewing the voice (never free text). */
export const PREVIEW_TEXT = 'هلا والله، معك راكان. جاهز أساعدك اليوم: أرتب لك زياراتك، وأذكّرك بالعملاء اللي يبيلهم متابعة، وأجهّز لك ملخص قبل كل اجتماع.';
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/x-m4a'];

/** Turns a written reply into text worth speaking: no markdown, links or long lists of symbols. */
export function speakable(text: string): string {
  let t = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|~]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '، ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > MAX_SPOKEN_CHARS) {
    const cut = t.slice(0, MAX_SPOKEN_CHARS);
    const end = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('؟'), cut.lastIndexOf('!'), cut.lastIndexOf('。'), cut.lastIndexOf('\n'));
    t = end > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, end + 1) : cut;
  }
  return t;
}

function baseType(mime: string | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Rakan's spokesperson voice.
 * - The platform sets ONE voice, cloned from a person who records a sample and accepts the consent statement.
 *   The sample is sent to the provider once and not kept (only its hash). Deleting the voice removes it at
 *   the provider and erases every cached clip.
 * - The voice only ever reads Ask Rakan's own replies to the user who received them (no free-text speech
 *   endpoint, so it cannot be used to make the person "say" anything else).
 * - Users can also speak their question (speech to text).
 * - Every use is metered in the company's AI budget; voice can be turned off per company.
 */
@Injectable()
export class VoiceService {
  private readonly log = new Logger('Voice');

  constructor(
    private readonly db: DbService,
    @Inject(VOICE_PROVIDER) private readonly provider: VoiceProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly runtime: AiRuntimeService,
    private readonly storage: StorageService,
  ) {}

  private current() {
    return this.db.platform(async (tx) => (await tx.select().from(platformVoice).where(eq(platformVoice.id, 1)))[0] ?? null);
  }

  /** The voice in use: the one set in the console, else the server default voice (if configured). */
  private async effective(): Promise<{ voiceId: string; displayName: string; kind: 'cloned' | 'library' | 'env' } | null> {
    const v = await this.current();
    if (v) return { voiceId: v.voiceId, displayName: v.displayName, kind: v.kind };
    const id = this.config.ELEVENLABS_DEFAULT_VOICE_ID;
    return id ? { voiceId: id, displayName: this.config.ELEVENLABS_DEFAULT_VOICE_NAME, kind: 'env' } : null;
  }

  /** How Rakan speaks in Ask Rakan (written and spoken): general Saudi dialect by default. */
  async speechStyle(): Promise<SpeechStyle> {
    const [row] = await this.db.platform((tx) => tx.select().from(platformSettings).where(eq(platformSettings.key, 'speech_style')));
    return (SPEECH_STYLES as readonly unknown[]).includes(row?.value) ? (row!.value as SpeechStyle) : 'saudi';
  }

  private pricing() {
    return { ttsUsdPer1kChars: this.config.VOICE_TTS_USD_PER_1K_CHARS, sttUsdPerMinute: this.config.VOICE_STT_USD_PER_MINUTE };
  }

  private ttsCost(chars: number): number {
    return (chars / 1000) * this.config.VOICE_TTS_USD_PER_1K_CHARS;
  }

  private async meter(auth: TenantAuthContext, model: string, units: number, cost: number): Promise<void> {
    // units: characters spoken (tts) or seconds heard (stt), kept in input_tokens for the usage report.
    await this.db.tenant(auth, (tx) =>
      tx.insert(aiUsage).values({ tenantId: auth.tenantId, provider: this.provider.name, model, inputTokens: units, outputTokens: 0, costUsd: cost }),
    );
  }

  // ---------------------------------------------------------------- company side

  async status(auth: TenantAuthContext): Promise<VoiceStatusDto> {
    const voice = await this.effective();
    const g = await this.db.tenant(auth, (tx) => this.runtime.voiceGate(tx, auth.tenantId));
    const ok = this.provider.ready && g.enabled && !g.budgetReached;
    return {
      providerReady: this.provider.ready, voiceConfigured: !!voice, enabled: g.enabled, budgetReached: g.budgetReached,
      canSpeak: ok && !!voice, canListen: ok, voiceName: voice?.displayName ?? null, maxSeconds: MAX_LISTEN_SECONDS, pricing: this.pricing(),
    };
  }

  /** Reads one of the user's own Ask Rakan replies aloud. Cached per voice, so replaying costs nothing. */
  async speak(auth: TenantAuthContext, messageId: number): Promise<Buffer> {
    const msg = await this.db.tenant(auth, async (tx) => {
      const [m] = await tx
        .select({ content: assistantMessages.content, role: assistantMessages.role })
        .from(assistantMessages)
        .innerJoin(assistantConversations, and(eq(assistantConversations.tenantId, assistantMessages.tenantId), eq(assistantConversations.id, assistantMessages.conversationId)))
        .where(and(eq(assistantMessages.tenantId, auth.tenantId), eq(assistantMessages.id, messageId), eq(assistantConversations.userId, auth.userId)));
      return m;
    });
    if (!msg || msg.role !== 'assistant') throw notFound('Message');
    if (!this.provider.ready) throw new AppError(503, 'VOICE_NOT_CONFIGURED', 'No voice provider is configured');
    const voice = await this.effective();
    if (!voice) throw new AppError(503, 'VOICE_NOT_SET', 'The spokesperson voice has not been set up yet');

    const key = `${auth.tenantId}/voice/${voice.voiceId}/${messageId}.mp3`;
    try {
      return await this.storage.get(auth.tenantId, key);
    } catch {
      /* not cached yet */
    }
    await this.db.tenant(auth, (tx) => this.runtime.assertVoice(tx, auth.tenantId));
    const text = speakable(msg.content);
    if (!text) throw badRequest('NOTHING_TO_SPEAK', 'This reply has no text to read');
    let audio: Buffer;
    try {
      audio = await this.provider.speak(voice.voiceId, text);
    } catch (e) {
      this.log.error({ err: e }, 'text to speech failed');
      throw new AppError(502, 'VOICE_FAILED', 'Could not generate the voice, please try again');
    }
    await this.meter(auth, `tts:${this.config.ELEVENLABS_TTS_MODEL}`, text.length, this.ttsCost(text.length));
    await this.storage.put(auth.tenantId, key, audio);
    return audio;
  }

  /** Speech to text for a question the user spoke (max one minute). */
  async transcribe(auth: TenantAuthContext, audio: Buffer | undefined, mimeType: string | undefined, reportedSeconds: number): Promise<{ text: string }> {
    const type = baseType(mimeType);
    if (!Buffer.isBuffer(audio) || audio.length < 500) throw badRequest('EMPTY_AUDIO', 'No audio was received');
    if (!AUDIO_TYPES.includes(type)) throw badRequest('UNSUPPORTED_AUDIO', 'Unsupported audio format');
    if (!this.provider.ready) throw new AppError(503, 'VOICE_NOT_CONFIGURED', 'No voice provider is configured');
    await this.db.tenant(auth, (tx) => this.runtime.assertVoice(tx, auth.tenantId));
    // Bill on the larger of what the browser reports and what the size implies (~16 KB/s), capped at the limit.
    const fromSize = audio.length / 16_000;
    const seconds = Math.min(MAX_LISTEN_SECONDS, Math.max(1, Number.isFinite(reportedSeconds) ? reportedSeconds : 0, fromSize));
    let text: string;
    try {
      text = await this.provider.transcribe(audio, type);
    } catch (e) {
      this.log.error({ err: e }, 'speech to text failed');
      throw new AppError(502, 'VOICE_FAILED', 'Could not understand the recording, please try again');
    }
    await this.meter(auth, `stt:${this.config.ELEVENLABS_STT_MODEL}`, Math.ceil(seconds), (seconds / 60) * this.config.VOICE_STT_USD_PER_MINUTE);
    return { text: text.slice(0, 2000) };
  }

  // ---------------------------------------------------------------- platform side

  async platformGet(): Promise<PlatformVoiceDto> {
    const v = await this.db.platform(async (tx) => {
      const [row] = await tx.select({ v: platformVoice, name: users.fullName }).from(platformVoice).leftJoin(users, eq(users.id, platformVoice.consentedBy));
      return row ?? null;
    });
    const eff = await this.effective();
    const cloned = v?.v.kind === 'cloned';
    return {
      providerReady: this.provider.ready, provider: this.provider.name, configured: !!eff, kind: eff?.kind ?? null,
      displayName: eff?.displayName ?? null, speechStyle: await this.speechStyle(),
      consentStatement: (cloned ? v?.v.consentStatement : null) ?? VOICE_CONSENT_STATEMENT, consentedByName: cloned ? (v?.name ?? null) : null,
      consentedAt: cloned ? (v?.v.consentedAt.toISOString() ?? null) : null, sampleBytes: cloned ? (v?.v.sampleBytes ?? null) : null,
      pricing: this.pricing(),
    };
  }

  private async audit(auth: AuthContext, action: string, before: unknown, after: unknown, meta: RequestMeta): Promise<void> {
    await this.db.platform((tx) =>
      tx.insert(platformAudit).values({
        actorUserId: auth.userId, action, tenantId: null, before: before ?? null, after: after ?? null,
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      }),
    );
  }

  /** Erases every cached clip of the voice (all companies). */
  private async purgeClips(): Promise<void> {
    const ids = await this.db.platform((tx) => tx.select({ id: tenants.id }).from(tenants));
    for (const { id } of ids) await this.storage.remove(id, `${id}/voice`).catch(() => undefined);
  }

  /**
   * Sets (or replaces) the spokesperson voice from a recording of the person, who must be the operator doing it
   * and must accept the consent statement.
   */
  async platformSet(
    auth: AuthContext,
    input: { sample: Buffer | undefined; mimeType: string | undefined; displayName: string; consent: string },
    meta: RequestMeta,
  ): Promise<PlatformVoiceDto> {
    if (input.consent !== 'accepted') throw badRequest('CONSENT_REQUIRED', 'The voice owner must accept the consent statement');
    const name = input.displayName.trim();
    if (name.length < 2 || name.length > 60) throw badRequest('VALIDATION_ERROR', 'Display name must be 2–60 characters');
    const type = baseType(input.mimeType);
    if (!AUDIO_TYPES.includes(type)) throw badRequest('UNSUPPORTED_AUDIO', 'Unsupported audio format');
    const sample = input.sample;
    if (!Buffer.isBuffer(sample) || sample.length < SAMPLE_MIN_BYTES) throw badRequest('SAMPLE_TOO_SHORT', 'The recording is too short');
    if (sample.length > SAMPLE_MAX_BYTES) throw badRequest('SAMPLE_TOO_LARGE', 'The recording is too large');
    if (!this.provider.ready) throw new AppError(503, 'VOICE_NOT_CONFIGURED', 'No voice provider is configured');

    const before = await this.current();
    const ext = type.split('/')[1]!.replace('x-', '');
    let voiceId: string;
    try {
      ({ voiceId } = await this.provider.cloneVoice('Rakan spokesperson', [{ data: sample, mimeType: type, filename: `sample.${ext}` }], 'Official spokesperson voice of Rakan (consented)'));
    } catch (e) {
      this.log.error({ err: e }, 'voice clone failed');
      throw new AppError(502, 'VOICE_FAILED', 'The voice provider could not create the voice');
    }
    const sha = createHash('sha256').update(sample).digest('hex');
    const row = {
      kind: 'cloned' as const, provider: this.provider.name, voiceId, displayName: name, consentStatement: VOICE_CONSENT_STATEMENT, consentedBy: auth.userId,
      consentedAt: new Date(), sampleSha256: sha, sampleBytes: sample.length, createdAt: new Date(),
    };
    await this.db.platform((tx) => tx.insert(platformVoice).values({ id: 1, ...row }).onConflictDoUpdate({ target: platformVoice.id, set: row }));
    await this.retire(before);
    await this.audit(auth, before ? 'platform.voice.replace' : 'platform.voice.set', before ? { displayName: before.displayName, sampleSha256: before.sampleSha256 } : null,
      { displayName: name, sampleSha256: sha, sampleBytes: sample.length, provider: this.provider.name, consent: VOICE_CONSENT_STATEMENT }, meta);
    return this.platformGet();
  }

  /** After a voice is replaced or removed: delete a cloned voice at the provider (library voices are not ours) and erase clips. */
  private async retire(before: Awaited<ReturnType<VoiceService['current']>>): Promise<void> {
    if (!before) return;
    if (before.kind === 'cloned' && this.provider.ready) {
      await this.provider.deleteVoice(before.voiceId).catch((e) => this.log.warn({ err: e }, 'old voice not deleted at provider'));
    }
    await this.purgeClips();
  }

  /**
   * Uses a ready-made voice from the provider's voice library (e.g. a male voice with a general Saudi accent).
   * The voice must be in the provider account ("My Voices"); it is checked there before being used.
   */
  async platformSetLibrary(auth: AuthContext, input: { voiceId: string; displayName: string }, meta: RequestMeta): Promise<PlatformVoiceDto> {
    if (!this.provider.ready) throw new AppError(503, 'VOICE_NOT_CONFIGURED', 'No voice provider is configured');
    let providerName: string;
    try {
      ({ name: providerName } = await this.provider.getVoice(input.voiceId));
    } catch {
      throw badRequest('VOICE_NOT_FOUND', 'This voice was not found in the voice provider account');
    }
    const before = await this.current();
    const row = {
      kind: 'library' as const, provider: this.provider.name, voiceId: input.voiceId, displayName: input.displayName, consentStatement: null,
      consentedBy: auth.userId, consentedAt: new Date(), sampleSha256: null, sampleBytes: null, createdAt: new Date(),
    };
    await this.db.platform((tx) => tx.insert(platformVoice).values({ id: 1, ...row }).onConflictDoUpdate({ target: platformVoice.id, set: row }));
    if (before?.voiceId !== input.voiceId) await this.retire(before);
    await this.audit(auth, 'platform.voice.library', before ? { displayName: before.displayName, kind: before.kind } : null,
      { displayName: input.displayName, voiceId: input.voiceId, providerVoiceName: providerName }, meta);
    return this.platformGet();
  }

  /** Speaks a fixed sentence with the voice in use (to hear it before companies do). Not billed to any company. */
  async preview(): Promise<Buffer> {
    if (!this.provider.ready) throw new AppError(503, 'VOICE_NOT_CONFIGURED', 'No voice provider is configured');
    const voice = await this.effective();
    if (!voice) throw new AppError(503, 'VOICE_NOT_SET', 'The spokesperson voice has not been set up yet');
    try {
      return await this.provider.speak(voice.voiceId, PREVIEW_TEXT);
    } catch (e) {
      this.log.error({ err: e }, 'voice preview failed');
      throw new AppError(502, 'VOICE_FAILED', 'Could not generate the voice, please try again');
    }
  }

  async setSpeechStyle(auth: AuthContext, style: SpeechStyle, meta: RequestMeta): Promise<PlatformVoiceDto> {
    const before = await this.speechStyle();
    await this.db.platform((tx) =>
      tx.insert(platformSettings).values({ key: 'speech_style', value: style, updatedBy: auth.userId })
        .onConflictDoUpdate({ target: platformSettings.key, set: { value: style, updatedBy: auth.userId, updatedAt: new Date() } }),
    );
    await this.audit(auth, 'platform.voice.style', { style: before }, { style }, meta);
    return this.platformGet();
  }

  /** Removes the voice set in the console (a cloned voice is deleted at the provider); erases cached clips. */
  async platformRemove(auth: AuthContext, meta: RequestMeta): Promise<PlatformVoiceDto> {
    const v = await this.current();
    if (!v) throw notFound('Voice');
    await this.db.platform((tx) => tx.delete(platformVoice).where(eq(platformVoice.id, 1)));
    await this.retire(v);
    await this.audit(auth, 'platform.voice.delete', { displayName: v.displayName, kind: v.kind, sampleSha256: v.sampleSha256 }, null, meta);
    return this.platformGet();
  }
}
