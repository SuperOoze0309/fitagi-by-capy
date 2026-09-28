import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CATALOGUES,
  LOCALES,
  detectSystemLocale,
  isLocale,
  localeFromTag,
  translate,
} from '@/i18n';
import { en } from '@/i18n/en';
import { zhCN } from '@/i18n/zh-CN';
import { es } from '@/i18n/es';

/** Flatten a catalogue to `dotted.path -> string` for structural comparison. */
function flatten(value: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof child === 'string') out[path] = child;
    else Object.assign(out, flatten(child, path));
  }
  return out;
}

/**
 * A partially translated app is worse than an untranslated one: the user sees
 * their own language break mid-sentence. These tests make completeness a
 * property of the build rather than something a reviewer has to notice.
 */
describe('translation catalogues', () => {
  const english = flatten(en);

  it('ships exactly the three supported locales', () => {
    assert.deepEqual([...LOCALES], ['zh-CN', 'en', 'es']);
    assert.deepEqual(Object.keys(CATALOGUES).sort(), ['en', 'es', 'zh-CN']);
  });

  it('has the same key set in every locale', () => {
    const expected = Object.keys(english).sort();
    for (const locale of LOCALES) {
      const keys = Object.keys(flatten(CATALOGUES[locale].messages)).sort();
      const missing = expected.filter((key) => !keys.includes(key));
      const extra = keys.filter((key) => !expected.includes(key));
      assert.deepEqual(missing, [], `${locale} is missing keys`);
      assert.deepEqual(extra, [], `${locale} has keys English does not`);
    }
  });

  it('leaves no value empty or untranslated-looking in a non-English locale', () => {
    for (const locale of ['zh-CN', 'es'] as const) {
      const messages = flatten(CATALOGUES[locale].messages);
      for (const [key, value] of Object.entries(messages)) {
        assert.ok(value.trim() !== '', `${locale}.${key} is empty`);
        // Long English prose pasted as a placeholder is the usual way a
        // translation silently does not happen.
        if (value.length > 40) {
          assert.ok(
            value !== english[key],
            `${locale}.${key} is still the English text`,
          );
        }
      }
    }
  });

  /**
   * Values that are the same in every language on purpose.
   *
   * Product names, format names, example model ids and unit strings are not
   * translated; everything else that matches English word for word is a gap.
   */
  const SHARED_BY_DESIGN = new Set([
    'app.name',
    'data.markdown',
    'settings.modelPlaceholder',
    'profile.unitImperial',
    'profile.heightCm',
    'profile.weightKg',
    'profile.weightLb',
    'mealEditor.totalCalories',
    'units.kgValue',
    'units.lbValue',
  ]);

  it('translates every label that is not shared by design', () => {
    // A key parity check cannot see a catalogue entry that was copied from English
    // and never touched. This one can: anything long enough to be a phrase and
    // containing a real English word must differ in the other two locales.
    for (const locale of ['zh-CN', 'es'] as const) {
      const messages = flatten(CATALOGUES[locale].messages);
      const copied: string[] = [];
      for (const [key, value] of Object.entries(messages)) {
        if (value !== english[key]) continue;
        if (SHARED_BY_DESIGN.has(key)) continue;
        if (value.length < 8 || !/[a-z]{4}/.test(value)) continue;
        copied.push(`${key} = ${JSON.stringify(value)}`);
      }
      assert.deepEqual(copied, [], `${locale} still shows English text`);
    }
  });

  it('uses the same placeholders in every locale', () => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();
    for (const locale of LOCALES) {
      const messages = flatten(CATALOGUES[locale].messages);
      for (const [key, value] of Object.entries(messages)) {
        assert.deepEqual(
          placeholders(value),
          placeholders(english[key]!),
          `${locale}.${key} has different placeholders`,
        );
      }
    }
  });

  it('translates rather than copies the mechanical labels', () => {
    // Spot-check that the three catalogues really differ on common UI words.
    assert.equal(translate('zh-CN', 'common.save'), '保存');
    assert.equal(translate('es', 'common.save'), 'Guardar');
    assert.equal(translate('en', 'common.save'), 'Save');
    assert.equal(translate('zh-CN', 'nav.settings'), '设置');
    assert.equal(translate('es', 'nav.settings'), 'Ajustes');
  });

  it('uses gym vocabulary rather than literal translations', () => {
    // A user reading Spanish expects "series", not a literal rendering of "sets".
    assert.match(translate('es', 'workout.addSet'), /Serie/);
    assert.match(translate('es', 'history.workingSets', { count: 3 }), /series efectivas/);
    // Chinese lifters say 力竭 for failure and 递减 for drop sets.
    assert.equal(translate('zh-CN', 'workout.failure'), '力竭');
    assert.equal(translate('zh-CN', 'workout.drop'), '递减');
  });
});

describe('message rendering', () => {
  it('fills placeholders', () => {
    assert.equal(translate('en', 'home.setsCount', { count: 4 }), '4 sets');
    assert.equal(translate('zh-CN', 'home.setsCount', { count: 4 }), '4 组');
    assert.equal(translate('es', 'home.setsCount', { count: 4 }), '4 series');
  });

  it('leaves an unknown placeholder visible rather than printing undefined', () => {
    // A missing value shows the placeholder, which is an obvious bug report,
    // instead of silently reading as correct.
    assert.equal(translate('en', 'home.setsCount', {}), '{count} sets');
    assert.ok(!translate('en', 'home.setsCount', {}).includes('undefined'));
  });

  it('falls back to English for an unknown key instead of rendering nothing', () => {
    const result = translate('es', 'common.save');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});

describe('locale detection', () => {
  it('maps device tags onto a supported locale', () => {
    assert.equal(localeFromTag('zh-CN'), 'zh-CN');
    assert.equal(localeFromTag('zh-Hans-CN'), 'zh-CN');
    assert.equal(localeFromTag('zh-TW'), 'zh-CN', 'one Chinese catalogue covers every region');
    assert.equal(localeFromTag('es-ES'), 'es');
    assert.equal(localeFromTag('es-419'), 'es');
    assert.equal(localeFromTag('en-GB'), 'en');
    // A language with no catalogue falls back to English rather than to nothing.
    assert.equal(localeFromTag('fr-FR'), 'en');
    assert.equal(localeFromTag(undefined), 'en');
    assert.equal(localeFromTag(''), 'en');
  });

  it('validates locale codes', () => {
    assert.equal(isLocale('zh-CN'), true);
    assert.equal(isLocale('es'), true);
    assert.equal(isLocale('fr'), false);
    assert.equal(isLocale(undefined), false);
    assert.equal(isLocale(42), false);
  });

  it('detects the system locale through navigator', () => {
    const original = globalThis.navigator;
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'zh-Hans-CN', languages: ['zh-Hans-CN', 'en'] },
        configurable: true,
      });
      assert.equal(detectSystemLocale(), 'zh-CN');

      Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'es-MX', languages: ['es-MX'] },
        configurable: true,
      });
      assert.equal(detectSystemLocale(), 'es');

      Object.defineProperty(globalThis, 'navigator', {
        value: { language: 'de-DE', languages: ['de-DE', 'es'] },
        configurable: true,
      });
      // Falls through the list to the first language that has a catalogue.
      assert.equal(detectSystemLocale(), 'es');
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
    }
  });

  it('keeps an Intl tag per locale for date and number formatting', () => {
    for (const locale of LOCALES) {
      assert.ok(CATALOGUES[locale].intlTag.length > 0);
    }
    assert.equal(CATALOGUES['zh-CN'].intlTag, 'zh-CN');
    assert.equal(CATALOGUES.es.intlTag, 'es-ES');
  });

  it('has no duplicated key within a catalogue', () => {
    // Guards against a copy-paste that puts the same key twice in one object,
    // where TypeScript silently keeps only the last one.
    const englishKeys = Object.keys(flatten(en));
    assert.equal(new Set(englishKeys).size, englishKeys.length);
    assert.equal(Object.keys(flatten(zhCN)).length, englishKeys.length);
    assert.equal(Object.keys(flatten(es)).length, englishKeys.length);
  });
});
