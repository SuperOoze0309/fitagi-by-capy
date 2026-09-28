import type { en } from './en';
import type { Locale } from './locales';

export type { Locale };

/**
 * The shape every locale must provide.
 *
 * Derived from the English catalogue with its literal types widened to `string`,
 * so translations are not forced to equal the English text but every key and
 * nesting level must match exactly.
 */
type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };

export type Messages = Widen<typeof en>;

/**
 * A dotted path to a translatable leaf, e.g. `home.startWorkout`.
 *
 * Only leaves are accepted: asking for `home` or `home.nope` is a type error, so a
 * typo cannot silently render a key.
 */
export type MessageKey = LeafPaths<Messages>;

type LeafPaths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafPaths<T[K]>}`;
}[keyof T & string];

/** Values substituted into `{placeholder}` slots. */
export type MessageParams = Record<string, string | number>;

/** A catalogue plus the metadata the switcher needs. */
export interface Catalogue {
  messages: Messages;
  /** BCP-47 tag used for `Intl` date and number formatting. */
  intlTag: string;
}
