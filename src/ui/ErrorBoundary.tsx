import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps one broken panel from unmounting the whole HUD; resets when `resetKey` changes. */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; label: string },
  { error: Error | null; key?: string }
> {
  override state: { error: Error | null; key?: string } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { error: Error | null; key?: string },
  ) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.label}]`, error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <section className="panel">
          <p className="muted">The {this.props.label} hit an error and was reset.</p>
        </section>
      );
    }
    return this.props.children;
  }
}
