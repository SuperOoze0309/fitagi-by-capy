import type { ReactNode } from 'react';
import { ThemeScenery } from './ThemeScenery';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  id?: string;
}

export function Switch({ checked, onChange, label, id }: SwitchProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      data-on={checked}
      onClick={() => onChange(!checked)}
    />
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-active={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  htmlFor?: string;
}

export function Field({ label, children, hint, htmlFor }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="small faint">{hint}</span> : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="app-header">
      <h1>
        {title}
        {subtitle ? <span className="subtitle">{subtitle}</span> : null}
      </h1>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  scenery = true,
}: {
  title: string;
  hint?: string;
  /** Off for empty states that are already busy, e.g. inside a sheet. */
  scenery?: boolean;
}) {
  return (
    <div className="empty">
      {scenery ? <ThemeScenery variant="strip" /> : null}
      <strong>{title}</strong>
      {hint ? <span className="small">{hint}</span> : null}
    </div>
  );
}
