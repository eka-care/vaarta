'use client';

/**
 * Desktop sign-in approval page (device authorization flow, RFC 8628).
 *
 * The desktop app opens <server>/auth/activate?user_code=XXXX-XXXX in the
 * system browser. This page:
 *   1. requires a logged-in session (redirects to /auth/login?next=… if not),
 *   2. shows the code in an editable input (prefilled from ?user_code=,
 *      typeable otherwise),
 *   3. approves/denies ONLY on an explicit click — never on page load
 *      (auto-approve would let a malicious link silently authorize a device).
 *
 * Lives under /auth (a PUBLIC_ROUTE) so the global guard doesn't mount — this
 * page does its own whoami check because it needs the ?next= redirect, which
 * the guard's logout path doesn't preserve.
 */

import { useEffect, useState } from 'react';
import { Button } from '@ui/src';
import { VaartaLogoLottie } from '@/shared-components/vaarta-logo-lottie';
import { useAppName } from '@/config/app-branding';

type Phase = 'loading' | 'ready' | 'submitting' | 'approved' | 'denied' | 'error';

const normalizeCode = (raw: string): string => {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length === 8 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : '';
};

export default function ActivatePage() {
  const appName = useAppName();
  const [phase, setPhase] = useState<Phase>('loading');
  const [typedCode, setTypedCode] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  // Server-validated return-to-app target from the approve response (never
  // taken from this page's URL — see device_auth_routes redirect allowlist).
  const [redirectUri, setRedirectUri] = useState('');

  useEffect(() => {
    // Prefill from ?user_code= — still shown in an editable input so the
    // user can correct or replace it. Approval remains click-only.
    const fromUrl = normalizeCode(
      new URLSearchParams(window.location.search).get('user_code') || ''
    );
    if (fromUrl) setTypedCode(fromUrl);

    (async () => {
      try {
        const res = await fetch('/connect-auth/v1/account/whoami');
        if (res.status === 401 || res.status === 403) {
          const here = window.location.pathname + window.location.search;
          window.location.href = `/auth/login?next=${encodeURIComponent(here)}`;
          return;
        }
        if (!res.ok) throw new Error();
        const data = await res.json();
        setUsername(data?.username || '');
        setPhase('ready');
      } catch {
        setError('Could not reach the server. Please try again.');
        setPhase('error');
      }
    })();
  }, []);

  const submit = async (action: 'approve' | 'deny') => {
    const userCode = normalizeCode(typedCode);
    if (!userCode) {
      setError('Enter the 8-character code shown in the desktop app.');
      return;
    }
    setError('');
    setPhase('submitting');
    try {
      const res = await fetch('/connect-auth/v1/device/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: userCode, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.status === 'success') {
        if (action === 'approve' && typeof data?.redirect_uri === 'string' && data.redirect_uri) {
          setRedirectUri(data.redirect_uri);
          // brief pause so the success state is visible before leaving
          setTimeout(() => {
            window.location.href = data.redirect_uri;
          }, 800);
        }
        setPhase(action === 'approve' ? 'approved' : 'denied');
        return;
      }
      setError(
        data?.error?.message ||
          data?.message ||
          'This code is invalid or has expired — restart sign-in from the desktop app.'
      );
      setPhase('ready');
    } catch {
      setError('Could not reach the server. Please try again.');
      setPhase('ready');
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-1 items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <VaartaLogoLottie />
          <p className="text-sm text-muted-foreground">Desktop sign-in request</p>
        </div>

        {phase === 'loading' && (
          <p className="text-center text-sm text-muted-foreground">Checking your session…</p>
        )}

        {(phase === 'ready' || phase === 'submitting') && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <p className="text-center text-xs text-muted-foreground">
                Code shown in your desktop app
              </p>
              <input
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-center font-mono text-2xl font-semibold uppercase tracking-widest outline-none focus:ring-2 focus:ring-ring"
                placeholder="XXXX-XXXX"
                value={typedCode}
                onChange={(e) => setTypedCode(e.target.value)}
                maxLength={9}
                autoFocus
              />
            </div>

            <p className="text-center text-sm">
              <span className="font-medium">{appName} Desktop</span> wants to sign in
              {username ? (
                <>
                  {' '}as <span className="font-medium">{username}</span>
                </>
              ) : null}
              . Only approve if you started this from the desktop app.
            </p>

            {error && <p className="text-center text-sm text-destructive">{error}</p>}

            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                disabled={phase === 'submitting'}
                onClick={() => submit('deny')}
              >
                Deny
              </Button>
              <Button
                disabled={phase === 'submitting' || !normalizeCode(typedCode)}
                onClick={() => submit('approve')}
              >
                {phase === 'submitting' ? 'Please wait…' : 'Approve'}
              </Button>
            </div>
          </div>
        )}

        {phase === 'approved' && (
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-lg font-medium">You're all set</p>
            {redirectUri ? (
              <p className="text-sm text-muted-foreground">
                Returning you to the desktop app…{' '}
                <a href={redirectUri} className="font-medium text-primary hover:underline">
                  Open it now
                </a>{' '}
                if nothing happens.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Return to the desktop app — it will finish signing in on its own. You can
                close this tab.
              </p>
            )}
          </div>
        )}

        {phase === 'denied' && (
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-lg font-medium">Request denied</p>
            <p className="text-sm text-muted-foreground">
              The desktop app was not signed in. You can close this tab.
            </p>
          </div>
        )}

        {phase === 'error' && (
          <p className="text-center text-sm text-destructive">{error}</p>
        )}
      </div>
    </div>
  );
}
