import { useEffect, useState } from 'react';
import { tildify, useStore } from '../lib/store';
import { Modal } from '../ui/overlays';
import { Snippet } from '../views/SystemViews';

type Welcome = { vault: string; token: string | null; docs: string | null };

/**
 * First launch of the desktop app only: where the vault is, the owner token (shown this once),
 * and how to reach CENTCOM from other devices without assuming any one provider.
 */
export function Onboarding() {
  const info = useStore((s) => s.info);
  const [welcome, setWelcome] = useState<Welcome | null>(null);
  const [login, setLogin] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [openAtLogin, setOpenAtLogin] = useState(true);

  useEffect(() => {
    window.centcom?.onboarding?.().then((r) => r.show && setWelcome(r), () => undefined);
    window.centcom?.loginItem?.().then(setLogin, () => undefined);
  }, []);
  if (!welcome) return null;

  const finish = async () => {
    if (login?.supported && openAtLogin !== login.enabled) await window.centcom?.loginItem?.(openAtLogin).catch(() => undefined);
    await window.centcom?.finishOnboarding?.().catch(() => undefined);
    setWelcome(null);
  };

  return (
    <Modal onClose={() => void finish()} width={560}>
      <form className="dialog" onSubmit={(e) => { e.preventDefault(); void finish(); }}>
        <h2 className="dialog-title">Welcome to CENTCOM</h2>
        <p className="dialog-body">
          Your workspace is a folder of plain Markdown at <code className="mono selectable">{tildify(info, welcome.vault)}</code>. Open it in Finder or any editor; changes made there show up here.
        </p>
        {welcome.token && (
          <>
            <Snippet label="Owner token" code={welcome.token} />
            <p className="dialog-body">
              CENTCOM shows this token only now. It is also stored in <code className="mono">~/.centcom/config.json</code> on this Mac. It can do anything, so keep it here: give your phone and each agent its own token in Settings → Tokens.
            </p>
          </>
        )}
        <p className="dialog-body">
          CENTCOM listens only on this Mac. To use it from your phone or another computer, put it behind HTTPS you control, such as Tailscale Serve, Cloudflare Tunnel or your own reverse proxy.
          {welcome.docs && <> The <a href={`${welcome.docs.replace(/\/+$/, '')}/blob/main/docs/REMOTE-ACCESS.md`} target="_blank" rel="noreferrer">remote access guide</a> walks through each.</>}
        </p>
        {login?.supported && (
          <label className="check-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={openAtLogin} onChange={(e) => setOpenAtLogin(e.target.checked)} />
            Open CENTCOM at login, so your agents and phone can reach it whenever this Mac is on
          </label>
        )}
        <div className="dialog-actions">
          <button type="submit" className="btn btn-primary" autoFocus>Get started</button>
        </div>
      </form>
    </Modal>
  );
}
