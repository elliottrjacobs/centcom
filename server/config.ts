import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { META_DIR, type VaultUser } from '../shared/types.ts';
import { normalizeAgentId } from './agents.ts';
import { isErrno } from './errors.ts';

export const DEFAULT_PORT = 4747;
export const DEFAULT_HOST = '127.0.0.1';

/** Shape of `~/.centcom/config.json`. `remoteOrigin` is optional and additive. */
export interface ConfigFile {
  /** Optional HTTPS backend for local desktop and CLI clients. */
  serverUrl?: string;
  vault: string;
  port: number;
  host: string;
  token: string;
  /** Browser origin(s) allowed when the server is reached remotely, e.g. `https://mac.tailnet.ts.net`. */
  remoteOrigin?: string | string[];
  /**
   * Accept `?token=` on GET /api/raw/* and /api/events, as releases before browser sessions did.
   * Off unless set to true; it will be removed in the next release.
   */
  legacyQueryToken?: boolean;
  /**
   * Local clients must authenticate too: without it any process (or other user) on this machine
   * can use the API. Absent (off) in configs that predate it, so upgrading changes nothing; a
   * config created on first run turns it on.
   */
  requireTokenOnLoopback?: boolean;
  /** Linked folders: `{ mount, target, readonly? }[]`. Validated by `server/links.ts`; never trusted as-is. */
  links?: unknown;
  /**
   * The human who owns this vault: the agent id writes default to, and the name agents are told.
   * Derived once (see `deriveDefaultUser`) and persisted, so it never shifts under an existing vault.
   */
  user?: VaultUser;
}

export interface ResolvedConfig extends ConfigFile {
  configDir: string;
  configPath: string;
  remoteOrigins: string[];
  /** Always present once resolved: `CENTCOM_USER_ID` / `CENTCOM_USER_NAME` > config file > derived default. */
  user: VaultUser;
}

export interface ConfigOverrides {
  port?: number | undefined;
  host?: string | undefined;
  vault?: string | undefined;
  configDir?: string | undefined;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveConfigDir(override?: string): string {
  const raw = override ?? process.env.CENTCOM_CONFIG_DIR;
  const dir = raw && raw.trim() ? path.resolve(expandHome(raw.trim())) : path.join(os.homedir(), '.centcom');
  return dir;
}

/**
 * Tests must never touch the real `~/.centcom` or `~/CENTCOM`. The node test runner
 * sets NODE_TEST_CONTEXT in every test process, so refuse to fall back to the home
 * defaults there instead of trusting every test to remember the env vars.
 */
function assertNotRealHomeUnderTest(what: string, resolved: string, homeDefault: string): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  if (path.resolve(resolved) === path.resolve(homeDefault)) {
    throw new Error(`Refusing to use the real ${what} (${homeDefault}) from a test process. Set CENTCOM_VAULT and CENTCOM_CONFIG_DIR to temp dirs.`);
  }
}

function parsePort(value: unknown, source: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Invalid port from ${source}: ${String(value)}`);
  return n;
}

function normalizeOrigins(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item.trim()) continue;
    try {
      const u = new URL(item.trim());
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.origin);
    } catch {
      /* ignore malformed origins rather than refusing to boot */
    }
  }
  return out;
}

/* ───────────────────────── The vault's owner ───────────────────────── */

const FALLBACK_USER: VaultUser = { id: 'owner', name: 'Owner' };
const MAX_USER_NAME = 80;

function slugOrNull(value: unknown): string | null {
  try {
    return normalizeAgentId(value);
  } catch {
    return null;
  }
}

/** `{ id, name }` when both are usable, else null. The id is canonicalised like any other agent id. */
export function coerceUser(value: unknown): VaultUser | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = slugOrNull(raw.id);
  if (!id) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_USER_NAME) : userNameFromId(id);
  return { id, name };
}

/** `sam.smith` → `Sam`: the first alphanumeric token, capitalised. */
function userNameFromId(id: string): string {
  const token = id.split(/[^\p{L}\p{N}]+/u).find(Boolean) ?? '';
  return token ? token.charAt(0).toUpperCase() + token.slice(1) : FALLBACK_USER.name;
}

/** From the OS account: id = lowercase slug of the username, name = its first token, capitalised. */
export function userFromOsUsername(username: string | undefined | null): VaultUser {
  const id = slugOrNull(username ?? '');
  if (!id) return { ...FALLBACK_USER };
  return { id, name: userNameFromId((username ?? '').trim().toLowerCase()) };
}

function osUsername(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || process.env.USERNAME || undefined;
  }
}

/**
 * The owner for a config that does not name one yet. A vault that is already in use keeps the
 * human it has always attributed work to (the first `kind: "human"` in its `agents.json`), so
 * upgrading never splits someone's history across two ids. Otherwise: the OS username.
 */
export async function deriveDefaultUser(vault: string, username: string | undefined | null = osUsername()): Promise<VaultUser> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(vault, META_DIR, 'agents.json'), 'utf8'));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).kind === 'human') {
          const existing = coerceUser(entry);
          if (existing) return existing;
        }
      }
    }
  } catch {
    /* no vault yet, or an unreadable agents.json: fall through to the OS account */
  }
  return userFromOsUsername(username);
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Read the config file without ever creating or modifying it (used by the CLI). */
export function readConfigFileSync(configDirOverride?: string): Partial<ConfigFile> | null {
  const file = path.join(resolveConfigDir(configDirOverride), 'config.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Partial<ConfigFile>) : null;
  } catch {
    return null;
  }
}

async function writeConfigFile(configDir: string, configPath: string, data: ConfigFile): Promise<void> {
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(configDir, `.config-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await fs.rename(tmp, configPath);
    await fs.chmod(configPath, 0o600);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Read-modify-write of `config.json` (used by `centcom link add|remove`). Unknown keys are kept,
 * the file stays 0600, and the write is atomic. Throws when the file is missing or not JSON.
 */
export async function updateConfigFile(configDirOverride: string | undefined, mutate: (data: Record<string, unknown>) => void): Promise<void> {
  const configDir = resolveConfigDir(configDirOverride);
  assertNotRealHomeUnderTest('config dir', configDir, path.join(os.homedir(), '.centcom'));
  const configPath = path.join(configDir, 'config.json');
  const parsed: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Config file ${configPath} must contain a JSON object.`);
  const data = parsed as Record<string, unknown>;
  mutate(data);
  await writeConfigFile(configDir, configPath, data as unknown as ConfigFile);
}

/** The raw `links` array from `config.json` right now (the server re-reads it on reload). */
export async function readRawLinks(configPath: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).links : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load `config.json`, creating it on first run. Precedence for each value:
 * explicit option > environment > config file > default. Overrides are never persisted.
 */
export async function loadConfig(overrides: ConfigOverrides = {}): Promise<ResolvedConfig> {
  const configDir = resolveConfigDir(overrides.configDir);
  assertNotRealHomeUnderTest('config dir', configDir, path.join(os.homedir(), '.centcom'));
  const configPath = path.join(configDir, 'config.json');

  let stored: Partial<ConfigFile> = {};
  let needsWrite = false;
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Config file ${configPath} is not valid JSON. Fix it or delete it to regenerate.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Config file ${configPath} must contain a JSON object.`);
    }
    stored = parsed as Partial<ConfigFile>;
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
    needsWrite = true;
  }

  const fileData: ConfigFile = {
    ...stored,
    vault: typeof stored.vault === 'string' && stored.vault.trim() ? stored.vault : path.join(os.homedir(), 'CENTCOM'),
    port: stored.port === undefined ? DEFAULT_PORT : parsePort(stored.port, configPath),
    host: typeof stored.host === 'string' && stored.host.trim() ? stored.host.trim() : DEFAULT_HOST,
    token: typeof stored.token === 'string' && /^[0-9a-f]{64}$/i.test(stored.token) ? stored.token : '',
  };
  if (!fileData.token) {
    fileData.token = newToken();
    needsWrite = true;
  }
  // A brand-new install starts locked down; an existing one keeps whatever it had (absent = off).
  if (Object.keys(stored).length === 0 && fileData.requireTokenOnLoopback === undefined) fileData.requireTokenOnLoopback = true;

  const envVault = process.env.CENTCOM_VAULT?.trim();
  const envPort = process.env.CENTCOM_PORT?.trim();
  const envHost = process.env.CENTCOM_HOST?.trim();

  const vault = path.resolve(expandHome(overrides.vault ?? (envVault || fileData.vault)));
  assertNotRealHomeUnderTest('vault', vault, path.join(os.homedir(), 'CENTCOM'));

  // A config written before `user` existed gets one now, once, and keeps it.
  const storedUser = coerceUser(stored.user);
  if (storedUser) fileData.user = storedUser;
  else {
    fileData.user = await deriveDefaultUser(vault);
    needsWrite = true;
  }
  if (needsWrite) await writeConfigFile(configDir, configPath, fileData);

  const envUserId = slugOrNull(process.env.CENTCOM_USER_ID ?? '');
  const envUserName = process.env.CENTCOM_USER_NAME?.trim().slice(0, MAX_USER_NAME);
  const user: VaultUser = {
    id: envUserId ?? fileData.user.id,
    name: envUserName || (envUserId ? userNameFromId(envUserId) : fileData.user.name),
  };
  const port = overrides.port !== undefined ? parsePort(overrides.port, 'options') : envPort ? parsePort(envPort, 'CENTCOM_PORT') : fileData.port;
  const host = overrides.host ?? (envHost || fileData.host);

  return {
    ...fileData,
    vault,
    port,
    host,
    configDir,
    configPath,
    remoteOrigins: normalizeOrigins(fileData.remoteOrigin),
    user,
  };
}
