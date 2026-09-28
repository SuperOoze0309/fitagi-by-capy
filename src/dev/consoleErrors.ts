/**
 * Console-error capture for the browser smoke test.
 *
 * Installed before the app renders when the page is opened with `?smoke=1`. React
 * reports invalid DOM nesting and other mistakes through `console.error` without
 * throwing, so a smoke run that only asserts on rendering can pass while the app
 * emits broken markup. Recording them here lets the run fail loudly instead.
 *
 * Not imported by the normal boot path.
 */
export const CONSOLE_ERRORS_KEY = '__smokeConsoleErrors';

/** Errors React and the app produce, excluding the dev-only React DevTools notice. */
const IGNORED = [/Download the React DevTools/i, /\[vite\]/i];

/**
 * Console calls that use printf-style formatting (`console.error('%o', obj)`) would
 * otherwise record the placeholder instead of the message, which is noise rather
 * than a diagnostic. React logs its caught render errors that way, and the smoke
 * test deliberately triggers one.
 */
const FORMAT_PLACEHOLDER = /^%[a-zA-Z]$|^%[a-zA-Z]\s/;

export function installConsoleErrorCapture(): void {
  const target = window as unknown as Record<string, unknown>;
  if (Array.isArray(target[CONSOLE_ERRORS_KEY])) return;

  const errors: string[] = [];
  target[CONSOLE_ERRORS_KEY] = errors;

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const text = args
      .map((arg) => {
        if (arg instanceof Error) return arg.message;
        const asString = String(arg);
        return FORMAT_PLACEHOLDER.test(asString.trim()) ? '' : asString;
      })
      .filter((part) => part !== '')
      .join(' ');
    if (text.trim() !== '' && !IGNORED.some((pattern) => pattern.test(text))) errors.push(text);
    original(...args);
  };

  window.addEventListener('error', (event) => {
    errors.push(`uncaught: ${event.message}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(`unhandled rejection: ${String(event.reason)}`);
  });
}
