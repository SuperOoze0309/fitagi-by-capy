import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Field, PageHeader } from '../components/ui';
import { ConfirmDialog, Sheet } from '../components/Sheet';
import { NumberField } from '../components/NumberField';
import { Macro, MealSourceBadge } from './MealsPage';
import { formatBytes, pickImage, type ImageSource } from '../services/imageInput';
import { createEmptyMeal, createEmptyMealItem, sumItems } from '../repositories/mealRepository';
import { nowIso, toDateTimeLocalValue, fromDateTimeLocalValue } from '../domain/datetime';
import { formatNumber } from '../domain/units';
import type { Meal, MealItem } from '../domain/types';
import { repositories } from '../repositories';
import { aiService, VisionNotSupportedError, VisionRejectedError } from '../services/ai';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';

/**
 * Meal editor and photo analysis.
 *
 * The flow the product spec asks for:
 *
 *   photo → initial AI analysis → editable result → correction loop → confirm → save
 *
 * Two properties hold throughout:
 *
 *  - **Nothing is saved until the user confirms.** The analysis produces a draft
 *    in component state; the database is only written by `save`.
 *  - **Every field is editable directly.** Chat correction is an accelerator, not
 *    a gate — a user with AI switched off, or who simply prefers typing, can fill
 *    the whole form by hand.
 */
export function MealDetailPage() {
  const { mealId } = useParams<{ mealId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useI18n();
  const { settings, profile } = useApp();

  const [meal, setMeal] = useState<Meal | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [imageBytes, setImageBytes] = useState(0);
  const [note, setNote] = useState('');
  const [correction, setCorrection] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [chatLog, setChatLog] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [visionNotice, setVisionNotice] = useState<string | null>(null);

  const ai = useMemo(() => aiService(settings), [settings]);
  const capability = useMemo(
    () => ai.visionCapability(settings),
    [ai, settings],
  );

  const isNew = mealId === undefined;

  const load = useCallback(async () => {
    try {
      if (!mealId) {
        setMeal(createEmptyMeal());
        return;
      }
      const found = await repositories().meals.get(mealId);
      if (found) {
        setMeal(found);
        if (found.imageKey) {
          const stored = await repositories().meals.loadImage(found.imageKey);
          setImage(stored);
          setImageBytes(stored ? Math.round((stored.length * 3) / 4) : 0);
        }
        setChatLog(found.aiNote ? [{ role: 'assistant', text: found.aiNote }] : []);
      }
    } catch (error) {
      // See ExercisePage: a failed read must end the splash, not extend it forever.
      console.warn('[meal] could not load', error);
    } finally {
      setLoading(false);
    }
  }, [mealId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback((changes: Partial<Meal>) => {
    setMeal((current) => (current ? { ...current, ...changes } : current));
  }, []);

  /**
   * Keep the meal totals equal to the sum of its items.
   *
   * Called after any item edit, so the headline figure and the breakdown the user
   * is looking at can never disagree.
   */
  const patchItems = useCallback(
    (items: MealItem[]) => {
      setMeal((current) => (current ? { ...current, items, ...sumItems(items) } : current));
    },
    [],
  );

  const handlePick = useCallback(
    async (source: ImageSource) => {
      try {
        const picked = await pickImage(source);
        if (!picked) return;
        setImage(picked.dataUrl);
        setImageBytes(picked.bytes);
        setVisionNotice(null);
      } catch (error) {
        toast.show(error instanceof Error ? error.message : t('mealPhoto.readFailed'), 'error');
      }
    },
    [toast, t],
  );

  /**
   * Analyse the photo.
   *
   * The capability check happens *before* the request so a text-only model gets a
   * clear explanation rather than an opaque API error, and the manual form stays
   * usable either way.
   */
  const analyse = useCallback(async () => {
    if (!meal || !image || busy) return;

    if (!ai.isEnabled()) {
      setVisionNotice(t('mealPhoto.enableAiFirst'));
      toast.show(t('mealPhoto.aiOff'), 'error');
      return;
    }

    setBusy(true);
    setVisionNotice(null);
    try {
      const result = await ai.analyseMeal(image, profile, settings);
      const merged: Meal = {
        ...meal,
        name: result.meal.name || meal.name,
        portion: result.meal.portion || meal.portion,
        items: result.meal.items.length > 0 ? result.meal.items : meal.items,
        calories: result.meal.calories,
        proteinG: result.meal.proteinG,
        carbsG: result.meal.carbsG,
        fatG: result.meal.fatG,
        source: 'ai',
        confidence: result.meal.confidence,
        aiNote: result.note,
      };
      setMeal(merged);
      setNote(result.note);
      if (result.note) setChatLog([{ role: 'assistant', text: result.note }]);
      if (result.meal.items.length === 0) toast.show(t('mealAnalysis.noItems'));
    } catch (error) {
      // Three distinct outcomes, each with its own message: the model is known to
      // be text-only, the endpoint refused the image, or something else failed.
      if (error instanceof VisionNotSupportedError) {
        setVisionNotice(t('mealPhoto.needsVisionBody', { model: settings.aiModel }));
      } else if (error instanceof VisionRejectedError) {
        setVisionNotice(t('mealPhoto.needsVisionBody', { model: settings.aiModel }));
      } else {
        toast.show(error instanceof Error ? error.message : t('ai.requestFailed'), 'error');
      }
    } finally {
      setBusy(false);
    }
  }, [ai, busy, image, meal, profile, settings, toast, t]);

  /** Apply a free-text correction through the model, keeping manual edits. */
  const sendCorrection = useCallback(async () => {
    const text = correction.trim();
    if (!meal || text === '' || busy) return;
    setBusy(true);
    setChatLog((current) => [...current, { role: 'user', text }]);
    setCorrection('');
    try {
      const result = await ai.reviseMeal(meal, text, profile, settings);
      setMeal(result.meal);
      setChatLog((current) => [
        ...current,
        { role: 'assistant', text: result.note || t('mealAnalysis.revised') },
      ]);
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('mealAnalysis.revisionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }, [ai, busy, correction, meal, profile, settings, toast, t]);

  const save = useCallback(async () => {
    if (!meal) return;
    setBusy(true);
    try {
      let imageKey = meal.imageKey;
      // A new photo replaces the stored one under the same key, so a re-analysis
      // never leaves an orphaned image behind.
      if (image) {
        imageKey = await repositories().meals.saveImage(meal.id, image);
      } else if (meal.imageKey) {
        await repositories().meals.removeImage(meal.imageKey);
        imageKey = null;
      }

      const saved = await repositories().meals.save({
        ...meal,
        name: meal.name.trim(),
        imageKey,
        notes: meal.notes.trim(),
        updatedAt: nowIso(),
      });
      void saved;
      toast.show(t('meals.saved'), 'success');
      navigate('/meals', { replace: true });
    } catch (error) {
      toast.show(error instanceof Error ? error.message : t('errors.generic'), 'error');
    } finally {
      setBusy(false);
    }
  }, [image, meal, navigate, toast, t]);

  if (loading || !meal) {
    return (
      <div className="splash">
        <div className="small">{t('common.loading')}</div>
      </div>
    );
  }

  const visionBlocked = capability.support === 'unsupported';

  return (
    <>
      <PageHeader
        title={isNew ? t('mealEditor.newTitle') : t('mealEditor.editTitle')}
        subtitle={meal.source === 'manual' ? t('meals.sourceManual') : undefined}
        action={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
            {t('common.back')}
          </button>
        }
      />
      <main className="app-main">
        <div className="page">
          {/* ---------------------------------------------------- photo + AI */}
          <div className="card">
            <div className="row-between">
              <div style={{ fontWeight: 600 }}>{t('meals.photo')}</div>
              <MealSourceBadge meal={meal} />
            </div>

            {image ? (
              <img className="meal-photo" style={{ marginTop: 'var(--space-3)' }} src={image} alt={t('meals.photo')} />
            ) : null}

            <div className="photo-actions" style={{ marginTop: 'var(--space-3)' }}>
              <button type="button" className="btn" onClick={() => void handlePick('camera')}>
                📷 {t('mealPhoto.takePhoto')}
              </button>
              <button type="button" className="btn" onClick={() => void handlePick('gallery')}>
                🖼️ {t('mealPhoto.choosePhoto')}
              </button>
            </div>

            {image ? (
              <>
                <div className="row-between small faint" style={{ marginTop: 'var(--space-2)' }}>
                  <span>
                    {formatBytes(imageBytes)} · {t('meals.photo')}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setImage(null);
                      setImageBytes(0);
                    }}
                  >
                    {t('mealPhoto.removePhoto')}
                  </button>
                </div>

                <div className="page-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-block"
                    disabled={busy}
                    onClick={() => void analyse()}
                  >
                    {busy
                      ? t('mealPhoto.analysing')
                      : meal.source === 'manual'
                        ? t('mealPhoto.analyse')
                        : t('mealPhoto.reanalyse')}
                  </button>
                </div>

                {visionBlocked || !ai.isEnabled() ? (
                  <div className="banner warn" style={{ marginTop: 'var(--space-2)' }}>
                    <div>
                      <strong>
                        {ai.isEnabled() ? t('mealPhoto.needsVision') : t('mealPhoto.aiOff')}
                      </strong>
                      <div style={{ marginTop: 4 }}>
                        {ai.isEnabled()
                          ? t('mealPhoto.needsVisionBody', { model: settings.aiModel })
                          : t('mealPhoto.enableAiFirst')}
                      </div>
                      <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => navigate('/settings')}
                        >
                          {t('mealPhoto.openSettings')}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {visionNotice ? (
                  <div className="banner warn" style={{ marginTop: 'var(--space-2)' }}>
                    {visionNotice}
                  </div>
                ) : null}

                <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                  {t('mealPhoto.disclaimer')}
                </p>
              </>
            ) : (
              <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                {t('mealPhoto.cameraUnavailable')}
              </p>
            )}
          </div>

          {/* ------------------------------------------------ editable result */}
          <div className="card">
            <div className="row-between">
              <div style={{ fontWeight: 600 }}>{t('mealEditor.totals')}</div>
              {meal.confidence ? (
                <span className="badge neutral">
                  {t('common.estimate')} · {meal.confidence}
                </span>
              ) : null}
            </div>
            <div className="macro-grid" style={{ marginTop: 'var(--space-3)' }}>
              <Macro label={t('common.calories')} value={formatNumber(meal.calories, 0)} unit="kcal" />
              <Macro label={t('common.protein')} value={formatNumber(meal.proteinG, 0)} unit="g" />
              <Macro label={t('common.carbs')} value={formatNumber(meal.carbsG, 0)} unit="g" />
              <Macro label={t('common.fat')} value={formatNumber(meal.fatG, 0)} unit="g" />
            </div>
            {meal.source !== 'manual' ? (
              <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                {t('mealEditor.estimated')}
              </p>
            ) : null}
            <p className="small muted" style={{ margin: 'var(--space-1) 0 0' }}>
              {t('mealEditor.editingHint')}
            </p>
          </div>

          <div className="card">
            <div className="form-grid">
              <Field label={t('mealEditor.name')} htmlFor="meal-name">
                <input
                  id="meal-name"
                  className="input"
                  placeholder={t('mealEditor.namePlaceholder')}
                  value={meal.name}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </Field>
              <Field label={t('mealEditor.portion')} htmlFor="meal-portion">
                <input
                  id="meal-portion"
                  className="input"
                  placeholder={t('mealEditor.portionPlaceholder')}
                  value={meal.portion}
                  onChange={(event) => patch({ portion: event.target.value })}
                />
              </Field>
              <Field label={t('meals.loggedAt')} htmlFor="meal-time">
                <input
                  id="meal-time"
                  className="input"
                  type="datetime-local"
                  value={toDateTimeLocalValue(meal.eatenAt)}
                  onChange={(event) =>
                    patch({ eatenAt: fromDateTimeLocalValue(event.target.value) })
                  }
                />
              </Field>
            </div>

            <div className="form-grid" style={{ marginTop: 'var(--space-3)' }}>
              <Field label={t('mealEditor.calories')} htmlFor="meal-kcal">
                <NumberField
                  id="meal-kcal"
                  value={meal.calories}
                  decimals={0}
                  className="input"
                  ariaLabel={t('mealEditor.calories')}
                  onChange={(value) => patch({ calories: value })}
                />
              </Field>
              <Field label={t('mealEditor.protein')} htmlFor="meal-protein">
                <NumberField
                  id="meal-protein"
                  value={meal.proteinG}
                  decimals={1}
                  className="input"
                  ariaLabel={t('mealEditor.protein')}
                  onChange={(value) => patch({ proteinG: value })}
                />
              </Field>
              <Field label={t('mealEditor.carbs')} htmlFor="meal-carbs">
                <NumberField
                  id="meal-carbs"
                  value={meal.carbsG}
                  decimals={1}
                  className="input"
                  ariaLabel={t('mealEditor.carbs')}
                  onChange={(value) => patch({ carbsG: value })}
                />
              </Field>
              <Field label={t('mealEditor.fat')} htmlFor="meal-fat">
                <NumberField
                  id="meal-fat"
                  value={meal.fatG}
                  decimals={1}
                  className="input"
                  ariaLabel={t('mealEditor.fat')}
                  onChange={(value) => patch({ fatG: value })}
                />
              </Field>
            </div>

            <Field label={t('common.notes')} htmlFor="meal-notes">
              <textarea
                id="meal-notes"
                className="textarea"
                style={{ marginTop: 'var(--space-2)' }}
                placeholder={t('mealEditor.notesPlaceholder')}
                value={meal.notes}
                onChange={(event) => patch({ notes: event.target.value })}
              />
            </Field>
          </div>

          {/* ------------------------------------------------------- items */}
          <div className="card">
            <div className="row-between">
              <div style={{ fontWeight: 600 }}>{t('mealEditor.itemsTitle')}</div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => patchItems([...meal.items, createEmptyMealItem()])}
              >
                + {t('mealEditor.addItem')}
              </button>
            </div>

            {meal.items.length === 0 ? (
              <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                {t('meals.emptyHint')}
              </p>
            ) : (
              <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
                {meal.items.map((item, index) => (
                  <div key={item.id} className="card" style={{ background: 'var(--surface-secondary)' }}>
                    <div className="row-between">
                      <span className="small faint">#{index + 1}</span>
                      <button
                        type="button"
                        className="btn-icon"
                        aria-label={t('mealEditor.removeItem')}
                        onClick={() => patchItems(meal.items.filter((entry) => entry.id !== item.id))}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="form-grid">
                      <Field label={t('mealEditor.itemName')} htmlFor={`item-name-${item.id}`}>
                        <input
                          id={`item-name-${item.id}`}
                          className="input"
                          value={item.name}
                          onChange={(event) =>
                            patchItems(
                              meal.items.map((entry) =>
                                entry.id === item.id ? { ...entry, name: event.target.value } : entry,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label={t('mealEditor.itemPortion')} htmlFor={`item-portion-${item.id}`}>
                        <input
                          id={`item-portion-${item.id}`}
                          className="input"
                          value={item.portion}
                          onChange={(event) =>
                            patchItems(
                              meal.items.map((entry) =>
                                entry.id === item.id ? { ...entry, portion: event.target.value } : entry,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label={t('mealEditor.calories')} htmlFor={`item-kcal-${item.id}`}>
                        <NumberField
                          value={item.calories}
                          decimals={0}
                          className="input"
                          id={`item-kcal-${item.id}`}
                          ariaLabel={`${item.name} ${t('mealEditor.calories')}`}
                          onChange={(value) =>
                            patchItems(
                              meal.items.map((entry) =>
                                entry.id === item.id ? { ...entry, calories: value } : entry,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label={t('mealEditor.protein')} htmlFor={`item-protein-${item.id}`}>
                        <NumberField
                          value={item.proteinG}
                          decimals={1}
                          className="input"
                          id={`item-protein-${item.id}`}
                          ariaLabel={`${item.name} ${t('mealEditor.protein')}`}
                          onChange={(value) =>
                            patchItems(
                              meal.items.map((entry) =>
                                entry.id === item.id ? { ...entry, proteinG: value } : entry,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label={t('mealEditor.carbs')} htmlFor={`item-carbs-${item.id}`}>
                        <NumberField
                          value={item.carbsG}
                          decimals={1}
                          className="input"
                          id={`item-carbs-${item.id}`}
                          ariaLabel={`${item.name} ${t('mealEditor.carbs')}`}
                          onChange={(value) =>
                            patchItems(
                              meal.items.map((entry) =>
                                entry.id === item.id ? { ...entry, carbsG: value } : entry,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label={t('mealEditor.fat')} htmlFor={`item-fat-${item.id}`}>
                        <NumberField
                          value={item.fatG}
                          decimals={1}
                          className="input"
                          id={`item-fat-${item.id}`}
                          ariaLabel={`${item.name} ${t('mealEditor.fat')}`}
                          onChange={(value) =>
                            patchItems(
                              meal.items.map((entry) =>
                                entry.id === item.id ? { ...entry, fatG: value } : entry,
                              ),
                            )
                          }
                        />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ------------------------------------------------ correction loop */}
          {meal.source !== 'manual' ? (
            <div className="card">
              <div className="row-between">
                <div>
                  <div style={{ fontWeight: 600 }}>{t('mealAnalysis.chatTitle')}</div>
                  <div className="small muted">{t('mealAnalysis.chatHint')}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!ai.isEnabled()}
                  onClick={() => setShowChat(true)}
                >
                  {t('common.open')}
                </button>
              </div>
              <div className="row-wrap" style={{ marginTop: 'var(--space-2)' }}>
                {CORRECTION_EXAMPLE_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className="flag-toggle"
                    disabled={!ai.isEnabled()}
                    onClick={() => {
                      setCorrection(t(key));
                      setShowChat(true);
                    }}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
              {note ? (
                <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                  {t('common.estimate')}: {note}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="page-actions">
            <button
              type="button"
              className="btn btn-primary btn-block btn-hero"
              disabled={busy || meal.name.trim() === ''}
              onClick={() => void save()}
            >
              {busy ? t('common.loading') : t('mealAnalysis.confirm')}
            </button>
          </div>
          <div className="page-actions">
            <button type="button" className="btn btn-block" onClick={() => setConfirmDiscard(true)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </main>

      {showChat ? (
        <Sheet
          title={t('mealAnalysis.chatTitle')}
          onClose={() => setShowChat(false)}
          footer={
            <>
              <textarea
                className="textarea"
                style={{ minHeight: '2.75rem', flex: 1 }}
                placeholder={t('mealAnalysis.chatPlaceholder')}
                value={correction}
                onChange={(event) => setCorrection(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendCorrection();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || correction.trim() === ''}
                onClick={() => void sendCorrection()}
              >
                {busy ? '…' : t('mealAnalysis.chatSend')}
              </button>
            </>
          }
        >
          <div className="chat-thread">
            {chatLog.length === 0 ? (
              <p className="small faint">{t('mealAnalysis.intro')}</p>
            ) : (
              chatLog.map((entry, index) => (
                <div key={index} className={`chat-bubble ${entry.role}`}>
                  {entry.text}
                </div>
              ))
            )}
            {busy ? <div className="chat-bubble assistant">{t('mealAnalysis.applying')}</div> : null}
          </div>
        </Sheet>
      ) : null}

      {confirmDiscard ? (
        <ConfirmDialog
          title={t('common.cancel')}
          message={t('mealAnalysis.discard')}
          confirmLabel={t('common.cancel')}
          cancelLabel={t('common.back')}
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            navigate('/meals');
          }}
        />
      ) : null}
    </>
  );
}

/** The examples the spec calls out, offered as one-tap corrections. */
const CORRECTION_EXAMPLE_KEYS = [
  'mealAnalysis.correctionExample1',
  'mealAnalysis.correctionExample2',
  'mealAnalysis.correctionExample3',
  'mealAnalysis.correctionExample4',
  'mealAnalysis.correctionExample5',
] as const;
