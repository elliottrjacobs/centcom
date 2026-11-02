import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseMarkdown } from '../server/markdown.ts';
import type { SkillReport, SkillReportEntry } from '../shared/skills.ts';
import { githubSource } from '../server/skills.ts';
const exec = promisify(execFile);
export interface SkillRoot { path: string; agent: string; project: string | null }
async function json(file: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
}
async function dirs(dir: string): Promise<string[]> {
  try { return (await fs.readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name); }
  catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
export async function defaultSkillRoots(home = os.homedir(), projects?: string[]): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [];
  const add = (base: string, project: string | null) => {
    for (const [folder, agent] of [['.agents/skills','Shared'],['.codex/skills','Codex'],['.claude/skills','Claude Code'],['.cursor/skills','Cursor'],['.gemini/skills','Gemini']])
      roots.push({path:path.join(base,folder!),agent:agent!,project});
  };
  add(home, null);
  for (const projectDir of projects ?? (await dirs(path.join(home,'Projects'))).map(p => path.join(home,'Projects',p))) add(projectDir, path.resolve(projectDir));
  // Claude records actual installed plugin versions and their scope. Never inventory its whole cache.
  const installed = await json(path.join(home,'.claude/plugins/installed_plugins.json'));
  for (const entries of Object.values(installed.plugins ?? {}) as any[][]) for (const e of entries) {
    if (typeof e.installPath === 'string') roots.push({path:path.join(e.installPath,'skills'),agent:'Claude Code',project:e.scope === 'user' ? null : e.projectPath ?? null});
  }
  // Codex's config identifies enabled plugins; cached old versions are excluded.
  let config = '';
  try { config = await fs.readFile(path.join(home,'.codex/config.toml'),'utf8'); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for (const match of config.matchAll(/^\[plugins\."([^"\n]+)@([^"\n]+)"\]\s*\n([^[]*)/gm)) {
    if (!/^enabled\s*=\s*true\s*$/m.test(match[3]!)) continue;
    for (const market of [match[2]!,`${match[2]}-remote`]) {
      const base = path.join(home,'.codex/plugins/cache',market,match[1]!);
      const versions = await dirs(base);
      const latest = versions.sort((a,b) => b.localeCompare(a,undefined,{numeric:true}))[0];
      if (latest) { roots.push({path:path.join(base,latest,'skills'),agent:'Codex',project:null}); break; }
    }
  }
  return roots;
}
export async function scanSkills(roots: SkillRoot[]): Promise<SkillReportEntry[]> {
  const entries: SkillReportEntry[] = [];
  const gitCache = new Map<string, Promise<string | null>>();
  const remote = (dir: string) => {
    if (!gitCache.has(dir)) gitCache.set(dir, exec('git',['-C',dir,'config','--get','remote.origin.url'],{timeout:3000}).then(r => githubSource(r.stdout.trim())).catch(() => null));
    return gitCache.get(dir)!;
  };
  const sharedLock = await json(path.join(os.homedir(),'.agents/.skill-lock.json'));
  for (const root of roots) {
    const visited = new Set<string>();
    const lock = await json(path.join(root.project ?? path.dirname(root.path),'skills-lock.json'));
    const localLock = await json(path.join(path.dirname(root.path),'.skill-lock.json'));
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 8) throw new Error(`Skill folder nesting exceeds 8 levels: ${dir}`);
      let real: string;
      try { real = await fs.realpath(dir); } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      if (visited.has(real)) return;
      visited.add(real);
      const file = path.join(dir,'SKILL.md');
      let markdown: string | null = null;
      try {
        const stat = await fs.stat(file);
        if (stat.size > 500000) throw new Error(`SKILL.md exceeds 500 KB: ${file}`);
        markdown = await fs.readFile(file,'utf8');
      } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (markdown !== null) {
        const parsed = parseMarkdown(markdown);
        const name = String(parsed.frontmatter.name ?? path.basename(dir));
        const record = localLock.skills?.[name] ?? lock.skills?.[name] ?? (real.startsWith(path.join(os.homedir(),'.agents/skills') + path.sep) ? sharedLock.skills?.[name] : undefined);
        const sourceUrl = githubSource(record?.sourceUrl ?? (record?.sourceType === 'github' ? `https://github.com/${record.source}` : null)) ??
          githubSource((parsed.frontmatter.metadata as Record<string, string> | undefined)?.repository ?? parsed.frontmatter.repository as string | undefined) ?? await remote(real);
        entries.push({name,description:String(parsed.frontmatter.description ?? ''),agent:root.agent,scope:root.project ? 'project' : 'global',
          project:root.project,path:file,sourceUrl,markdown});
        return;
      }
      for (const name of await dirs(dir)) if (!['.git','node_modules','references','scripts','assets'].includes(name)) await walk(path.join(dir,name),depth+1);
    }
    await walk(path.resolve(root.path),0);
  }
  return [...new Map(entries.map(e => [JSON.stringify([e.agent,e.project,e.path]),e])).values()];
}
export async function localSkillReport(options: {deviceId?: string; deviceName?: string; reporter: string; roots?: SkillRoot[]; projects?: string[]}): Promise<SkillReport> {
  return {deviceId:options.deviceId ?? os.hostname(),deviceName:options.deviceName ?? os.hostname(),reporter:options.reporter,
    entries:await scanSkills(options.roots ?? await defaultSkillRoots(os.homedir(),options.projects))};
}
