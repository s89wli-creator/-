import type * as z from 'zod/v4';

/**
 * Provider-neutral contract for one structured model call.
 * Agents never talk to a vendor SDK directly: they go through AiRuntime -> LlmProvider.
 */
export interface LlmRequest<T> {
  /** Agent key, used for routing/logging and by the fake provider in tests. */
  agent: string;
  system: string;
  prompt: string;
  /** Output schema (zod v4). The provider must return data that parses with it, or null. */
  schema: z.ZodType<T>;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

export interface LlmResult<T> {
  output: T | null;
  refused: boolean;
  stopReason: string | null;
  /** The model that actually answered (may differ from the requested one after a server-side fallback). */
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  /** False when no credentials are configured: AI features show as "not configured", never fake output. */
  readonly ready: boolean;
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** USD per million tokens. Unknown models are billed at the highest known rate (conservative budgets). */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  fake: { in: 0, out: 0 },
};
const MAX_PRICE = { in: 4, out: 20 };

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(k + '-'));
  const p = key ? PRICES[key]! : MAX_PRICE;
  return Math.round(((inputTokens * p.in + outputTokens * p.out) / 1_000_000) * 1e6) / 1e6;
}
