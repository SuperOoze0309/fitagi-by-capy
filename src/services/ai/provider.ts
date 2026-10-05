import type { WeightUnit } from '../../domain/types';
import type { TrainingContext } from './contextBuilder';

/**
 * Provider-agnostic LLM surface.
 *
 * Nothing outside this folder knows which vendor is in use: the app only ever
 * talks to an OpenAI-compatible `/chat/completions` endpoint that the user
 * configures themselves, and every method here degrades to "not available" rather
 * than throwing at the call site, because the app must stay fully usable with AI
 * switched off.
 */
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Total request deadline, including the response body. Defaults to two minutes. */
  requestTimeoutMs?: number;
}

/**
 * A message part in the OpenAI content-array shape.
 *
 * Only text and image parts are modelled: those are the two this app sends, and
 * an unmodelled part would be an invitation to send something a text-only
 * endpoint would reject.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** Plain text, or an array of parts when an image is attached. */
  content: string | ContentPart[];
}

/** True when a message carries an image, which decides the endpoint shape to use. */
export function hasImagePart(message: ChatMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url');
}

/** Flatten a message to text for logging and for text-only code paths. */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export interface ParsedSet {
  weight: number | null;
  unit: WeightUnit;
  reps: number | null;
  rpe: number | null;
  rir: number | null;
  isFailure: boolean;
  isWarmup: boolean;
  isDropSet: boolean;
}

export interface ParsedExercise {
  /** Name as the user wrote it. */
  rawName: string;
  sets: ParsedSet[];
}

/** Result of turning free text into structure. Never written to storage directly. */
export interface ParsedWorkoutDraft {
  exercises: ParsedExercise[];
  notes: string;
  /** Names the parser believes refer to an existing exercise. */
  warnings: string[];
  /** Which engine produced this: the offline parser or the model. */
  source: 'local' | 'llm';
  /** Leftover text the parser could not use, e.g. "felt great today". */
  unparsed: string;
}

export interface NormalizationSuggestion {
  /** The name the user typed. */
  rawName: string;
  /** Proposed canonical name. */
  suggested: string;
  reason: string;
  /** True when the suggestion comes from a user rule and is therefore binding. */
  fromUserRule: boolean;
}

export type AiRole = 'recorder' | 'reminder' | 'coach';

/** A prior user/assistant exchange used only to keep follow-up questions coherent. */
export interface ConversationTurn {
  question: string;
  answer: string;
}

export interface LlmProvider {
  /** True when a base URL and model are configured. */
  isConfigured(): boolean;
  /** Human-readable target, e.g. "deepseek-chat @ api.deepseek.com". Shown in the UI. */
  describeTarget(): string;

  /** Raw completion, used by the AI page and by the role prompts. */
  chat(messages: ChatMessage[], options?: { temperature?: number; signal?: AbortSignal }): Promise<string>;

  /**
   * Optional: the same request, delivered as it arrives.
   *
   * A provider that cannot stream simply omits this, and the caller falls back to
   * `chat` with a single delta — which is why the capability is optional rather than
   * a method every implementation has to fake.
   */
  streamChat?(
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    options?: { temperature?: number; signal?: AbortSignal },
  ): Promise<string>;

  /** Free text -> structured draft. Preview/confirm is the caller's job. */
  parseWorkout(text: string, unit: WeightUnit): Promise<ParsedWorkoutDraft>;

  /** Name normalization *suggestions*. The user decides; a rule is never written here. */
  normalizeExercise(names: string[], knownNames: string[]): Promise<NormalizationSuggestion[]>;

  /** Prose summary of the supplied context. */
  summarizeTraining(context: TrainingContext, options?: { signal?: AbortSignal }): Promise<string>;

  /** Assemble the context for a task. Delegates to the Context Builder. */
  generateTrainingContext(request?: {
    question?: string;
    workoutId?: string;
    exerciseNames?: string[];
  }): Promise<TrainingContext>;
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super('AI is not configured. Add a base URL and model in Settings, or use the offline parser.');
  }
}

export class LlmRequestError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** A provider that is switched off: every call explains how to turn AI on. */
export class DisabledLlmProvider implements LlmProvider {
  isConfigured(): boolean {
    return false;
  }

  describeTarget(): string {
    return 'AI off';
  }

  async chat(): Promise<string> {
    throw new LlmNotConfiguredError();
  }

  async parseWorkout(): Promise<ParsedWorkoutDraft> {
    throw new LlmNotConfiguredError();
  }

  async normalizeExercise(): Promise<NormalizationSuggestion[]> {
    return [];
  }

  async summarizeTraining(): Promise<string> {
    throw new LlmNotConfiguredError();
  }

  async generateTrainingContext(): Promise<TrainingContext> {
    throw new LlmNotConfiguredError();
  }
}

/** Convenience guard used by the UI to decide whether to offer AI actions. */
export function isLlmReady(provider: LlmProvider): boolean {
  return provider.isConfigured();
}
