import { useEffect, useRef, useState } from 'react';
import { formatNumber, parseNumberInput } from '../domain/units';

interface NumberFieldProps {
  value: number | null;
  onChange: (value: number | null) => void;
  /** Decimal places allowed while typing; also drives inputMode. */
  decimals?: number;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  /**
   * Set when the field is wrapped in a `Field`, so its `<label for>` actually
   * points at this input rather than at nothing.
   */
  id?: string;
  /** Focus and select the content on mount — used for the newly added set. */
  autoFocus?: boolean;
}

/**
 * Numeric cell for the workout grid.
 *
 * Keeps the raw string while the user types so that "6." or "0.5" never get
 * mangled mid-edit, and commits a parsed number on change.
 */
export function NumberField({
  value,
  onChange,
  decimals = 2,
  placeholder,
  ariaLabel,
  className,
  id,
  autoFocus,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(() => (value === null ? '' : formatNumber(value, decimals)));
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused) setDraft(value === null ? '' : formatNumber(value, decimals));
  }, [value, decimals, focused]);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

  return (
    <input
      ref={inputRef}
      id={id}
      className={className ?? 'input-cell'}
      type="text"
      inputMode={decimals === 0 ? 'numeric' : 'decimal'}
      enterKeyHint="next"
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setDraft(value === null ? '' : formatNumber(value, decimals));
      }}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const parsed = parseNumberInput(raw);
        if (raw.trim() === '') {
          onChange(null);
          return;
        }
        if (parsed !== null) {
          onChange(decimals === 0 ? Math.round(parsed) : parsed);
        }
      }}
    />
  );
}
