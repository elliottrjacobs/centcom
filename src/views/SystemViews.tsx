import { Select } from '../ui/Select';
import { pages } from '../shell/PageMenu';
import { PAGE_IDS, openingPage } from '../lib/navigation';
import { usePersisted } from '../lib/usePersisted';
import { useCallback, useEffect, useState } from 'react';
import { api, type TrashItem } from '../lib/api';
import { disconnectSession, sessionStatus, type SessionStatus } from '../lib/auth';
import { copyText } from '../lib/clipboard';
import { fullDate, pluralize, relTime, stripExt } from '../lib/format';
import { href } from '../lib/router';
import { refreshAll, tildify, useStore } from '../lib/store';
import { ViewHeader } from '../shell/ViewHeader';
import { Check, Clipboard, Document, Folder, Key, Link as LinkIcon, Refresh, Settings as SettingsIcon, Trash as TrashIcon } from '../ui/icons';
import { TOKEN_SCOPES, type CreatedToken, type TokenInfo, type TokenScope } from '@shared/types';
import { confirm, toast, toastError } from '../ui/overlays';

/* ───────── Trash ───────── */

export function TrashView() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const treeTick = useStore((s) => s.tree?.mtime);

  const load = useCallback(() => {
    api.trash().then(setItems).catch(toastError);
  }, []);
  useEffect(load, [load, treeTick]);

  const restore = async (item: TrashItem) => {
    try {
      const { path } = await api.restore(item.id);
      await refreshAll();
      load();
      toast(`Restored to ${path}`);
    } catch (err) {
      toastError(err);
    }
  };

  const purge = async (item?: TrashItem) => {
    const ok = await confirm({
      title: item ? `Delete “${stripExt(item.name)}” forever?` : 'Empty Trash?',
      body: item ? 'This cannot be undone.' : `${pluralize(items?.length ?? 0, 'item')} will be permanently deleted. This cannot be undone.`,
      confirmLabel: item ? 'Delete forever' : 'Empty Trash',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.purge(item?.id);
      load();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <>
      <ViewHeader crumbs={[{ label: 'Trash', icon: <TrashIcon size={15} /> }]}>
        {items && items.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => void purge()}>
            Empty Trash
          </button>
        )}
      </ViewHeader>
      <div className="view-body">
        {items && items.length === 0 ? (
          <div className="empty">
            <TrashIcon size={28} className="empty-icon" />
            <div className="empty-title">Trash is empty</div>
            <p className="empty-body">Deleted tasks and projects wait here until you restore them or empty the Trash.</p>
          </div>
        ) : (
          <div className="file-list">
            {items?.map((item) => (
              <div key={item.id} className="file-row" data-static>
                <span className="file-icon">{item.isDir ? <Folder size={16} /> : <Document size={16} />}</span>
                <span className="file-name truncate">{item.isDir ? item.name : stripExt(item.name)}</span>
                <span className="file-meta truncate mono">{item.originalPath}</span>
                <time className="file-date" title={fullDate(item.deletedAt)}>
                  {relTime(item.deletedAt)}
                </time>
                <button className="btn btn-sm" onClick={() => void restore(item)}>
                  <Refresh size={13} /> Restore
                </button>
                <button className="icon-btn" title="Delete forever" onClick={() => void purge(item)}>
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ───────── Settings ───────── */

export function Snippet({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      {label && <div className="snippet-label">{label}</div>}
      <pre className="mono selectable">{code}</pre>
      <button
        className="icon-btn snippet-copy"
        title="Copy"
        onClick={() =>
          void copyText(code).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          }).catch(toastError)
        }
      >
        {copied ? <Check size={14} /> : <Clipboard size={14} />}
      </button>
    </div>
  );
}

/* ───────── Tokens ───────── */

const SCOPE_HELP: Record<TokenScope, string> = {
  read: 'Read',
  write: 'Write tickets and docs',
  'write:instructions': 'Edit any agent’s instructions',
};

/** Owner only. Each device and agent gets its own token, so one can be revoked without touching the rest. */
function TokensSection() {
  const projects = useStore((s) => s.projects);
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [label, setLabel] = useState('');
  const [agent, setAgent] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>(['read', 'write']);
  const [limitTo, setLimitTo] = useState<string[]>([]);
  const [instructionsFor, setInstructionsFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const load = useCallback(() => {
    // Not the owner (a scoped token's session): the server says no, and the section stays hidden.
    api.tokens().then(setTokens).catch(() => setTokens(null));
  }, []);
  useEffect(load, [load]);
  if (!tokens) return null;

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const create = async () => {
    setBusy(true);
    try {
      const patterns = scopes.includes('write:instructions') ? instructionsFor.split(',').map((p) => p.trim()).filter(Boolean) : [];
      const result = await api.createToken({ label, agent, scopes, ...(limitTo.length > 0 ? { projects: limitTo } : {}), ...(patterns.length > 0 ? { instructionAgents: patterns } : {}) });
      setCreated(result);
      setLabel('');
      setAgent('');
      setLimitTo([]);
      setInstructionsFor('');
      load();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (token: TokenInfo) => {
    const ok = await confirm({
      title: `Revoke “${token.label}”?`,
      body: `Anything using it stops working immediately, including browsers signed in with it. Writes already made as ${token.agent ?? 'this token'} stay attributed.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      const { sessionsEnded } = await api.revokeToken(token.id);
      toast(sessionsEnded > 0 ? `Token revoked. Signed out ${pluralize(sessionsEnded, 'browser')}.` : 'Token revoked.');
      load();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <section className="page-section">
      <h2 className="section-title">Tokens</h2>
      <p className="lede">
        Give each device and agent its own token. Everything written with a token is recorded as its agent, and revoking one leaves the others working. The owner token in config.json can act as anyone; keep it on this computer.
      </p>
      <div className="file-list" style={{ paddingBottom: 0 }}>
        {tokens.map((t) => (
          <div key={t.id} className="file-row" data-static>
            <span className="file-icon"><Key size={16} /></span>
            <span className="file-name truncate">{t.label}</span>
            <span className="file-meta truncate">
              {t.agent ?? 'any agent'} · {t.scopes.join(', ')}{t.instructionAgents ? ` (${t.instructionAgents.join(', ')})` : ''}{t.projects ? ` · ${t.projects.join(', ')}` : ''}
            </span>
            <span className="file-date" title={t.lastUsed ? fullDate(t.lastUsed) : 'Not used yet'}>{t.lastUsed ? relTime(t.lastUsed) : '—'}</span>
            {t.owner ? <span className="icon-btn" aria-hidden /> : (
              <button className="icon-btn" title={`Revoke ${t.label}`} aria-label={`Revoke ${t.label}`} onClick={() => void revoke(t)}>
                <TrashIcon size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {created ? (
        <div style={{ marginTop: 16 }}>
          <Snippet label={`${created.info.label} · ${created.info.agent ?? ''}`} code={created.token} />
          <p className="quiet" style={{ marginTop: 8 }}>Copy this token now and store it as a secret on that device. It cannot be shown again.</p>
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setCreated(null)}>Done</button>
        </div>
      ) : (
        <form style={{ display: 'grid', gap: 12, marginTop: 16, maxWidth: 420 }} onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label htmlFor="token-label">New token for</label>
          <input id="token-label" className="input" placeholder="iPhone, Laptop agents…" value={label} maxLength={100} required onChange={(e) => setLabel(e.target.value)} />
          <label htmlFor="token-agent">Agent id</label>
          <input id="token-agent" className="input mono" placeholder="claude-code, research-bot…" value={agent} maxLength={64} required spellCheck={false} onChange={(e) => setAgent(e.target.value)} />
          <span id="token-scopes">Access</span>
          <div className="chip-row" role="group" aria-labelledby="token-scopes">
            {TOKEN_SCOPES.map((scope) => (
              <button key={scope} type="button" className="chip" aria-pressed={scopes.includes(scope)} onClick={() => setScopes(toggle(scopes, scope))}>{SCOPE_HELP[scope]}</button>
            ))}
          </div>
          {scopes.includes('write:instructions') && (
            <>
              <label htmlFor="token-instructions-for">Whose instructions</label>
              <input id="token-instructions-for" className="input mono" placeholder="Everyone, or e.g. grokbot-*" value={instructionsFor} maxLength={300} spellCheck={false} onChange={(e) => setInstructionsFor(e.target.value)} />
              <p className="quiet">Agent ids, comma-separated; end one with * to match a prefix. Leave empty to allow every agent, which only an agent that manages others should have.</p>
            </>
          )}
          {projects.length > 0 && (
            <span id="token-projects">Projects</span>
          )}
          {projects.length > 0 && (
            <div className="chip-row" role="group" aria-labelledby="token-projects">
              {projects.map((p) => (
                <button key={p.slug} type="button" className="chip" aria-pressed={limitTo.includes(p.slug)} onClick={() => setLimitTo(toggle(limitTo, p.slug))}>{p.name}</button>
              ))}
            </div>
          )}
          <p className="quiet">{limitTo.length > 0 ? `Limited to ${limitTo.length === 1 ? 'one project' : `${limitTo.length} projects`}.` : 'Every project. Select projects above to limit it.'}</p>
          <div><button className="btn btn-primary" type="submit" disabled={busy || scopes.length === 0}>{busy ? 'Creating…' : 'Create token'}</button></div>
        </form>
      )}
    </section>
  );
}

export function SettingsView() {
  const [startPage,setStartPage]=usePersisted('navigation.startPage','tickets');
  const [deviceName, setDeviceName] = usePersisted('deviceName', '');
  const [manualToken, setManualToken] = useState<string | null>(null);
  const [copyingToken, setCopyingToken] = useState(false);
  const info = useStore((s) => s.info);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [loginItem, setLoginItem] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  useEffect(() => {
    window.centcom?.loginItem?.().then(setLoginItem, () => setLoginItem(null));
  }, []);
  const toggleLoginItem = async (enabled: boolean) => {
    try {
      setLoginItem((await window.centcom?.loginItem?.(enabled)) ?? null);
    } catch (err) {
      toastError(err);
    }
  };
  const [disconnecting, setDisconnecting] = useState(false);
  useEffect(() => {
    if (!window.centcom?.isElectron) sessionStatus().then(setSession).catch(() => setSession(null));
  }, []);
  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await disconnectSession();
      window.location.reload();
    } catch (err) {
      setDisconnecting(false);
      toastError(err);
    }
  };
  const copyServerToken = async () => {
    setCopyingToken(true);
    try {
      if (window.centcom?.copyServerToken) {
        await window.centcom.copyServerToken();
        toast('Server token copied');
        return;
      }
      const { token } = await api.connection();
      try {
        await copyText(token);
        setManualToken(null);
        toast('Server token copied');
      } catch {
        setManualToken(token);
        toast('Select the server token below and copy it manually.');
      }
    } catch (err) {
      toastError(err);
    } finally {
      setCopyingToken(false);
    }
  };
  const base = window.location.origin;

  return (
    <>
      <ViewHeader crumbs={[{ label: 'Settings', icon: <SettingsIcon size={15} /> }]} />
      <div className="view-body">
        <div className="page">
          <section className="page-section">
            <h2 className="section-title">On startup</h2>
            <p className="lede">Choose the page to open when you launch CENTCOM on this device. Links to specific pages still open directly.</p>
            <Select aria-label="Default page" value={openingPage(startPage)} onChange={setStartPage}>{PAGE_IDS.map(id=><option key={id} value={id}>{pages[id].label}</option>)}</Select>
          </section>
          <section className="page-section">
            <h2 className="section-title">This device</h2>
            <p className="lede">Name this device to include its location with your ticket updates. Your identity stays separate from the device.</p>
            <label htmlFor="device-name">Device name</label>
            <input id="device-name" className="input" placeholder="Mac mini, MacBook…" value={deviceName} maxLength={100}
              onChange={e => setDeviceName(e.target.value.replace(/[\x00-\x1f\x7f]/g, ''))} style={{display:'block', marginTop:8, maxWidth:320, width:'100%'}}/>
            <p className="quiet" style={{marginTop:8}}>Saved for this app or browser. Leave blank to omit device attribution.</p>
          </section>

          {session?.via === 'cookie' && (
            <section className="page-section">
              <h2 className="section-title">This browser</h2>
              <p className="lede">
                Connected with a server token. The token itself is not stored here; the browser keeps a session that ends after 7 days without use, and after 30 days at most.
              </p>
              {session.session && <p className="quiet">Connected {relTime(session.session.created)} · expires {fullDate(session.session.expires)}</p>}
              <button className="btn" style={{ marginTop: 12 }} disabled={disconnecting} onClick={() => void disconnect()}>
                {disconnecting ? 'Disconnecting…' : 'Disconnect this browser'}
              </button>
            </section>
          )}

          <section className="page-section">
            <h2 className="section-title">Vault</h2>
            <p className="lede">
              Your projects and tasks are stored here. The desktop and iOS apps connect to the same server, so updates stay in sync.
            </p>
            <div className="kv">
              <div><span>Location</span><code className="mono selectable">{info?.vault ?? '—'}</code></div>
              <div><span>Server</span><code className="mono selectable">{base}</code></div>
              <div>
                <span>Access</span>
                <span>{info?.remote ? 'Reachable from other devices. A bearer token is required off this machine.' : 'This machine only (127.0.0.1).'}</span>
              </div>
              <div><span>Version</span><span className="tnum">{info?.version ?? '—'}</span></div>
            </div>
            {window.centcom && !info?.remote && (
              <button className="btn" style={{ marginTop: 16 }} onClick={() => window.centcom?.openVault()}>
                <Folder size={14} /> Open vault in Finder
              </button>
            )}
          </section>

          {loginItem?.supported && (
            <section className="page-section">
              <h2 className="section-title">Mac app</h2>
              <p className="lede">The server runs inside this app, even with every window closed. Opening it at login keeps CENTCOM available to your agents and phone whenever this Mac is on.</p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={loginItem.enabled} onChange={(e) => void toggleLoginItem(e.target.checked)} />
                Open CENTCOM at login
              </label>
            </section>
          )}

          <section className="page-section">
            <h2 className="section-title">iPhone companion</h2>
            <p className="lede">In the iPhone app’s Connection screen, enter this server’s HTTPS address and a server token. The phone has to be able to reach this computer: the remote access guide in the CENTCOM docs covers the options. The server stays on this computer, so it must be running and awake.</p>
            <Snippet label="Server address" code={base} />
            <button className="btn" style={{ marginTop: 16 }} disabled={copyingToken} onClick={() => void copyServerToken()}><Clipboard size={14} /> {copyingToken ? 'Copying…' : 'Copy server token'}</button>
            {manualToken !== null && (
              <div style={{ marginTop: 12 }}>
                <label htmlFor="manual-server-token">Server token — select and copy</label>
                <input id="manual-server-token" className="input mono selectable" readOnly value={manualToken} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%', marginTop: 8 }} />
                <button className="btn btn-ghost btn-sm" onClick={() => setManualToken(null)}>Hide token</button>
              </div>
            )}
            <p className="quiet" style={{ marginTop: 8 }}>Store the token as a secret when connecting agents. Do not include it in messages or shared documents.</p>
          </section>

          <TokensSection />

          <section className="page-section">
            <h2 className="section-title">Connect your agents</h2>
            <p className="lede">
              Point every tool at the same server and provide its token privately. For the examples below, set CENTCOM_TOKEN in the client’s environment or secret settings. Each agent uses its own stable id for attribution and reports the device separately—for example, agent codex on a laptop, or research-bot on a build server.
            </p>

            <h3 className="sub-title">Claude Code</h3>
            <Snippet code={`claude mcp add --transport http centcom ${base}/mcp --header "Authorization: Bearer $CENTCOM_TOKEN"`} />

            <h3 className="sub-title">Codex</h3>
            <Snippet label="~/.codex/config.toml" code={`[mcp_servers.centcom]\nurl = "${base}/mcp"\nbearer_token_env_var = "CENTCOM_TOKEN"`} />

            <h3 className="sub-title">Cursor and other MCP clients</h3>
            <Snippet label="mcp.json" code={`{\n  "mcpServers": {\n    "centcom": { "url": "${base}/mcp", "headers": { "Authorization": "Bearer <your-server-token>" } }\n  }\n}`} />

            <h3 className="sub-title">Anything with a shell</h3>
            <Snippet
              code={`export CENTCOM_URL=${base}\nexport CENTCOM_AGENT=grok\n# Supply CENTCOM_TOKEN privately in this environment.\ncentcom ticket create --title "Audit onboarding copy" --project CENTCOM --priority 2\ncentcom ticket start CEN-12\ncentcom ticket comment CEN-12 "Found three inconsistencies, fixing now."\ncentcom ticket done CEN-12`}
            />

            <h3 className="sub-title">Anything that can make an HTTP request</h3>
            <Snippet
              code={`curl -s ${base}/api/tickets \\\n  -H 'Content-Type: application/json' \\\n  -H \"Authorization: Bearer $CENTCOM_TOKEN\" \\\n  -d '{"title":"Summarize weekly research","createdBy":"chatgpt","agent":"chatgpt","device":"MacBook"}'`}
            />

            <h3 className="sub-title">Tell the agent what CENTCOM is</h3>
            <p className="lede">
              Add one line to a tool’s global instructions (CLAUDE.md, AGENTS.md, custom instructions) so it knows to check in:
            </p>
            <Snippet
              code={`CENTCOM tracks projects and tasks. Before starting work, find or create a ticket, claim it with your agent id, and keep its status and comments current. Include device with ticket actions (for example, "Mac mini") separately from your stable agent or bot id. Use the same REST, CLI, or MCP backend as the desktop and iOS apps.`}
            />
          </section>
        </div>
      </div>
    </>
  );
}
