import * as React from "react";

interface Props {
  /** Which part of the page this is, for the console. */
  readonly area: string;
  readonly fallback: React.ReactNode;
  readonly children: React.ReactNode;
}

/**
 * Keeps what goes wrong drawing one part of a page in that part. Without it React takes everything off the page, the
 * text being read included, for an error in a menu or a panel.
 */
export class ErrorBoundary extends React.Component<Props, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(`${this.props.area} could not be shown`, error, info.componentStack);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
