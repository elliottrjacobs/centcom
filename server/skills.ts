import { loadSkillSources, verifiedSkillSource } from './skill-provenance.ts';
import { skillLibrary } from '../shared/skills.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseMarkdown } from './markdown.ts';
import { z } from 'zod';
import type { CatalogSkill, SkillCatalog, SkillDocument, SkillReport, SkillSources } from '../shared/skills.ts';
import type { Ctx } from './context.ts';
import { atomicWrite } from './fsutil.ts';
import { invalid, notFound } from './errors.ts';

const text = z.string().trim().min(1).max(300);
export const skillReportSchema = z.object({
  deviceId: text, deviceName: text, reporter: text,
  entries: z.array(z.object({
    name: text, description: z.string().max(10000), agent: text,
    scope: z.enum(['global', 'project']), project: text.nullable(),
    path: z.string().min(1).max(4000), sourceUrl: z.string().max(2000).nullable(),
    markdown: z.string().max(500000),
  }).refine(e => e.scope === 'project' ? !!e.project : e.project === null, 'Project scope requires a project; global scope must have null project.')).max(5000),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function githubSource(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/^git@github.com:/i, 'https://github.com/').replace(/^ssh:\/\/git@github.com\//i, 'https://github.com/');
  try {
    const url = new URL(clean);
    if (url.hostname.toLowerCase() !== 'github.com' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
    return `https://github.com/${owner.toLowerCase()}/${repo.replace(/\.git$/i, '').toLowerCase()}`;
  } catch { return null; }
}
interface Snapshot extends SkillReport { reportedAt: number }
const folder = (ctx: Ctx) => path.join(ctx.configDir, 'skill-inventories');
const sourcesOf = (ctx: Ctx) => loadSkillSources(ctx.configDir, (m) => ctx.log.warn(m));
async function snapshots(ctx: Ctx, sources: SkillSources): Promise<Snapshot[]> {
  let files: string[];
  try { files = await fs.readdir(folder(ctx)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  return Promise.all(files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(async f => normalizeSnapshot(JSON.parse(await fs.readFile(path.join(folder(ctx), f), 'utf8')) as Snapshot, sources)));
}
function normalizeSnapshot(report:Snapshot, sources: SkillSources):Snapshot {
  return {...report,entries:report.entries.map(e=>({...e,sourceUrl:e.sourceUrl ?? verifiedSkillSource(e.markdown, sources)}))};
}
export async function reportSkills(ctx: Ctx, input: SkillReport) {
  const parsed = skillReportSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues.map(i => i.message).join('; '));
  const report = parsed.data;
  const sources = await sourcesOf(ctx);
  const keys = new Set<string>();
  for (const entry of report.entries) {
    const key = JSON.stringify([entry.agent, entry.scope, entry.project, entry.path]);
    if (keys.has(key)) throw invalid('Duplicate installation path in report.');
    keys.add(key);
    if (entry.sourceUrl && !githubSource(entry.sourceUrl)) throw invalid('sourceUrl must identify a GitHub repository, or be null.');
    entry.sourceUrl = githubSource(entry.sourceUrl) ?? verifiedSkillSource(entry.markdown, sources);
    // Parse only YAML fences; other languages remain plain text, never executable metadata.
    parseMarkdown(entry.markdown);
  }
  const id = hash(JSON.stringify([report.deviceId, report.reporter]));
  return ctx.locks.run(`skill-report:${id}`, async () => {
    const snapshot = { ...report, reportedAt: Date.now() };
    await atomicWrite(path.join(folder(ctx), `${id}.json`), JSON.stringify(snapshot));
    return { ok: true, installations: report.entries.length, reportedAt: snapshot.reportedAt };
  });
}
function installationId(report: Snapshot, entry: SkillReport['entries'][number]) {
  return hash(JSON.stringify([report.deviceId, report.reporter, entry.agent, entry.scope, entry.project, entry.path]));
}
export async function skillCatalog(ctx: Ctx): Promise<SkillCatalog> {
  const sources = await sourcesOf(ctx);
  const reports = await snapshots(ctx, sources);
  const skills = new Map<string, CatalogSkill>();
  const devices = new Map<string, SkillCatalog['devices'][number]>();
  // Unknown copies join a known origin only with identical content and a single candidate.
  const origins = new Map<string, Set<string>>();
  for (const r of reports) for (const e of r.entries) if (e.sourceUrl) {
    const key = JSON.stringify([e.name.toLowerCase(),hash(e.markdown)]);
    origins.set(key, new Set([...(origins.get(key) ?? []), e.sourceUrl]));
  }
  for (const r of reports) {
    if ((devices.get(r.deviceId)?.reportedAt ?? 0) < r.reportedAt) devices.set(r.deviceId, { id: r.deviceId, name: r.deviceName, reportedAt: r.reportedAt });
    for (const e of r.entries) {
      const contentHash = hash(e.markdown);
      const candidates = origins.get(JSON.stringify([e.name.toLowerCase(),contentHash]));
      const source = e.sourceUrl ?? (candidates?.size === 1 ? [...candidates][0]! : null);
      const id = hash(JSON.stringify([source ?? 'unknown', e.name.toLowerCase()]));
      let skill = skills.get(id);
      if (!skill) { skill = { id, name: e.name, description: e.description, sourceUrl: source, versions: 0, installations: [] }; skills.set(id, skill); }
      skill.installations.push({ id: installationId(r, e), agent: e.agent, scope: e.scope, project: e.project, path: e.path,
        sourceUrl: e.sourceUrl, deviceId: r.deviceId, deviceName: r.deviceName, reporter: r.reporter, reportedAt: r.reportedAt, hash: contentHash });
    }
  }
  for (const s of skills.values()) { s.library = skillLibrary(s, sources); s.versions = new Set(s.installations.map(i => i.hash)).size; s.installations.sort((a,b) => b.reportedAt - a.reportedAt); }
  return { skills: [...skills.values()].sort((a,b) => a.name.localeCompare(b.name)), devices: [...devices.values()].sort((a,b) => a.name.localeCompare(b.name)) };
}
export async function skillDocument(ctx: Ctx, id: string): Promise<SkillDocument> {
  for (const r of await snapshots(ctx, await sourcesOf(ctx))) for (const e of r.entries) if (installationId(r,e) === id) {
    const doc = parseMarkdown(e.markdown);
    return { markdown: e.markdown, body: doc.body, frontmatter: doc.frontmatter };
  }
  throw notFound('This installation is no longer in the device inventory. Refresh the Skills page.');
}
