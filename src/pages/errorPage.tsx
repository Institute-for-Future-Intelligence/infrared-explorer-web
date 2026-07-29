import { useEffect, useMemo, useState } from 'react';
import { Link, useRouteError } from 'react-router-dom';
import { Button, Result, Typography } from 'antd';
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import { buildCrashDetails, logErrorToFirebase } from '../services/errorLog';

/**
 * Full crash screen: shows the stack trace to the user (so they can copy it into a report) and
 * uploads the same details to the `errorLogs` Firestore collection for the team to debug.
 * Rendered from two places — the router's errorElement below, and the root AppErrorBoundary
 * (components/appErrorBoundary.tsx), which has no Router context, so navigation here must use
 * plain anchors, never <Link>.
 */
export const CrashReport = ({ error, componentStack }: { error: Error; componentStack?: string }) => {
  const details = useMemo(() => buildCrashDetails(error, componentStack), [error, componentStack]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    logErrorToFirebase(error, componentStack);
  }, [error, componentStack]);

  const copyDetails = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (http, permissions) — the text is on screen to select manually.
    }
  };

  // A crash can come from stale cached state (localStorage view prefs, HTTP caches), so offer the
  // reset path from the old error screen. Firebase auth persists in IndexedDB, which this does
  // NOT touch — clearing here won't sign the user out.
  const clearCacheAndRefresh = async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
      <Typography.Title level={2}>Something went wrong</Typography.Title>
      <Typography.Paragraph type="secondary">
        The app hit an unexpected error, and a crash report was sent to the team. You can copy the details below, then
        refresh to continue.
      </Typography.Paragraph>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Button icon={<CopyOutlined />} onClick={copyDetails}>
          {copied ? 'Copied!' : 'Copy details'}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={clearCacheAndRefresh}>
          Clear cache &amp; refresh
        </Button>
        <Button type="primary" href="/">
          Back to home
        </Button>
      </div>
      <pre
        style={{
          background: '#f6f7f8',
          border: '1px solid #e3e6e8',
          borderRadius: 10,
          padding: 16,
          maxHeight: '55vh',
          overflow: 'auto',
          fontSize: 12.5,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {details}
      </pre>
    </div>
  );
};

const ErrorPage = () => {
  const error = useRouteError();

  // A real crash (render/lifecycle error caught by the router's error boundary): show the stack
  // and upload a crash report. The unmatched-`*` route renders this component directly with no
  // route error (error == null), which keeps the friendly not-found screen.
  if (error instanceof Error) return <CrashReport error={error} />;

  const routeError = error as { statusText?: string; message?: string } | undefined;
  return (
    <Result
      status="404"
      title="Page not found"
      subTitle={routeError?.statusText || routeError?.message || 'The page you are looking for does not exist.'}
      extra={
        <Link to="/">
          <Button type="primary">Back to home</Button>
        </Link>
      }
    />
  );
};

export default ErrorPage;
