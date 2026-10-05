/** One active page request. Late completions can neither update UI nor save history. */
export class RequestSession {
  private active: AbortController | null = null;

  get isActive(): boolean {
    return this.active !== null;
  }

  begin(): AbortController | null {
    if (this.active) return null;
    this.active = new AbortController();
    return this.active;
  }

  isCurrent(request: AbortController): boolean {
    return this.active === request && !request.signal.aborted;
  }

  finish(request: AbortController): boolean {
    if (this.active !== request) return false;
    this.active = null;
    return true;
  }

  cancel(): void {
    const request = this.active;
    this.active = null;
    request?.abort();
  }
}

/** IME confirmation must not be interpreted as sending a message. */
export function shouldSendOnEnter(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
