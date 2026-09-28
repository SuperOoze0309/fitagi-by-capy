import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Segmented } from '../components/ui';
import type { MessageKey } from '../i18n';
import type { AiRole } from '../services/ai';
import { aiService } from '../services/ai';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

interface Exchange {
  id: string;
  role: AiRole;
  question: string;
  answer: string;
  /** What was actually sent, so the user can audit it. */
  contextSections: string[];
  contextCharacters: number;
  /** True while the answer is still arriving, so the UI can show a caret. */
  streaming?: boolean;
}

const ROLE_KEYS: Record<AiRole, MessageKey> = {
  recorder: 'ai.roleRecorder',
  reminder: 'ai.roleReminder',
  coach: 'ai.roleCoach',
};

const ROLE_DESCRIPTION_KEYS: Record<AiRole, MessageKey> = {
  recorder: 'ai.roleRecorderDesc',
  reminder: 'ai.roleReminderDesc',
  coach: 'ai.roleCoachDesc',
};

const SUGGESTION_KEYS: Record<AiRole, MessageKey[]> = {
  recorder: ['ai.suggestRecorder1', 'ai.suggestRecorder2', 'ai.suggestRecorder3'],
  reminder: ['ai.suggestReminder1', 'ai.suggestReminder2', 'ai.suggestReminder3'],
  coach: ['ai.suggestCoach1', 'ai.suggestCoach2'],
};

/** Distance from the bottom, in px, within which the thread keeps following along. */
const STICK_THRESHOLD = 96;

/**
 * The AI workspace.
 *
 * Three roles, matching the product spec:
 *  - Recorder: parse, tidy, look up. No advice.
 *  - Reminder: what you did last time.
 *  - Coach: suggestions, always split into recorded FACTS and its own SUGGESTION.
 *
 * The layout is a conversation, not a form: the thread fills the screen, the answer
 * is typed in as it arrives, and the composer is docked at the bottom where a
 * messaging app puts it. With AI off the page is still not a dead end — it explains
 * what to configure and points at the offline Quick Log, which needs no model.
 */
export function AiPage() {
  const { settings } = useApp();
  const { t } = useI18n();
  const toast = useToast();
  const ai = useMemo(() => aiService(settings), [settings]);

  const [role, setRole] = useState<AiRole>(settings.aiRole);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const counter = useRef(0);

  const threadRef = useRef<HTMLDivElement>(null);
  /** Whether the thread is scrolled to the bottom, so streaming can follow it. */
  const stickRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const roleOptions: { value: AiRole; label: string }[] = [
    { value: 'recorder', label: t('ai.roleRecorder') },
    { value: 'reminder', label: t('ai.roleReminder') },
    { value: 'coach', label: t('ai.roleCoach') },
  ];
  const suggestions = SUGGESTION_KEYS[role].map((key) => t(key));

  const scrollToBottom = useCallback((smooth = false) => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // Follow the bottom while an answer streams, but only if the reader is already
  // there: scrolling would otherwise yank the page away from someone reading history.
  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [exchanges, scrollToBottom]);

  const onThreadScroll = useCallback(() => {
    const node = threadRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickRef.current = distance < STICK_THRESHOLD;
  }, []);

  /**
   * Ask, and type the answer in as it arrives.
   *
   * The exchange is inserted before the request resolves so the question and the
   * growing answer are one entry in the thread; a failure replaces that entry's text
   * with the error rather than leaving a half-written answer behind.
   */
  const ask = useCallback(async () => {
    const trimmed = question.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setQuestion('');
    stickRef.current = true;

    counter.current += 1;
    const id = `x${counter.current}`;
    setExchanges((current) => [
      {
        id,
        role,
        question: trimmed,
        answer: '',
        contextSections: [],
        contextCharacters: 0,
        streaming: true,
      },
      ...current,
    ]);

    try {
      const { answer, context } = await ai.askStreaming(trimmed, role, (_delta, full) => {
        setExchanges((current) =>
          current.map((exchange) => (exchange.id === id ? { ...exchange, answer: full } : exchange)),
        );
      });
      setExchanges((current) =>
        current.map((exchange) =>
          exchange.id === id
            ? {
                ...exchange,
                answer,
                streaming: false,
                contextSections: context.sections,
                contextCharacters: context.characters,
              }
            : exchange,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : t('ai.requestFailed');
      setExchanges((current) =>
        current.map((exchange) =>
          exchange.id === id
            ? { ...exchange, answer: message, streaming: false }
            : exchange,
        ),
      );
      toast.show(message, 'error');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [ai, busy, question, role, t, toast]);

  /**
   * Summarise the assembled context, without a question.
   *
   * Deterministic entry point behind the `summarizeTraining` capability: it always
   * uses the summarise prompt (never the role prompt), so it cannot drift into
   * giving advice, and it shows exactly the same disclosure as a question does.
   */
  const summarize = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    stickRef.current = true;

    counter.current += 1;
    const id = `x${counter.current}`;
    setExchanges((current) => [
      {
        id,
        role: 'recorder',
        question: t('ai.summaryQuestion'),
        answer: '',
        contextSections: [],
        contextCharacters: 0,
        streaming: true,
      },
      ...current,
    ]);

    try {
      const context = await ai.buildContext({ includeWeekly: true });
      if (context.text.trim() === '') {
        setExchanges((current) => current.filter((exchange) => exchange.id !== id));
        toast.show(t('ai.nothingToSummarise'));
        return;
      }
      const answer = await ai.summarize(context);
      setExchanges((current) =>
        current.map((exchange) =>
          exchange.id === id
            ? {
                ...exchange,
                answer,
                streaming: false,
                contextSections: context.sections,
                contextCharacters: context.characters,
              }
            : exchange,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : t('ai.requestFailed');
      setExchanges((current) =>
        current.map((exchange) =>
          exchange.id === id ? { ...exchange, answer: message, streaming: false } : exchange,
        ),
      );
      toast.show(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [ai, busy, t, toast]);

  if (!ai.isEnabled()) {
    return (
      <>
        <PageHeader title={t('ai.title')} subtitle={t('ai.offSubtitle')} />
        <main className="app-main">
          <div className="page">
            <div className="card">
              <div className="label-strong">{t('ai.offTitle')}</div>
              <p className="small muted" style={{ margin: 'var(--space-2) 0 0' }}>
                {t('ai.offBody')}
              </p>
            </div>

            <div className="card">
              <div className="section-title" style={{ marginTop: 0 }}>
                {t('ai.toTurnOn')}
              </div>
              <ol className="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
                <li>{t('ai.step1')}</li>
                <li>
                  {t('ai.step2', {
                    openai: 'https://api.openai.com/v1',
                    deepseek: 'https://api.deepseek.com/v1',
                    ollama: 'http://localhost:11434/v1',
                  })}
                </li>
                <li>{t('ai.step3')}</li>
              </ol>
              <p className="small faint" style={{ margin: 'var(--space-3) 0 0' }}>
                {t('ai.keyStaysLocal')}
              </p>
              <div className="page-actions">
                <Link className="btn btn-primary btn-block" to="/settings">
                  {t('ai.openSettings')}
                </Link>
              </div>
            </div>

            <div className="card">
              <div className="row-between">
                <div className="label-strong">{t('ai.worksWithoutAi')}</div>
                <Link className="btn btn-sm" to="/quick-log">
                  {t('ai.openQuickLog')}
                </Link>
              </div>
              <div className="small muted" style={{ marginTop: 'var(--space-2)' }}>
                {t('home.quickLogBody')}
              </div>
            </div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('ai.title')}
        subtitle={ai.describeTarget()}
        action={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowSetup((value) => !value)}
          >
            {t('ai.role')}
          </button>
        }
      />

      {/* The conversation is the page; the composer is docked under it. */}
      <main className="app-main chat-main">
        <div className="page chat-page">
          {showSetup ? (
            <div className="card">
              <div className="row-between row-wrap">
                <div className="label-strong">{t('ai.role')}</div>
                <Segmented
                  ariaLabel={t('ai.role')}
                  value={role}
                  options={roleOptions}
                  onChange={setRole}
                />
              </div>
              <p className="small muted" style={{ margin: 'var(--space-2) 0 0' }}>
                {t(ROLE_DESCRIPTION_KEYS[role])}
              </p>
              <div className="row-between" style={{ marginTop: 'var(--space-3)' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="label-strong">{t('ai.summariseTitle')}</div>
                  <div className="small muted">{t('ai.summariseBody')}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void summarize()}
                >
                  {t('ai.summarise')}
                </button>
              </div>
              <div className="banner" style={{ marginTop: 'var(--space-3)' }}>
                {t('ai.privacy', { target: ai.describeTarget() })}
              </div>
            </div>
          ) : null}

          <div className="chat-thread chat-scroll" ref={threadRef} onScroll={onThreadScroll}>
            {exchanges.length === 0 ? (
              <div className="chat-empty">
                <p className="small muted" style={{ margin: 0 }}>
                  {t(ROLE_DESCRIPTION_KEYS[role])}
                </p>
              </div>
            ) : (
              exchanges.map((exchange) => (
                <div className="chat-turn" key={exchange.id}>
                  <div className="chat-bubble user">{exchange.question}</div>
                  <div className="chat-bubble assistant">
                    <div className="chat-bubble-head">
                      <span className="badge">{t(ROLE_KEYS[exchange.role])}</span>
                      {exchange.streaming ? (
                        <span className="chat-typing small faint">{t('ai.thinking')}</span>
                      ) : null}
                    </div>
                    <div className="chat-answer">
                      {exchange.answer}
                      {exchange.streaming ? <span className="chat-caret" aria-hidden="true" /> : null}
                    </div>
                    {exchange.contextCharacters > 0 ? (
                      <details className="chat-context">
                        <summary className="small faint">
                          {t('ai.sentToModel', { count: exchange.contextCharacters })}
                        </summary>
                        <p className="small faint" style={{ margin: 'var(--space-1) 0 0' }}>
                          {exchange.contextSections.length > 0
                            ? exchange.contextSections.join(', ')
                            : t('ai.noContext')}
                        </p>
                      </details>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>

          {exchanges.length > 0 ? (
            <div className="row-between">
              <span className="small faint">{t('ai.conversation')}</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setExchanges([])}
              >
                {t('common.clear')}
              </button>
            </div>
          ) : null}

          {/* Docked composer: stays put while the thread scrolls behind it. */}
          <div className="chat-composer">
            <div className="chip-row chat-suggestions">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="flag-toggle"
                  onClick={() => {
                    setQuestion(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <div className="chat-input-row">
              <textarea
                id="ai-question"
                ref={inputRef}
                className="textarea chat-input"
                placeholder={t('ai.askPlaceholder')}
                value={question}
                rows={1}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void ask();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary chat-send"
                disabled={busy || question.trim() === ''}
                aria-label={t('ai.ask', { role: t(ROLE_KEYS[role]) })}
                onClick={() => void ask()}
              >
                {busy ? '…' : '↑'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
