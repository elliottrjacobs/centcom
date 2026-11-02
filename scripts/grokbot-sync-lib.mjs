/**
 * Pure logic behind scripts/sync-grokbots.mjs: Grok bot profile.json → CENTCOM agent profile.
 * Plain Node ESM with no imports at all, so it runs on the bot machine without node_modules.
 */

export const SOURCE = 'grokbot-sync';
const SHORT_DESCRIPTION = 400;
const LEAD_MAX = 300;
const SKILL_DESCRIPTION_MAX = 200;
const MIN_SKILL_NAME = 3;
/** A mention in a sentence like this is a prohibition, not a skill the bot uses. */
const FORBIDS = /\bnever\b|\bdon['’]t\b|\bdo not\b|\banti-jobs?\b|\bavoid/i;

/** `Chief of Staff - BiteMark` → `grokbot-chief-of-staff-bitemark`. Capped at CENTCOM's 64-character id limit. */
export function grokbotId(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `grokbot-${slug}`.slice(0, 64).replace(/-+$/, '');
}

/** Sentences of one line of prose. Does not split after `e.g.`, `i.e.`, `etc.` or inside `extendedmind.studio`. */
export function sentences(text) {
  const out = [];
  const end = /[.!?]+["”’)\]]*(?=\s|$)/g;
  let start = 0;
  let m;
  while ((m = end.exec(text))) {
    const stop = m.index + m[0].length;
    if (/(?:^|[^\p{L}])(?:e\.g|i\.e|etc|vs)\.$/iu.test(text.slice(start, stop))) continue;
    const sentence = text.slice(start, stop).trim();
    if (sentence) out.push(sentence);
    start = stop;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** The opening sentences of `paragraph`, as many as fit in `max` characters; a too-long first one is cut at a word. */
function lead(paragraph, max) {
  const flat = paragraph.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let out = '';
  for (const sentence of sentences(flat)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A bot's `description` is often its whole system prompt. Short and single-paragraph: it is the
 * description. Otherwise the description is its opening sentence(s) and the instructions are the
 * full text, verbatim. Empty: fall back to the bot's `title`.
 */
export function splitDescription(text, title) {
  const full = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!full) return { description: String(title ?? '').trim(), instructions: '' };
  const paragraphs = full.split(/\n[ \t]*\n/);
  if (full.length <= SHORT_DESCRIPTION && paragraphs.length === 1) return { description: full, instructions: '' };
  return { description: lead(paragraphs[0], LEAD_MAX), instructions: full };
}

/* ───────────────────────── SKILL.md frontmatter (the few YAML shapes skills use) ───────────────────────── */

function unquote(value) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.replace(/^"|"$/g, '');
    }
  }
  if (value.startsWith("'")) return value.replace(/^'|'$/g, '').replace(/''/g, "'");
  return value;
}

/** `{ name, description }` from a SKILL.md, or null without frontmatter. Handles plain, quoted and `>` / `|` block values. */
export function parseSkillFile(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const fields = {};
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw.trim();
    // Continuation lines: indented (or blank) lines that follow the key.
    const more = [];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || (lines[i + 1].trim() === '' && /^[ \t]+\S/.test(lines[i + 2] ?? '')))) more.push(lines[(i += 1)].trim());
    if (/^[>|][+-]?$/.test(value)) {
      fields[key] = value.startsWith('|')
        ? more.join('\n').trim()
        : more
            .join('\n')
            .split(/\n{2,}/)
            .map((p) => p.replace(/\n/g, ' ').trim())
            .join('\n')
            .trim();
    } else {
      fields[key] = unquote([value, ...more].join(' ').trim());
    }
  }
  return { name: String(fields.name ?? '').trim(), description: String(fields.description ?? '').trim() };
}

/* ───────────────────────── Skills ───────────────────────── */

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shorten(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const NUMBERED_COPY = /-\d+$/;

/**
 * The shared library holds copies like `centcom-tracker` and `centcom-tracker-2`. Each skill once:
 * folders that share a frontmatter name, or `<folder>-<digit>` next to `<folder>`, collapse into
 * the folder without the numeric suffix (else the shortest). Sorted by folder.
 */
export function dedupeSkills(library) {
  const preferred = [...library].sort(
    (a, b) => Number(NUMBERED_COPY.test(a.folder)) - Number(NUMBERED_COPY.test(b.folder)) || a.folder.length - b.folder.length || a.folder.localeCompare(b.folder),
  );
  const folders = new Set(library.map((s) => s.folder));
  const names = new Set();
  const kept = [];
  for (const skill of preferred) {
    const name = String(skill.name ?? '').trim().toLowerCase();
    const base = skill.folder.replace(NUMBERED_COPY, '');
    if ((name && names.has(name)) || (base !== skill.folder && folders.has(base))) continue;
    if (name) names.add(name);
    kept.push(skill);
  }
  return kept.sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * Library skills (`{ folder, name, description }`) that `text` names: a whole-word, case-sensitive
 * mention of the folder name or frontmatter name (3+ characters), in at least one sentence that does
 * not forbid it ("never", "don't", "do not", "anti-job", "avoid"). Case matters because skill names
 * are lowercase slugs: "Research what people say" is prose, "use research" names the skill.
 * Named by folder, sorted.
 */
export function matchSkills(text, library) {
  const chunks = String(text ?? '')
    .split(/\r?\n/)
    .flatMap((line) => sentences(line))
    .filter((s) => !FORBIDS.test(s));
  const found = new Map();
  for (const skill of library) {
    const terms = [...new Set([skill.folder, skill.name].filter(Boolean).map((t) => t.trim()))].filter((t) => t.length >= MIN_SKILL_NAME);
    const patterns = terms.map((t) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(t)}(?![\\p{L}\\p{N}_-])`, 'u'));
    if (patterns.some((p) => chunks.some((c) => p.test(c)))) found.set(skill.folder, { name: skill.folder, description: shorten(skill.description ?? '', SKILL_DESCRIPTION_MAX) });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ───────────────────────── Profiles ───────────────────────── */

/** What gets PUT to `/api/agents/<id>/profile` for one bot's profile.json. */
export function buildProfile(bot, library) {
  const name = String(bot.name ?? '').trim();
  const { description, instructions } = splitDescription(bot.description, bot.title);
  return { id: grokbotId(name), name, description, instructions, skills: matchSkills(`${bot.title ?? ''}\n${bot.description ?? ''}`, library), source: SOURCE };
}

/** True when the profile CENTCOM already has is exactly what we would send. */
export function sameProfile(remote, wanted) {
  if (!remote) return false;
  const skills = (list) => JSON.stringify((list ?? []).map((s) => [s.name, s.description]));
  return remote.name === wanted.name && remote.source === wanted.source && remote.description === wanted.description && remote.instructions === wanted.instructions && skills(remote.skills) === skills(wanted.skills);
}
