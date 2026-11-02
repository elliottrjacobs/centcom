import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SkillSources } from '../shared/skills.ts';
import { isErrno } from './errors.ts';

/**
 * Which Skill collections this installation knows by name, and which exact SKILL.md files have
 * been checked against an upstream repository. It is the owner's knowledge, so it lives in
 * `<configDir>/skill-sources.json`, never in the code:
 *
 *   {
 *     "libraries":   [{ "repository": "https://github.com/owner/skills", "id": "owner", "name": "Owner’s Skills" }],
 *     "verified":    [{ "sha256": "<hash of the exact SKILL.md>", "repository": "https://github.com/owner/skills" }],
 *     "pluginNames": { "<plugin package id>": "Display name" }
 *   }
 *
 * A name or directory prefix alone is never evidence of a repository; only a verified hash is.
 */
export const SKILL_SOURCES_FILE = 'skill-sources.json';

export const EMPTY_SKILL_SOURCES: SkillSources = { libraries: {}, verified: {}, pluginNames: {} };

const repository = z.string().trim().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/i).transform((url) => url.toLowerCase());
const fileSchema = z.object({
  libraries: z.array(z.object({ repository, id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(200) })).max(500).optional(),
  verified: z.array(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/i).transform((h) => h.toLowerCase()), repository })).max(10_000).optional(),
  pluginNames: z.record(z.string().max(200), z.string().trim().min(1).max(200)).optional(),
});

/** Missing file: nothing is known. A malformed one is reported and ignored rather than failing the Skills page. */
export async function loadSkillSources(configDir: string, warn: (msg: string) => void = () => undefined): Promise<SkillSources> {
  const file = path.join(configDir, SKILL_SOURCES_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return EMPTY_SKILL_SOURCES;
    throw err;
  }
  let parsed: z.infer<typeof fileSchema>;
  try {
    parsed = fileSchema.parse(JSON.parse(raw));
  } catch (err) {
    warn(`Ignoring ${file}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
    return EMPTY_SKILL_SOURCES;
  }
  return {
    libraries: Object.fromEntries((parsed.libraries ?? []).map((l) => [l.repository, { id: l.id, name: l.name }])),
    verified: Object.fromEntries((parsed.verified ?? []).map((v) => [v.sha256, v.repository])),
    pluginNames: parsed.pluginNames ?? {},
  };
}

export function verifiedSkillSource(markdown: string, sources: Pick<SkillSources, 'verified'>): string | null {
  return sources.verified[createHash('sha256').update(markdown).digest('hex')] ?? null;
}
