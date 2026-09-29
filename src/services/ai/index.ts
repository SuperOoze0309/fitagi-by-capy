import type { Meal, Settings, UserProfile, WeightUnit } from '../../domain/types';
import { repositories, type Repositories } from '../../repositories';
import { ContextBuilder, type ContextRequest, type TrainingContext } from './contextBuilder';
import { OpenAiCompatibleProvider } from './openaiProvider';
import { systemPromptFor } from './prompts';
import {
  DisabledLlmProvider,
  LlmNotConfiguredError,
  isLlmReady,
  messageText,
  type AiRole,
  type ChatMessage,
  type ConversationTurn,
  type LlmProvider,
  type NormalizationSuggestion,
  type ParsedWorkoutDraft,
} from './provider';
import { parseWorkoutText } from './localParser';
import { detectVisionSupport, type VisionCapability } from './vision';
import {
  analyseMealPhoto,
  imageMessages,
  reviseMeal,
  MEAL_ANALYSIS_SYSTEM,
  type AnalysisResult,
} from './mealAnalysis';
import { buildUserContext } from './userContext';
import {
  proposePlan,
  proposeReminders,
  type PlanContext,
  type PlanProposal,
  type ReminderContext,
  type ReminderProposal,
} from './proposals';

export * from './provider';
export * from './prompts';
export * from './vision';
export * from './userContext';
export {
  parsePlanProposal,
  parseReminderProposals,
  usualTrainingTimes,
  type PlanProposal,
  type PlanProposalDay,
  type ReminderContext,
  type ReminderProposal,
} from './proposals';
export {
  analyseMealPhoto,
  reviseMeal,
  VisionNotSupportedError,
  VisionRejectedError,
  parseAnalysis,
} from './mealAnalysis';
export { ContextBuilder } from './contextBuilder';
export { OpenAiCompatibleProvider, normalizeBaseUrl } from './openaiProvider';
export { parseWorkoutText, looksLikeWorkout } from './localParser';

/**
 * AI facade.
 *
 * One place that knows how to turn the user's settings into a provider, and one
 * place that decides when AI is involved at all. Everything here is safe to call
 * with AI switched off: parsing falls back to the offline parser and chat reports
 * that it is not configured, so no page needs to special-case "AI is disabled".
 */
export class AiService {
  private readonly contextBuilder: ContextBuilder;
  private provider: LlmProvider;

  constructor(
    private readonly repos: Repositories,
    settings: Settings,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.contextBuilder = new ContextBuilder(repos);
    this.provider = this.buildProvider(settings);
  }

  /** Rebuild after the user edits settings, so changes apply without a reload. */
  applySettings(settings: Settings): void {
    this.provider = this.buildProvider(settings);
  }

  private buildProvider(settings: Settings): LlmProvider {
    const configured =
      settings.aiEnabled &&
      settings.aiBaseUrl.trim() !== '' &&
      settings.aiModel.trim() !== '';
    if (!configured) return new DisabledLlmProvider();

    const config = {
      baseUrl: settings.aiBaseUrl,
      apiKey: settings.aiApiKey,
      model: settings.aiModel,
    };
    return this.fetchImpl
      ? new OpenAiCompatibleProvider(config, this.contextBuilder, this.fetchImpl)
      : new OpenAiCompatibleProvider(config, this.contextBuilder);
  }

  get llm(): LlmProvider {
    return this.provider;
  }

  isEnabled(): boolean {
    return isLlmReady(this.provider);
  }

  describeTarget(): string {
    return this.provider.describeTarget();
  }

  /**
   * Natural-language input -> draft.
   *
   * Always returns a draft, never writes anything. With AI off this is the offline
   * parser; with AI on the offline parser is still tried first.
   */
  async parseWorkout(text: string, unit: WeightUnit): Promise<ParsedWorkoutDraft> {
    if (!this.provider.isConfigured()) return parseWorkoutText(text, { defaultUnit: unit });
    return this.provider.parseWorkout(text, unit);
  }

  /**
   * Normalization suggestions, with user rules applied first.
   *
   * The provider is only asked about names no rule covers, and a rule result is
   * returned with `fromUserRule: true` so the UI can present it as decided rather
   * than as a proposal.
   */
  async suggestNormalization(rawNames: string[]): Promise<NormalizationSuggestion[]> {
    const unique = [...new Set(rawNames.map((name) => name.trim()).filter((name) => name !== ''))];
    if (unique.length === 0) return [];

    const suggestions: NormalizationSuggestion[] = [];
    const unresolved: string[] = [];

    for (const name of unique) {
      const fromRule = await this.repos.rules.resolve(name);
      if (fromRule && fromRule !== name) {
        suggestions.push({
          rawName: name,
          suggested: fromRule,
          reason: 'your alias rule',
          fromUserRule: true,
        });
      } else {
        unresolved.push(name);
      }
    }

    if (unresolved.length === 0 || !this.provider.isConfigured()) return suggestions;

    const known = (await this.repos.exercises.suggestions(100)).map((item) => item.name);
    const fromModel = await this.provider.normalizeExercise(unresolved, known);
    return [...suggestions, ...fromModel];
  }

  /** Ask the configured role a question, with only the relevant context attached. */
  async ask(
    question: string,
    role: AiRole,
    options: { workoutId?: string; exerciseNames?: string[]; history?: ConversationTurn[] } = {},
  ): Promise<{ answer: string; context: TrainingContext }> {
    if (!this.provider.isConfigured()) throw new LlmNotConfiguredError();

    const detected =
      options.exerciseNames && options.exerciseNames.length > 0
        ? options.exerciseNames
        : await this.contextBuilder.detectExerciseNames(question);

    const request: ContextRequest = {
      question,
      exerciseNames: detected,
      includeWeekly: true,
      // Only pull the monthly rollup when the question is actually about a trend.
      includeMonthly: /month|月|trend|趋势|progress|进步|这几周|最近几个/i.test(question),
      ...(options.workoutId ? { workoutId: options.workoutId } : {}),
    };

    const context = await this.contextBuilder.build(request);
    const memory = conversationMessages(options.history ?? []);
    addConversationDisclosure(context, memory);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPromptFor(role) },
      ...memory.messages,
      { role: 'user', content: context.text },
    ];

    return { answer: await this.provider.chat(messages), context };
  }

  /**
   * The same question, streamed.
   *
   * `onDelta` receives each fragment as it arrives so the answer can be typed onto
   * the screen. Providers that cannot stream call it once with the whole answer, so
   * the caller needs no second code path — and the resolved value is always the
   * complete text, which is what gets stored in the conversation.
   */
  async askStreaming(
    question: string,
    role: AiRole,
    onDelta: (delta: string, full: string) => void,
    options: {
      workoutId?: string;
      exerciseNames?: string[];
      history?: ConversationTurn[];
      signal?: AbortSignal;
    } = {},
  ): Promise<{ answer: string; context: TrainingContext }> {
    if (!this.provider.isConfigured()) throw new LlmNotConfiguredError();

    const detected =
      options.exerciseNames && options.exerciseNames.length > 0
        ? options.exerciseNames
        : await this.contextBuilder.detectExerciseNames(question);

    const request: ContextRequest = {
      question,
      exerciseNames: detected,
      includeWeekly: true,
      includeMonthly: /month|月|trend|趋势|progress|进步|这几周|最近几个/i.test(question),
      ...(options.workoutId ? { workoutId: options.workoutId } : {}),
    };

    const context = await this.contextBuilder.build(request);
    const memory = conversationMessages(options.history ?? []);
    addConversationDisclosure(context, memory);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPromptFor(role) },
      ...memory.messages,
      { role: 'user', content: context.text },
    ];

    const stream = this.provider.streamChat?.bind(this.provider);
    if (!stream) {
      const answer = await this.provider.chat(messages);
      onDelta(answer, answer);
      return { answer, context };
    }

    let full = '';
    const answer = await stream(
      messages,
      (delta) => {
        full += delta;
        onDelta(delta, full);
      },
      options.signal ? { signal: options.signal } : {},
    );
    return { answer, context };
  }

  /** Summarize the supplied context without giving advice. */
  async summarize(context: TrainingContext): Promise<string> {
    return this.provider.summarizeTraining(context);
  }

  buildContext(request: ContextRequest = {}): Promise<TrainingContext> {
    return this.contextBuilder.build(request);
  }

  /** Exercise names mentioned in a question, exposed for the UI's disclosure line. */
  detectExerciseNames(question: string): Promise<string[]> {
    return this.contextBuilder.detectExerciseNames(question);
  }

  // -- meals ------------------------------------------------------------------

  /**
   * What the configured model can do with images.
   *
   * Reported rather than enforced for the `unknown` case: the app must not block a
   * working setup behind a guess, and it must not silently send an image to a
   * model it knows is text-only.
   */
  visionCapability(settings: Settings): VisionCapability {
    return detectVisionSupport(settings.aiModel, settings.aiVisionOverride);
  }

  /**
   * Analyse a meal photo into a proposal.
   *
   * Never writes to storage: the caller shows the result for confirmation, and
   * the user's edits are what actually get saved.
   */
  async analyseMeal(
    imageDataUrl: string,
    profile: UserProfile,
    settings: Settings,
  ): Promise<AnalysisResult> {
    if (!this.provider.isConfigured()) throw new LlmNotConfiguredError();

    return analyseMealPhoto(imageDataUrl, profile, {
      capability: this.visionCapability(settings),
      chat: (messages) => this.provider.chat(messages),
      chatWithImage: async (messages, image) => {
        // The image is folded into the final user turn so the request matches the
        // OpenAI content-array shape exactly.
        const last = messages[messages.length - 1];
        const prompt = last ? messageText(last) : 'Estimate this meal.';
        const content = await this.provider.chat([
          ...imageMessages(MEAL_ANALYSIS_SYSTEM, prompt, image).slice(1),
        ]);
        return { content };
      },
    });
  }

  /** Apply a user correction to a meal proposal, in place of the photo. */
  async reviseMeal(
    current: Meal,
    correction: string,
    profile: UserProfile,
    settings: Settings,
  ): Promise<{ meal: Meal; note: string }> {
    if (!this.provider.isConfigured()) throw new LlmNotConfiguredError();
    return reviseMeal(current, correction, profile, {
      capability: this.visionCapability(settings),
      chat: (messages) => this.provider.chat(messages),
      chatWithImage: async () => {
        throw new Error('A correction is text-only.');
      },
    });
  }

  /** The profile block as it will be sent, for the preview in the profile screen. */
  userContext(profile: UserProfile): string {
    return buildUserContext(profile);
  }

  // -- proposals ---------------------------------------------------------------

  /**
   * Suggested reminders.
   *
   * Throws when AI is off rather than returning an empty list: "the model is not
   * configured" and "the model had no suggestions" are different answers, and the
   * screen says something different for each.
   */
  async proposeReminders(context: ReminderContext): Promise<ReminderProposal[]> {
    if (!this.provider.isConfigured()) throw new LlmNotConfiguredError();
    return proposeReminders(context, { chat: (messages) => this.provider.chat(messages) });
  }

  /** A drafted weekly plan. Writes nothing; the caller shows it for confirmation. */
  async proposePlan(prompt: string, context: PlanContext): Promise<PlanProposal> {
    if (!this.provider.isConfigured()) throw new LlmNotConfiguredError();
    return proposePlan(prompt, context, { chat: (messages) => this.provider.chat(messages) });
  }
}

let cached: AiService | null = null;

/** The app-wide AI service, rebuilt whenever settings change. */
export function aiService(settings: Settings): AiService {
  if (!cached) {
    cached = new AiService(repositories(), settings);
  } else {
    cached.applySettings(settings);
  }
  return cached;
}

/** Test seam: drop the cached service. */
export function resetAiServiceForTests(): void {
  cached = null;
}

/** True when the text is worth sending to a parser at all. */
export function canParse(text: string): boolean {
  return text.trim().length >= 2;
}

interface ConversationMemory {
  messages: ChatMessage[];
  exchanges: number;
  characters: number;
}

const MAX_MEMORY_EXCHANGES = 8;
const MAX_MEMORY_CHARACTERS = 16_000;

/**
 * Keep recent turns in chronological order and cap their size before each request.
 * This gives the model follow-up context without sending an unbounded transcript.
 *
 * Exported as a test seam: the trimming rules are the only thing standing between a
 * long conversation and an oversized request, so they are asserted directly.
 */
export function conversationMessages(history: ConversationTurn[]): ConversationMemory {
  const valid = history
    .filter((turn) => turn.question.trim() !== '' && turn.answer.trim() !== '')
    .slice(-MAX_MEMORY_EXCHANGES);
  const selected: ChatMessage[] = [];
  let exchanges = 0;
  let characters = 0;

  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const turn = valid[index]!;
    const question = trimMemoryText(turn.question, 1_200);
    const answer = trimMemoryText(turn.answer, 2_400);
    const size = question.length + answer.length;
    if (characters + size > MAX_MEMORY_CHARACTERS) break;
    selected.unshift(
      { role: 'user', content: question },
      { role: 'assistant', content: answer },
    );
    characters += size;
    exchanges += 1;
  }

  return { messages: selected, exchanges, characters };
}

function trimMemoryText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = '\n[… earlier text trimmed …]\n';
  const remaining = limit - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = remaining - head;
  return value.slice(0, head) + marker + value.slice(-tail);
}

function addConversationDisclosure(context: TrainingContext, memory: ConversationMemory): void {
  if (memory.exchanges === 0) return;
  context.sections.push('previous conversation (' + memory.exchanges + ' exchanges)');
  context.characters += memory.characters;
}
