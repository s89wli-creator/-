/**
 * Voice provider contract: clone a consented voice, speak text with it, and transcribe speech.
 * The app never calls a vendor directly — only through this interface (ElevenLabs adapter, test fake).
 */
export interface VoiceSample { data: Buffer; mimeType: string; filename: string }
export interface VoiceProvider {
  readonly name: string;
  readonly ready: boolean;
  cloneVoice(name: string, samples: VoiceSample[], description: string): Promise<{ voiceId: string }>;
  deleteVoice(voiceId: string): Promise<void>;
  /** Looks a voice up in the account (throws if it is not usable). */
  getVoice(voiceId: string): Promise<{ name: string }>;
  /** Returns MP3 audio. */
  speak(voiceId: string, text: string): Promise<Buffer>;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}
export const VOICE_PROVIDER = Symbol('VOICE_PROVIDER');

/**
 * ElevenLabs REST adapter (https://api.elevenlabs.io), key sent as `xi-api-key` from the server only.
 * - Instant voice clone:  POST /v1/voices/add (multipart: name, files[], description, remove_background_noise)
 * - Text to speech:       POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128 (JSON: text, model_id, language_code)
 * - Speech to text:       POST /v1/speech-to-text (multipart: model_id, file, language_code)
 * - Delete voice:         DELETE /v1/voices/{voice_id}
 * - Get voice:            GET /v1/voices/{voice_id}   (library voices must first be added to the account's voices)
 * Verify these against the current ElevenLabs API reference when enabling the key (they could not be fetched
 * from the development environment).
 */
export class ElevenLabsProvider implements VoiceProvider {
  readonly name = 'elevenlabs';
  readonly ready: boolean;
  private readonly base = 'https://api.elevenlabs.io';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly ttsModel: string,
    private readonly sttModel: string,
  ) {
    this.ready = !!apiKey;
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    if (!this.apiKey) throw new Error('Voice provider is not configured');
    const res = await fetch(`${this.base}${path}`, { ...init, headers: { ...(init.headers ?? {}), 'xi-api-key': this.apiKey }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`ElevenLabs ${path} failed: ${res.status} ${detail}`);
    }
    return res;
  }

  async cloneVoice(name: string, samples: VoiceSample[], description: string): Promise<{ voiceId: string }> {
    const form = new FormData();
    form.append('name', name);
    form.append('description', description);
    form.append('remove_background_noise', 'true');
    for (const s of samples) form.append('files', new Blob([new Uint8Array(s.data)], { type: s.mimeType }), s.filename);
    const body = (await (await this.call('/v1/voices/add', { method: 'POST', body: form })).json()) as { voice_id?: string };
    if (!body.voice_id) throw new Error('ElevenLabs did not return a voice id');
    return { voiceId: body.voice_id };
  }

  async deleteVoice(voiceId: string): Promise<void> {
    await this.call(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
  }

  async getVoice(voiceId: string): Promise<{ name: string }> {
    const body = (await (await this.call(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'GET' })).json()) as { name?: string };
    return { name: body.name ?? voiceId };
  }

  async speak(voiceId: string, text: string): Promise<Buffer> {
    const res = await this.call(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: this.ttsModel, voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
    });
    return Buffer.from(await res.arrayBuffer());
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append('model_id', this.sttModel);
    form.append('language_code', 'ara');
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'speech');
    const body = (await (await this.call('/v1/speech-to-text', { method: 'POST', body: form })).json()) as { text?: string };
    return (body.text ?? '').trim();
  }
}

/** Deterministic provider for automated tests only (refused in production by config validation). */
export class FakeVoiceProvider implements VoiceProvider {
  readonly name = 'fake';
  readonly ready = true;
  readonly log: { op: string; arg?: unknown }[] = [];
  transcript = 'ما زياراتي بكرة؟';

  async cloneVoice(name: string, samples: VoiceSample[]): Promise<{ voiceId: string }> {
    this.log.push({ op: 'clone', arg: { name, samples: samples.length } });
    return { voiceId: `fake-voice-${samples.length}` };
  }
  async deleteVoice(voiceId: string): Promise<void> {
    this.log.push({ op: 'delete', arg: voiceId });
  }
  async getVoice(voiceId: string): Promise<{ name: string }> {
    this.log.push({ op: 'get', arg: voiceId });
    if (!voiceId.startsWith('lib')) throw new Error('voice not found');
    return { name: 'Saudi male' };
  }
  async speak(voiceId: string, text: string): Promise<Buffer> {
    this.log.push({ op: 'speak', arg: { voiceId, chars: text.length } });
    // A tiny MPEG frame header + payload: enough to be served as audio/mpeg.
    return Buffer.concat([Buffer.from('fffb9064', 'hex'), Buffer.from(text.slice(0, 64))]);
  }
  async transcribe(audio: Buffer): Promise<string> {
    this.log.push({ op: 'transcribe', arg: audio.length });
    return this.transcript;
  }
}
