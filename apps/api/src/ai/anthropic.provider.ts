import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { ChatBlock, ChatRequest, ChatResult, LlmProvider, LlmRequest, LlmResult } from './llm';

type BetaBlock = { type: string; [k: string]: unknown };
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_CONTINUATIONS = 3;

/**
 * Claude via the official SDK.
 * - complete(): one structured call (schema enforced by the API, parsed by the SDK). With `webSearch`, the server-run
 *   web search tool is enabled and every page it returned is reported in `sources`, so the caller can verify citations.
 *   Long searches can stop with `pause_turn`; the turn is continued (a few times at most).
 * - chat(): tool-using conversation for "Ask Rakan" (our own tools; the caller executes them).
 * - Server-side fallbacks are enabled ("default" chain). The model that actually answered is reported in `model`,
 *   and provider blocks we do not interpret (e.g. fallback markers) are echoed back verbatim on the next turn.
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
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: 2, timeout: 180_000 }) : null;
  }

  private get c(): Anthropic {
    if (!this.client) throw new Error('Anthropic provider is not configured');
    return this.client;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const tools = req.webSearch
      ? [{
          type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: req.webSearch.maxUses,
          user_location: { type: 'approximate' as const, country: req.webSearch.country ?? 'SA', ...(req.webSearch.city ? { city: req.webSearch.city } : {}) },
        }]
      : undefined;
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content: req.prompt }];
    const sources = new Map<string, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let webSearches = 0;

    for (let turn = 0; ; turn++) {
      const res = await this.c.beta.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 16_000,
        system: req.system,
        messages,
        ...(tools ? { tools } : {}),
        output_config: { effort: req.effort ?? 'medium', format: betaZodOutputFormat(req.schema) },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      });
      inputTokens += res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0);
      outputTokens += res.usage.output_tokens;
      webSearches += res.usage.server_tool_use?.web_search_requests ?? 0;
      for (const b of res.content as unknown as BetaBlock[]) {
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
          for (const r of b.content as { type: string; url?: string; title?: string }[]) {
            if (r.type === 'web_search_result' && r.url) sources.set(r.url, r.title ?? '');
          }
        }
      }
      if (res.stop_reason === 'pause_turn' && turn < MAX_CONTINUATIONS) {
        messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });
        continue;
      }
      const refused = res.stop_reason === 'refusal';
      return {
        output: refused ? null : ((res.parsed_output as T | null) ?? null),
        refused, stopReason: res.stop_reason, model: res.model, inputTokens, outputTokens,
        sources: [...sources].map(([url, title]) => ({ url, title })), webSearches,
      };
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const toParam = (b: ChatBlock): unknown => {
      switch (b.type) {
        case 'text': return { type: 'text', text: b.text };
        case 'tool_use': return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        case 'tool_result': return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
        case 'opaque': return b.data;
      }
    };
    const res = await this.c.beta.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 8_000,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content.map(toParam) })) as Anthropic.Beta.Messages.BetaMessageParam[],
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.Messages.BetaTool.InputSchema })),
      output_config: { effort: req.effort ?? 'medium' },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    });
    const content: ChatBlock[] = (res.content as unknown as BetaBlock[]).map((b) =>
      b.type === 'text' ? { type: 'text', text: String(b.text) }
      : b.type === 'tool_use' ? { type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input }
      : { type: 'opaque', data: b },
    );
    return {
      content, stopReason: res.stop_reason, refused: res.stop_reason === 'refusal', model: res.model,
      inputTokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0),
      outputTokens: res.usage.output_tokens,
    };
  }
}
