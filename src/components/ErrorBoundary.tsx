import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translate, type MessageKey, type MessageParams } from '../i18n';
import { getActiveLocale } from '../i18n/runtime';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time crashes so a bad record cannot leave a blank screen.
 *
 * The fallback is deliberately plain DOM: no router, no context, no storage. The
 * crash that produced it may have come from any of those.
 *
 * A class component cannot use `useI18n()`, so it translates through
 * `getActiveLocale()` — the locale the provider mirrored, readable synchronously.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry by design: the console is the only place this goes.
    console.error('Unhandled render error', error, info.componentStack);
  }

  private reload = (): void => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  private goToData = (): void => {
    if (typeof window !== 'undefined') {
      window.location.hash = '#/data';
      window.location.reload();
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const t = (key: MessageKey, params?: MessageParams) =>
      translate(getActiveLocale(), key, params);
    const hash = typeof window === 'undefined' ? '#/' : window.location.hash || '#/';

    return (
      <div className="crash-screen" role="alert">
        <h1 className="crash-title">{t('errors.somethingWrong')}</h1>
        <p className="crash-subtitle">{t('errors.renderFailed')}</p>
        <p className="muted">{t('errors.renderFailedBody')}</p>

        <h2 className="section-title">{t('errors.whatToDo')}</h2>
        <ol className="crash-steps">
          <li>{t('errors.step1')}</li>
          <li>{t('errors.step2')}</li>
          <li>{t('errors.step3', { hash })}</li>
        </ol>

        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={this.reload}>
            {t('common.reload')}
          </button>
          <button type="button" className="btn" onClick={this.goToData}>
            {t('errors.goToData')}
          </button>
        </div>

        {/*
          Open by default: the exact message is the first thing anyone reporting the
          problem needs, and a collapsed panel hides it from rendered text — which is
          what a screen reader and a copy-paste both read.
        */}
        <details className="crash-detail" open>
          <summary>{t('errors.technicalDetail')}</summary>
          <pre>
            {error.name}: {error.message}
          </pre>
        </details>

        <p className="small faint">{t('errors.dataSafe')}</p>
      </div>
    );
  }
}
