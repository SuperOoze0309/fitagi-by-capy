import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Field, PageHeader, Segmented } from '../components/ui';
import { PixelArt } from '../components/PixelArt';
import { getMascot } from '../theme/tokens';
import { NumberField } from '../components/NumberField';
import { EMPTY_PROFILE } from '../repositories/settingsRepository';
import { useApp, useI18n } from '../state/AppContext';
import { useToast } from '../state/ToastContext';
import { buildProfileBlock, resolveAge, resolveMetrics } from '../services/ai/userContext';
import { formatNumber, kgToLb, lbToKg } from '../domain/units';
import type { Gender, TrainingGoal, UnitSystem, UserProfile } from '../domain/types';
import type { MessageKey } from '../i18n';

/**
 * Optional personal details.
 *
 * Two things are deliberate here:
 *
 *  - **Nothing is required.** Every field can stay empty and the app is fully
 *    usable, so this screen never gates anything.
 *  - **Gender is context, not presentation.** It appears in this form because the
 *    AI benefits from it, and it is displayed next to a note saying exactly that.
 *    It has no connection to the theme picker in Settings, which only changes
 *    colours and the mascot.
 */
export function ProfilePage() {
  const { profile, updateProfile, settings } = useApp();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<UserProfile>(profile);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  const imperial = draft.unitSystem === 'imperial';

  /** Height in centimetres is canonical; the form shows feet/inches when imperial. */
  const heightDisplay = useMemo(() => {
    if (draft.heightCm === null) return { feet: null, inches: null };
    const totalInches = draft.heightCm / 2.54;
    const feet = Math.floor(totalInches / 12);
    return { feet, inches: Math.round(totalInches - feet * 12) };
  }, [draft.heightCm]);

  const set = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await updateProfile(draft);
      toast.show(t('profile.savedToast'), 'success');
    } finally {
      setSaving(false);
    }
  }, [draft, toast, t, updateProfile]);

  const reset = useCallback(async () => {
    setDraft(EMPTY_PROFILE);
    await updateProfile(EMPTY_PROFILE);
    toast.show(t('profile.clearedToast'));
  }, [toast, t, updateProfile]);

  const previewBlock = buildProfileBlock(draft);
  const metrics = resolveMetrics(draft);
  const age = resolveAge(draft);

  return (
    <>
      <PageHeader
        title={t('profile.title')}
        subtitle={t('profile.subtitle')}
        action={
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
            {t('common.back')}
          </button>
        }
      />
      <main className="app-main">
        <div className="page">
          <div className="card">
            <div className="row">
              <PixelArt
                sprite={getMascot(settings.theme)}
                size={36}
                title={t('theme.mascotAlt', { name: t(`theme.${settings.theme}`) })}
              />
              <p className="small muted" style={{ margin: 0 }}>
                {t('profile.intro')}
              </p>
            </div>
          </div>

          <div className="card">
            <div className="form-grid">
              <Field label={t('profile.name')} htmlFor="profile-name">
                <input
                  id="profile-name"
                  className="input"
                  placeholder={t('profile.namePlaceholder')}
                  value={draft.name}
                  onChange={(event) => set('name', event.target.value)}
                />
              </Field>

              <Field label={t('profile.gender')} htmlFor="profile-gender" hint={t('profile.genderHint')}>
                <select
                  id="profile-gender"
                  className="select"
                  value={draft.gender ?? ''}
                  onChange={(event) =>
                    set('gender', event.target.value === '' ? null : (event.target.value as Gender))
                  }
                >
                  <option value="">{t('common.notSet')}</option>
                  <option value="male">{t('profile.genderMale')}</option>
                  <option value="female">{t('profile.genderFemale')}</option>
                  <option value="other">{t('profile.genderOther')}</option>
                  <option value="undisclosed">{t('profile.genderUndisclosed')}</option>
                </select>
              </Field>

              <Field label={t('profile.age')} htmlFor="profile-age">
                <NumberField
                  value={draft.age}
                  decimals={0}
                  ariaLabel={t('profile.age')}
                  className="input"
                  placeholder="—"
                  onChange={(value) => set('age', value)}
                />
              </Field>

              <Field label={t('profile.birthday')} htmlFor="profile-birthday">
                <input
                  id="profile-birthday"
                  className="input"
                  type="date"
                  value={draft.birthday ?? ''}
                  onChange={(event) => set('birthday', event.target.value === '' ? null : event.target.value)}
                />
              </Field>
            </div>
            {age !== null && draft.age === null ? (
              <p className="small faint" style={{ margin: 'var(--space-2) 0 0' }}>
                {t('profile.age')}: {t('profile.years', { count: age })}
              </p>
            ) : null}
          </div>

          <div className="card">
            <div className="form-grid">
              <Field label={t('profile.unitSystem')} htmlFor="profile-units">
                <Segmented
                  ariaLabel={t('profile.unitSystem')}
                  value={draft.unitSystem}
                  options={[
                    { value: 'metric', label: t('profile.unitMetric') },
                    { value: 'imperial', label: t('profile.unitImperial') },
                  ]}
                  onChange={(value: UnitSystem) => set('unitSystem', value)}
                />
              </Field>
            </div>

            {imperial ? (
              <div className="form-grid" style={{ marginTop: 'var(--space-3)' }}>
                <Field label={t('profile.height')} htmlFor="height-feet">
                  <div className="row">
                    <NumberField
                      value={heightDisplay.feet}
                      decimals={0}
                      ariaLabel={`${t('profile.height')} (ft)`}
                      className="input"
                      placeholder="ft"
                      onChange={(feet) => {
                        const inches = heightDisplay.inches ?? 0;
                        set('heightCm', feet === null ? null : Math.round((feet * 12 + inches) * 2.54));
                      }}
                    />
                    <NumberField
                      value={heightDisplay.inches}
                      decimals={0}
                      ariaLabel={`${t('profile.height')} (in)`}
                      className="input"
                      placeholder="in"
                      onChange={(inches) => {
                        const feet = heightDisplay.feet ?? 0;
                        set('heightCm', inches === null ? null : Math.round((feet * 12 + inches) * 2.54));
                      }}
                    />
                  </div>
                </Field>
                <Field label={t('profile.weight')} htmlFor="weight-lb">
                  <NumberField
                    value={draft.weightKg === null ? null : Math.round(kgToLb(draft.weightKg) * 10) / 10}
                    decimals={1}
                    ariaLabel={t('profile.weight')}
                    className="input"
                    placeholder="lb"
                    onChange={(lb) => set('weightKg', lb === null ? null : Math.round(lbToKg(lb) * 10) / 10)}
                  />
                </Field>
                <Field label={t('profile.goalWeight')} htmlFor="goal-lb">
                  <NumberField
                    value={
                      draft.goalWeightKg === null ? null : Math.round(kgToLb(draft.goalWeightKg) * 10) / 10
                    }
                    decimals={1}
                    ariaLabel={t('profile.goalWeight')}
                    className="input"
                    placeholder="lb"
                    onChange={(lb) =>
                      set('goalWeightKg', lb === null ? null : Math.round(lbToKg(lb) * 10) / 10)
                    }
                  />
                </Field>
              </div>
            ) : (
              <div className="form-grid" style={{ marginTop: 'var(--space-3)' }}>
                <Field label={t('profile.height')} htmlFor="height-cm">
                  <NumberField
                    value={draft.heightCm}
                    decimals={0}
                    ariaLabel={t('profile.height')}
                    className="input"
                    placeholder="cm"
                    onChange={(value) => set('heightCm', value)}
                  />
                </Field>
                <Field label={t('profile.weight')} htmlFor="weight-kg">
                  <NumberField
                    value={draft.weightKg}
                    decimals={1}
                    ariaLabel={t('profile.weight')}
                    className="input"
                    placeholder="kg"
                    onChange={(value) => set('weightKg', value)}
                  />
                </Field>
                <Field label={t('profile.goalWeight')} htmlFor="goal-kg">
                  <NumberField
                    value={draft.goalWeightKg}
                    decimals={1}
                    ariaLabel={t('profile.goalWeight')}
                    className="input"
                    placeholder="kg"
                    onChange={(value) => set('goalWeightKg', value)}
                  />
                </Field>
              </div>
            )}
          </div>

          <div className="card">
            <div className="form-grid">
              <Field label={t('profile.trainingGoal')} htmlFor="training-goal">
                <select
                  id="training-goal"
                  className="select"
                  value={draft.trainingGoal ?? ''}
                  onChange={(event) =>
                    set(
                      'trainingGoal',
                      event.target.value === '' ? null : (event.target.value as TrainingGoal),
                    )
                  }
                >
                  <option value="">{t('common.notSet')}</option>
                  {GOAL_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {t(goalKey(option))}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t('profile.activityLevel')} htmlFor="activity-level">
                <select
                  id="activity-level"
                  className="select"
                  value={draft.activityLevel ?? ''}
                  onChange={(event) =>
                    set(
                      'activityLevel',
                      event.target.value === ''
                        ? null
                        : (event.target.value as UserProfile['activityLevel']),
                    )
                  }
                >
                  <option value="">{t('common.notSet')}</option>
                  {ACTIVITY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {t(activityKey(option))}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>

          <div className="card">
            <div className="row-between">
              <div style={{ fontWeight: 600 }}>{t('profile.contextPreview')}</div>
              <span className="badge neutral">
                {metrics.weightKg > 0 ? `${formatNumber(metrics.weightKg, 1)} kg` : t('common.notSet')}
              </span>
            </div>
            <p className="small muted" style={{ margin: 'var(--space-1) 0 var(--space-2)' }}>
              {t('profile.contextPreviewHint')}
            </p>
            {previewBlock ? (
              <pre className="preview-block">{previewBlock}</pre>
            ) : (
              <p className="small faint" style={{ margin: 0 }}>
                {t('profile.contextEmpty')}
              </p>
            )}
          </div>

          <div className="page-actions">
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? t('common.loading') : t('profile.save')}
            </button>
          </div>
          <div className="page-actions">
            <button type="button" className="btn btn-block" onClick={() => void reset()}>
              {t('common.clear')}
            </button>
          </div>
        </div>
      </main>
    </>
  );
}

const GOAL_OPTIONS: TrainingGoal[] = [
  'fatLoss',
  'muscleGain',
  'strength',
  'endurance',
  'generalFitness',
  'maintain',
];

const ACTIVITY_OPTIONS: NonNullable<UserProfile['activityLevel']>[] = [
  'sedentary',
  'light',
  'moderate',
  'high',
  'athlete',
];

function goalKey(goal: TrainingGoal): MessageKey {
  const map: Record<TrainingGoal, MessageKey> = {
    fatLoss: 'profile.goalFatLoss',
    muscleGain: 'profile.goalMuscleGain',
    strength: 'profile.goalStrength',
    endurance: 'profile.goalEndurance',
    generalFitness: 'profile.goalGeneralFitness',
    maintain: 'profile.goalMaintain',
  };
  return map[goal];
}

function activityKey(level: NonNullable<UserProfile['activityLevel']>): MessageKey {
  const map: Record<NonNullable<UserProfile['activityLevel']>, MessageKey> = {
    sedentary: 'profile.activitySedentary',
    light: 'profile.activityLight',
    moderate: 'profile.activityModerate',
    high: 'profile.activityHigh',
    athlete: 'profile.activityAthlete',
  };
  return map[level];
}
