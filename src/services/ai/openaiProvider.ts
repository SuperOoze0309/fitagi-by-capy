import type { WeightUnit } from '../../domain/types';
import type { ContextBuilder, ContextRequest, TrainingContext } from './contextBuilder';
import { parseWorkoutText } from './localParser';
import {
  PARSE_WORKOUT_SYSTEM,
  NORMALIZE_EXERCISE_SYSTEM,
  SUMMARIZE_SYSTEM,
  parseWorkoutUserPrompt,
  normalizeUserPrompt,
} from './prompts';
import {
  LlmNotConfiguredError,
  LlmRequestError,
  type ChatMessage,
  type LlmConfig,
  type LlmProvider,
  type NormalizationSuggestion,
  type ParsedWorkoutDraft,
  type ParsedExercise,
  type ParsedSet,
} from './provider';

/**
 * OpenAI-compatible chat provider.
 *
 * Works with any endpoint that implements `POST {baseUrl}/chat/completions`:
 * OpenAI, DeepSeek, Kimi, OpenRouter, a local Ollama, or any gateway. No vendor is
 * hardcoded, and the API key never leaves the device except as the `Authorization`
 * header of a request the user explicitly triggered.
 *
 * `fetch` is injectable so the whole client is testable without a network.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly config: LlmConfig,
    private readonly contextBuilder: ContextBuilder,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  isConfigured(): boolean {
    return this.config.baseUrl.trim() !== '' && this.config.model.trim() !== '';
  }

  describeTarget(): string {
    if (!this.isConfigured()) return 'AI off';
    return `${this.config.model} @ ${hostOf(this.config.baseUrl)}`;
  }

  async chat(messages: ChatMessage[], options: { temperature?: number } = {}): Promise<string> {
    if (!this.isConfigured()) throw new LlmNotConfiguredError();
    const response = await this.send(messages, options, false);
    const bodyText = await response.text();
    if (!response.ok) {
      throw new LlmRequestError(describeHttpError(response.status, bodyText), response.status);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new LlmRequestError('The model service returned a response that is not JSON.');
    }

    const content = extractContent(payload);
    if (content === null) {
      throw new LlmRequestError('The model service returned no message content.');
    }
    return content;
  }

  /**
   * The same request, read as it arrives.
   *
   * The name matches `LlmProvider.streamChat` exactly. It used to be `chatStream`
   * here while both the interface and the service called `streamChat`, and because the
   * interface member is optional TypeScript was perfectly happy: the service looked up
   * a method that did not exist, fell back to the non-streaming path, and every answer
   * arrived in one piece. The public README promised streaming the whole time. There is
   * now a test that calls through the service and asserts the implementation is reached.
   *
   * `onDelta` is called with each fragment of text, and the full answer is returned
   * at the end so a caller can keep using it as the final value. Endpoints that
   * ignore `stream` and answer with a single JSON body are handled too — the body is
   * then parsed once and handed over as a single delta, so streaming degrades to
   * "appears all at once" instead of failing.
   */
  async streamChat(
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    options: { temperature?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (!this.isConfigured()) throw new LlmNotConfiguredError();
    const response = await this.send(messages, options, true, options.signal);

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new LlmRequestError(describeHttpError(response.status, bodyText), response.status);
    }

    const contentType = response.headers?.get?.('content-type') ?? '';
    const body = response.body;
    if (!body || typeof body.getReader !== 'function' || contentType.includes('application/json')) {
      // Not a stream: read it whole and emit once.
      const text = await response.text();
      const content = contentFromBody(text);
      onDelta(content);
      return content;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Server-sent events are separated by a blank line; a chunk can split one in
      // half, so only complete events are consumed and the rest stays buffered.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '' || data === '[DONE]') continue;
          const delta = deltaFromChunk(data);
          if (delta !== null && delta !== '') {
            full += delta;
            onDelta(delta);
          }
        }
      }
    }

    // Some gateways end the stream without a trailing blank line.
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data !== '' && data !== '[DONE]') {
        const delta = deltaFromChunk(data);
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      }
    }

    if (full === '') {
      throw new LlmRequestError('The model service returned no message content.');
    }
    return full;
  }

  /** One place that builds the request, so streaming cannot drift from not. */
  private async send(
    messages: ChatMessage[],
    options: { temperature?: number },
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${normalizeBaseUrl(this.config.baseUrl)}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Some local servers do not want an Authorization header at all.
    if (this.config.apiKey.trim() !== '') {
      headers['Authorization'] = `Bearer ${this.config.apiKey.trim()}`;
    }

    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: options.temperature ?? 0.2,
          stream,
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new LlmRequestError(
        `Could not reach ${hostOf(this.config.baseUrl)}. Check the base URL and your connection. (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  /**
   * Parse free text into a draft.
   *
   * The offline parser runs first: if it produced sets, we return those and never
   * spend a request. Only when it fails do we ask the model, and even then the
   * result is a *draft* that the user must confirm.
   */
  async parseWorkout(text: string, unit: WeightUnit): Promise<ParsedWorkoutDraft> {
    const local = parseWorkoutText(text, { defaultUnit: unit });
    if (local.exercises.length > 0) return local;

    if (!this.isConfigured()) return local;

    const raw = await this.chat(
      [
        { role: 'system', content: PARSE_WORKOUT_SYSTEM },
        { role: 'user', content: parseWorkoutUserPrompt(text, unit) },
      ],
      { temperature: 0 },
    );

    const parsed = coerceDraft(safeJson(raw), unit);
    if (!parsed) {
      // Keep the user's text rather than losing it to a bad model response.
      return {
        exercises: [],
        notes: text,
        warnings: ['The model did not return usable structured data. The text was kept as a note.'],
        source: 'llm',
        unparsed: text,
      };
    }
    return parsed;
  }

  async normalizeExercise(
    names: string[],
    knownNames: string[],
  ): Promise<NormalizationSuggestion[]> {
    if (!this.isConfigured() || names.length === 0) return [];

    const raw = await this.chat(
      [
        { role: 'system', content: NORMALIZE_EXERCISE_SYSTEM },
        { role: 'user', content: normalizeUserPrompt(names, knownNames) },
      ],
      { temperature: 0 },
    );

    const payload = safeJson(raw) as { suggestions?: unknown } | null;
    const list = Array.isArray(payload?.suggestions) ? payload!.suggestions : [];
    const suggestions: NormalizationSuggestion[] = [];

    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const rawName = typeof record['rawName'] === 'string' ? record['rawName'].trim() : '';
      const suggested = typeof record['suggested'] === 'string' ? record['suggested'].trim() : '';
      if (rawName === '' || suggested === '' || rawName === suggested) continue;
      // A suggestion for a name the user never typed is a hallucination: drop it.
      if (!names.some((name) => name.toLowerCase() === rawName.toLowerCase())) continue;
      suggestions.push({
        rawName,
        suggested,
        reason: typeof record['reason'] === 'string' ? record['reason'] : 'model suggestion',
        fromUserRule: false,
      });
    }

    return suggestions;
  }

  async summarizeTraining(context: TrainingContext): Promise<string> {
    if (!this.isConfigured()) throw new LlmNotConfiguredError();
    return this.chat([
      { role: 'system', content: SUMMARIZE_SYSTEM },
      { role: 'user', content: context.text },
    ]);
  }

  async generateTrainingContext(request: ContextRequest = {}): Promise<TrainingContext> {
    return this.contextBuilder.build(request);
  }
}

/** Strip a markdown fence if the model added one despite being told not to. */
function safeJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: the outermost object in the text.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function coerceDraft(payload: unknown, defaultUnit: WeightUnit): ParsedWorkoutDraft | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record['exercises'])) return null;

  const exercises: ParsedExercise[] = [];
  for (const entry of record['exercises']) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const rawName = typeof item['rawName'] === 'string' ? item['rawName'].trim() : '';
    if (rawName === '' || !Array.isArray(item['sets'])) continue;

    const sets: ParsedSet[] = [];
    for (const setEntry of item['sets']) {
      if (typeof setEntry !== 'object' || setEntry === null) continue;
      const set = setEntry as Record<string, unknown>;
      sets.push({
        weight: numberOrNull(set['weight']),
        unit: set['unit'] === 'lb' ? 'lb' : set['unit'] === 'kg' ? 'kg' : defaultUnit,
        reps: numberOrNull(set['reps']),
        rpe: numberOrNull(set['rpe']),
        rir: numberOrNull(set['rir']),
        isFailure: set['isFailure'] === true,
        isWarmup: set['isWarmup'] === true,
        isDropSet: set['isDropSet'] === true,
      });
    }
    exercises.push({ rawName, sets });
  }

  if (exercises.length === 0) return null;

  const warnings = Array.isArray(record['warnings'])
    ? record['warnings'].filter((item): item is string => typeof item === 'string')
    : [];

  return {
    exercises,
    notes: typeof record['notes'] === 'string' ? record['notes'] : '',
    warnings,
    source: 'llm',
    unparsed: typeof record['notes'] === 'string' ? record['notes'] : '',
  };
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Accept base URLs with or without a trailing slash and with or without /v1. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function hostOf(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === '') return '(not set)';
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed;
  }
}

/** Turn an HTTP failure into something a user can act on. */
export function describeHttpError(status: number, body: string): string {
  const detail = extractErrorMessage(body);
  switch (status) {
    case 401:
    case 403:
      return `The model service rejected the API key (HTTP ${status}).${detail}`;
    case 404:
      return `No chat endpoint at that base URL (HTTP 404). It usually needs to end in /v1.${detail}`;
    case 429:
      return `Rate limited or out of quota (HTTP 429). Try again shortly.${detail}`;
    default:
      return `The model service returned HTTP ${status}.${detail}`;
  }
}

function extractErrorMessage(body: string): string {
  try {
    const payload = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = payload.error?.message ?? payload.message;
    if (typeof message === 'string' && message.trim() !== '') return ` ${message.trim()}`;
  } catch {
    /* not JSON */
  }
  return '';
}

/** Pull the assistant text out of an OpenAI-compatible response. */
export function extractContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown>;
  const message = first['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  if (typeof content === 'string') return content;
  // Some servers return the text directly on the choice.
  if (typeof first['text'] === 'string') return first['text'];
  return null;
}

/**
 * The text fragment inside one streamed chunk.
 *
 * The streaming shape mirrors the non-streaming one but nests the text under
 * `delta` instead of `message`, and a chunk may carry a role, a finish reason or
 * nothing at all — hence the empty string rather than `null` for "a chunk arrived".
 */
export function deltaFromChunk(data: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as Record<string, unknown>;
  const delta = first['delta'] as Record<string, unknown> | undefined;
  const content = delta?.['content'];
  if (typeof content === 'string') return content;
  // Ollama and some gateways stream the whole message object instead.
  if (typeof first['text'] === 'string') return first['text'];
  return '';
}

/** Content of a whole (non-streamed) body, or an error if it cannot be read. */
function contentFromBody(bodyText: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new LlmRequestError('The model service returned a response that is not JSON.');
  }
  const content = extractContent(payload);
  if (content === null) {
    throw new LlmRequestError('The model service returned no message content.');
  }
  return content;
}
