import { Component, ErrorInfo, ReactNode } from 'react';
import { CrashReport } from '../pages/errorPage';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack?: string;
}

/**
 * Last-resort error boundary above the router (main.tsx). Route-level crashes are caught first by
 * the router's errorElement (pages/errorPage.tsx); this one catches renders that fail outside any
 * route, so a crash anywhere still gets the stack-trace page + Firebase crash report (via
 * CrashReport's own effect) instead of a white screen.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(_error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (this.state.error) return <CrashReport error={this.state.error} componentStack={this.state.componentStack} />;
    return this.props.children;
  }
}
