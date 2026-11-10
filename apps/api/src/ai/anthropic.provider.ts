import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { LlmProvider, LlmRequest, LlmResult } from './llm';

/**
 * Claude via the official SDK, one structured call per request.
 * - Structured output: the schema is enforced by the API and parsed by the SDK (`parsed_output`).
 * - Server-side fallbacks are enabled ("default" chain): if the primary model is unavailable or declines,
 *   the API retries on its default fallback model; the answering model is reported in `response.model`
 *   and billed at that model's rate.
 * - Refusals and unparseable output come back as `output: null` (the runtime turns them into errors).
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly ready: boolean;
  private readonly client: Anthropic | null;

  constructor(
    apiKey: string | undefined,
    private readonly model: string,
  ) {
    this.ready = !!apiKey;
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 }) : null;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    if (!this.client) throw new Error('Anthropic provider is not configured');
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens ?? 16_000,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
      output_config: { effort: req.effort ?? 'medium', format: betaZodOutputFormat(req.schema) },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const refused = res.stop_reason === 'refusal';
    return {
      output: refused ? null : ((res.parsed_output as T | null) ?? null),
      refused,
      stopReason: res.stop_reason,
      model: res.model,
      inputTokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
  }
}
