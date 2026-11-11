import type { ChatBlock, ChatRequest, ChatResult, LlmProvider, LlmRequest, LlmResult } from './llm';

type Handler = (req: LlmRequest<unknown>) => unknown | { __refuse: true };
type ChatHandler = (req: ChatRequest) => ChatBlock[] | { __refuse: true };

/**
 * Deterministic provider for automated tests only (refused in production by config validation).
 * Tests register a handler per agent; the output is still validated against the agent's schema,
 * exactly like real model output. For web search, a handler may return `__sources` (the pages "found").
 */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly ready = true;
  readonly calls: LlmRequest<unknown>[] = [];
  readonly chats: ChatRequest[] = [];
  private handlers = new Map<string, Handler>();
  private chatHandlers = new Map<string, ChatHandler>();

  on(agent: string, handler: Handler): void {
    this.handlers.set(agent, handler);
  }
  onChat(agent: string, handler: ChatHandler): void {
    this.chatHandlers.set(agent, handler);
  }
  reset(): void {
    this.handlers.clear();
    this.chatHandlers.clear();
    this.calls.length = 0;
    this.chats.length = 0;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push(req as LlmRequest<unknown>);
    const h = this.handlers.get(req.agent);
    if (!h) throw new Error(`FakeProvider: no handler for agent "${req.agent}"`);
    const raw = h(req as LlmRequest<unknown>) as Record<string, unknown> | null;
    const refused = !!raw && typeof raw === 'object' && '__refuse' in raw;
    const sources = (raw?.__sources as { url: string; title: string }[] | undefined) ?? [];
    const body = raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('__'))) : raw;
    const parsed = refused ? null : req.schema.safeParse(body);
    return {
      output: parsed?.success ? parsed.data : null,
      refused,
      stopReason: refused ? 'refusal' : 'end_turn',
      model: 'fake',
      inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4),
      outputTokens: 200,
      sources: req.webSearch ? sources : [],
      webSearches: req.webSearch ? Math.min(req.webSearch.maxUses, sources.length ? 2 : 1) : 0,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.chats.push(JSON.parse(JSON.stringify(req)) as ChatRequest);
    const h = this.chatHandlers.get(req.agent);
    if (!h) throw new Error(`FakeProvider: no chat handler for agent "${req.agent}"`);
    const out = h(req);
    const refused = !Array.isArray(out);
    const content = refused ? [] : out;
    return {
      content, refused, model: 'fake',
      stopReason: refused ? 'refusal' : content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      inputTokens: 300, outputTokens: 80,
    };
  }
}
