import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiFailure } from './lib/api';
import { connectSession, UNAUTHORIZED_EVENT } from './lib/auth';
import { boot, disconnectEvents } from './lib/store';

export function ConnectionGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [token, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      await api.info();
      await boot();
      setReady(true);
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) {
        setNeedsToken(true);
        setError('Enter a server token to connect this browser.');
      } else setError('Unable to connect. Check your connection and try again.');
    } finally { setBusy(false); }
  };
  useEffect(() => { void connect(); }, []);
  // A session that expires or is ended elsewhere brings the Connect screen back.
  useEffect(() => {
    const lost = () => {
      if (window.centcom?.isElectron) return;
      disconnectEvents();
      setReady(false);
      setNeedsToken(true);
      setError('This browser was disconnected. Enter a server token to connect again.');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, lost);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, lost);
  }, []);
  if (ready) return children;
  return <div className="boot"><form className="empty" style={{ maxWidth: 380, gap: 16 }} onSubmit={(e) => {
    e.preventDefault();
    if (!needsToken) { void connect(); return; }
    setBusy(true);
    setError('');
    // The token goes to the server once and is forgotten; the browser keeps only an HttpOnly cookie.
    connectSession(token).then(() => { setInput(''); return connect(); }, (err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Unable to connect.');
    });
  }}>
    <div className="empty-title">Connect to CENTCOM</div>
    <p className="empty-body">Your shared projects and tasks.</p>
    {needsToken && <label style={{ display: 'grid', gap: 8, width: '100%', textAlign: 'left' }}>
      Server token<input type="password" autoComplete="current-password" autoFocus required value={token}
        onChange={(e) => setInput(e.target.value)} aria-label="Server token" />
    </label>}
    {error && <p role="status" className="empty-body">{error}</p>}
    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
  </form></div>;
}
