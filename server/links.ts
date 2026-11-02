/**
 * Linked folders. CENTCOM is a window onto files that already have a home (a skills repo,
 * a project's `.claude/skills`), not a second copy of them. A link mounts such a folder
 * inside the vault as a real symlink, and the path resolver follows it for one reason only:
 * its target is allowlisted in the LOCAL config file. No API can add, change or remove a link.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_FOLDERS, type LinkInfo } from '../shared/types.ts';
import { expandHome } from './config.ts';
import { errorMessage, forbidden } from './errors.ts';
import { lstatOrNull } from './fsutil.ts';
import { isInside, parseClientPath, type ResolvedPath, type SafeRoot, type VaultLink } from './paths.ts';

export interface LinkEnv {
  vaultRoot: string;
  /** realpath of the vault. */
  vaultReal: string;
  configDir: string;
  home?: string;
}

export type LinkCheck = { ok: true; link: VaultLink } | { ok: false; reason: string };

async function realOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Either path contains the other (or they are the same). */
function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

/**
 * Decide whether one `{ mount, target, readonly }` entry may be honoured. Pure validation:
 * touches nothing on disk. `accepted` are the links already accepted from the same config.
 */
export async function validateLink(entry: unknown, env: LinkEnv, accepted: readonly VaultLink[] = []): Promise<LinkCheck> {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'entry is not an object' };
  const raw = entry as Record<string, unknown>;
  if (typeof raw.mount !== 'string' || typeof raw.target !== 'string') return { ok: false, reason: '"mount" and "target" must be strings' };
  if (raw.readonly !== undefined && typeof raw.readonly !== 'boolean') return { ok: false, reason: '"readonly" must be true or false' };

  /* ── mount: a normal client path under one of the root folders ── */
  let segments: string[];
  try {
    segments = parseClientPath(raw.mount);
  } catch (err) {
    return { ok: false, reason: `mount "${raw.mount}": ${errorMessage(err)}` };
  }
  if (!(ROOT_FOLDERS as readonly string[]).includes(segments[0] as string)) {
    return { ok: false, reason: `mount "${raw.mount}" must start with one of ${ROOT_FOLDERS.join(', ')}` };
  }
  if (segments.length < 2) return { ok: false, reason: `mount "${raw.mount}" must be a folder inside ${segments[0]}, not ${segments[0]} itself` };
  if (segments.some((s) => s !== s.trim())) return { ok: false, reason: `mount "${raw.mount}" has a segment with leading or trailing whitespace` };
  const mount = segments.join('/');
  for (const other of accepted) {
    if (other.mount === mount) return { ok: false, reason: `mount "${mount}" is listed twice` };
    if (mount.startsWith(`${other.mount}/`) || other.mount.startsWith(`${mount}/`)) return { ok: false, reason: `mount "${mount}" overlaps the link at "${other.mount}"` };
  }

  /* ── target: an existing directory that cannot expose the machine or loop back into the vault ── */
  const target = expandHome(raw.target.trim());
  if (!path.isAbsolute(target)) return { ok: false, reason: `target "${raw.target}" must be an absolute path` };
  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
    if (!(await fs.stat(realTarget)).isDirectory()) return { ok: false, reason: `target "${target}" is not a directory` };
  } catch {
    return { ok: false, reason: `target "${target}" does not exist` };
  }
  const home = await realOrSelf(env.home ?? os.homedir());
  const configDir = await realOrSelf(env.configDir);
  if (realTarget === path.parse(realTarget).root) return { ok: false, reason: 'target must not be the filesystem root' };
  if (isInside(realTarget, home)) return { ok: false, reason: realTarget === home ? 'target must not be your home folder itself' : 'target must not contain your home folder' };
  if (overlaps(realTarget, env.vaultReal)) return { ok: false, reason: isInside(env.vaultReal, realTarget) ? 'target must not be the vault or a folder inside it' : 'target must not contain the vault' };
  if (overlaps(realTarget, configDir)) return { ok: false, reason: 'target must not be, contain, or sit inside the CENTCOM config folder' };
  const sensitive = sensitiveTargetReason(realTarget, home);
  if (sensitive) return { ok: false, reason: sensitive };

  return { ok: true, link: { mount, target: path.resolve(target), realTarget, readonly: raw.readonly === true } };
}

/**
 * A linked folder is readable through the API, by every agent over MCP, and by any remote
 * token-holder once remote access is on. The dot-segment rule does not help here: files
 * *inside* `~/.ssh` (`id_ed25519`, `config`) have no leading dot. So secrets are refused by
 * location, and hidden folders are denied by default rather than enumerated, because there is
 * always one more credential store nobody thought to list.
 */
const SECRET_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.1password',
  '.config/gcloud', '.config/gh', '.config/op', 'Library/Keychains', 'Library/Cookies',
];
/** Agent tool folders. They hold credentials at the top level (`auth.json`), so only a subfolder may be linked. */
const AGENT_TOOL_DIRS = new Set(['.claude', '.codex', '.cursor', '.agents', '.gemini', '.opencode', '.factory', '.copilot']);
/** The one part of ~/Library that holds documents rather than application state (iCloud Drive, Obsidian vaults). */
const LIBRARY_DOCUMENTS = 'Library/Mobile Documents';

export function sensitiveTargetReason(realTarget: string, home: string): string | null {
  for (const rel of SECRET_DIRS) {
    if (overlaps(realTarget, path.join(home, rel))) return `target overlaps ~/${rel}, which holds credentials and can never be linked`;
  }
  const underHome = isInside(home, realTarget);
  const segments = (underHome ? path.relative(home, realTarget) : realTarget).split(path.sep).filter(Boolean);

  if (underHome && segments[0] === 'Library') {
    const docs = path.join(home, LIBRARY_DOCUMENTS);
    if (!isInside(docs, realTarget) || realTarget === docs) return `only folders inside ~/${LIBRARY_DOCUMENTS} can be linked from ~/Library`;
  }

  const hiddenAt = segments.findIndex((s) => s.startsWith('.'));
  if (hiddenAt === -1) return null;
  const hidden = segments[hiddenAt]!;
  if (!AGENT_TOOL_DIRS.has(hidden)) return `target is inside the hidden folder "${hidden}". Hidden folders cannot be linked, except subfolders of agent tool folders such as .claude/skills`;
  if (hiddenAt === segments.length - 1) return `link a subfolder of "${hidden}" (for example ${hidden}/skills), not the folder itself: its top level can hold credentials`;
  if (segments.slice(hiddenAt + 1).some((s) => s.startsWith('.'))) return 'target must not contain a hidden folder below the agent tool folder';
  return null;
}

export type MountState = 'ok' | 'missing' | 'wrong-target' | 'occupied';

/** What is at `<vault>/<mount>` right now? */
export async function inspectMount(vaultRoot: string, link: VaultLink): Promise<MountState> {
  const abs = path.join(vaultRoot, ...link.mount.split('/'));
  const stat = await lstatOrNull(abs);
  if (!stat) return 'missing';
  if (!stat.isSymbolicLink()) return 'occupied';
  try {
    return (await fs.realpath(abs)) === link.realTarget ? 'ok' : 'wrong-target';
  } catch {
    return 'wrong-target';
  }
}

/** Every folder from the vault root down to the mount's parent must be a real folder inside the vault. */
async function mountParentIsPlainVaultFolder(env: LinkEnv, link: VaultLink): Promise<boolean> {
  const parts = link.mount.split('/').slice(0, -1);
  let current = env.vaultRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) return true; // does not exist yet: mkdir will create plain folders
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/** Create the mount symlink (and any missing parent folders inside the vault). Never replaces anything. */
export async function createMount(env: LinkEnv, link: VaultLink): Promise<void> {
  if (!(await mountParentIsPlainVaultFolder(env, link))) throw new Error(`the folders above "${link.mount}" must be ordinary folders inside the vault`);
  const abs = path.join(env.vaultRoot, ...link.mount.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.symlink(link.target, abs, 'dir');
}

export interface LoadedLinks {
  links: VaultLink[];
  dropped: { entry: unknown; reason: string }[];
}

/**
 * Validate the config's `links`, make sure each accepted one is actually mounted, and return
 * the allowlist. Invalid entries are dropped with a reason; nothing here ever throws.
 */
export async function loadLinks(rawLinks: unknown, env: LinkEnv): Promise<LoadedLinks> {
  const out: LoadedLinks = { links: [], dropped: [] };
  if (rawLinks === undefined || rawLinks === null) return out;
  if (!Array.isArray(rawLinks)) {
    out.dropped.push({ entry: rawLinks, reason: '"links" must be an array' });
    return out;
  }
  for (const entry of rawLinks) {
    try {
      const check = await validateLink(entry, env, out.links);
      if (!check.ok) {
        out.dropped.push({ entry, reason: check.reason });
        continue;
      }
      const state = await inspectMount(env.vaultRoot, check.link);
      if (state === 'occupied') {
        out.dropped.push({ entry, reason: `"${check.link.mount}" already exists in the vault and is not a symlink; CENTCOM will not replace it` });
        continue;
      }
      if (state === 'wrong-target') {
        out.dropped.push({ entry, reason: `the symlink at "${check.link.mount}" does not point at ${check.link.target}; fix or remove it` });
        continue;
      }
      if (state === 'missing') await createMount(env, check.link);
      out.links.push(check.link);
    } catch (err) {
      out.dropped.push({ entry, reason: errorMessage(err) });
    }
  }
  return out;
}

export function toLinkInfo(link: VaultLink): LinkInfo {
  return { mount: link.mount, target: link.target, readonly: link.readonly };
}

/* ───────────────────────── Write guards ───────────────────────── */

/** 403 when the path is at or beneath a read-only link. */
export function assertWritable(resolved: ResolvedPath, verb: string): void {
  if (resolved.link?.readonly) {
    throw forbidden(`"${resolved.rel}" cannot be ${verb}: it is inside the read-only linked folder "${resolved.link.mount}".`);
  }
}

/**
 * 403 when the path is a link's mount point, or a folder that contains one. Renaming, moving
 * or deleting either would strand the config entry (or worse, act on the real folder), so
 * links are only ever managed with `centcom link …`.
 */
export function assertNotMountOrAncestor(vault: SafeRoot, resolved: ResolvedPath, verb: string): void {
  if (resolved.isMount && resolved.link) {
    throw forbidden(`"${resolved.rel}" is a linked folder (→ ${resolved.link.target}) and cannot be ${verb} here. Use "centcom link remove ${resolved.link.mount}".`);
  }
  const inside = (vault.links ?? []).find((l) => l.mount.startsWith(`${resolved.rel}/`));
  if (inside) throw forbidden(`"${resolved.rel}" contains the linked folder "${inside.mount}" and cannot be ${verb}. Remove the link first with "centcom link remove ${inside.mount}".`);
}
