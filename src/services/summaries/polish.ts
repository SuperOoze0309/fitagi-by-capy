import type { TrainingSummary } from '../../domain/types';
import { nowIso } from '../../domain/datetime';
import type { Repositories } from '../../repositories';
import type { AiService } from '../ai';

/**
 * Optional polish layer for summaries.
 *
 * The rule that shapes this file: **the local summary is the source of truth.**
 * `body` is generated on-device from real sets, so it always exists and is always
 * accurate. An LLM may only *rephrase* it into `llmBody`, and:
 *
 *  - the local `body` is never overwritten;
 *  - if AI is off, `polishSummary` is a no-op that returns the summary unchanged;
 *  - if the model fails or returns something unusable, the local body stands and
 *    the failure is not surfaced as an error the user has to deal with;
 *  - the numbers in the polished text are not trusted — the UI renders the local
 *    highlights and bullets for figures, and uses the prose for reading only.
 */
export interface PolishResult {
  summary: TrainingSummary;
  polished: boolean;
  reason?: string;
}

/** Text the model is allowed to see: one period's own summary, never the database. */
export function polishPrompt(summary: TrainingSummary): string {
  return [
    `Period: ${summary.kind} ${summary.periodKey}`,
    `Sessions: ${summary.sessionCount}`,
    `Working sets: ${summary.highlights.find((h) => h.label === 'Working sets')?.value ?? '—'}`,
    `Volume: ${summary.highlights.find((h) => h.label === 'Volume')?.value ?? '—'}`,
    `Time: ${summary.highlights.find((h) => h.label === 'Time')?.value ?? '—'}`,
    '',
    'Current summary text:',
    summary.body,
  ].join('\n');
}

/**
 * Ask the configured model to rewrite the summary prose.
 *
 * Returns the summary unchanged whenever AI is not configured, which is the normal
 * case — the app's summaries never depend on this.
 */
export async function polishSummary(
  repos: Repositories,
  ai: AiService,
  summary: TrainingSummary,
): Promise<PolishResult> {
  if (!ai.isEnabled()) {
    return { summary, polished: false, reason: 'AI is off' };
  }

  try {
    const context = await ai.buildContext({});
    void context;
    const rewritten = await ai.llm.chat([
      {
        role: 'system',
        content: [
          'You rewrite a workout summary for the lifter who logged it.',
          'Keep every number exactly as given. Do not add numbers, exercises or advice.',
          'Reply with plain prose only, 2 to 4 sentences, no headings and no bullet points.',
        ].join(' '),
      },
      { role: 'user', content: polishPrompt(summary) },
    ]);

    const text = rewritten.trim();
    // A model that answers with nothing, or with a wall of text, is not an
    // improvement on what we already have.
    if (text.length < 20 || text.length > 1200) {
      return { summary, polished: false, reason: 'model reply was unusable' };
    }

    const updated: TrainingSummary = {
      ...summary,
      llmBody: text,
      source: 'llm',
      updatedAt: nowIso(),
    };
    await repos.summaries.save(updated);
    return { summary: updated, polished: true };
  } catch (error) {
    return {
      summary,
      polished: false,
      reason: error instanceof Error ? error.message : 'polish failed',
    };
  }
}

/**
 * The text to render for a summary.
 *
 * `llmBody` is only used when it exists; otherwise the local body. This is why
 * clearing AI, switching models or losing a network connection can never leave a
 * summary blank.
 */
export function displayBody(summary: TrainingSummary): string {
  const polished = summary.llmBody?.trim();
  return polished && polished !== '' ? polished : summary.body;
}

/** True when what is displayed came from a model. */
export function isPolished(summary: TrainingSummary): boolean {
  const polished = summary.llmBody?.trim();
  return Boolean(polished && polished !== '');
}

/** Drop the polished text and fall back to the local body. */
export async function clearPolish(
  repos: Repositories,
  summary: TrainingSummary,
): Promise<TrainingSummary> {
  const { llmBody: _dropped, ...rest } = summary;
  void _dropped;
  const updated: TrainingSummary = { ...rest, source: 'auto', updatedAt: nowIso() };
  await repos.summaries.save(updated);
  return updated;
}
