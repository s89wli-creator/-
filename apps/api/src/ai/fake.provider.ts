import type { LlmProvider, LlmRequest, LlmResult } from './llm';

type Handler = (req: LlmRequest<unknown>) => unknown | { __refuse: true };

/**
 * Deterministic provider for automated tests only (refused in production by config validation).
 * Tests register a handler per agent; the output is still validated against the agent's schema,
 * exactly like real model output.
 */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly ready = true;
  readonly calls: LlmRequest<unknown>[] = [];
  private handlers = new Map<string, Handler>();

  on(agent: string, handler: Handler): void {
    this.handlers.set(agent, handler);
  }
  reset(): void {
    this.handlers.clear();
    this.calls.length = 0;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.calls.push(req as LlmRequest<unknown>);
    const h = this.handlers.get(req.agent);
    if (!h) throw new Error(`FakeProvider: no handler for agent "${req.agent}"`);
    const raw = h(req as LlmRequest<unknown>);
    const refused = !!raw && typeof raw === 'object' && '__refuse' in raw;
    const parsed = refused ? null : req.schema.safeParse(raw);
    return {
      output: parsed?.success ? parsed.data : null,
      refused,
      stopReason: refused ? 'refusal' : 'end_turn',
      model: 'fake',
      inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4),
      outputTokens: 200,
    };
  }
}
