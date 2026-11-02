import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Ctx } from './context.ts';
import { actingAgent, recordActivitySafe, syncAndBroadcast } from './context.ts';
import { atomicWrite, pathExists } from './fsutil.ts';
import { resolveVaultPath } from './paths.ts';
import { assertWritable } from './links.ts';
import { invalid, notFound, conflict } from './errors.ts';
import { coerceLabels } from './model.ts';
import { requireProject } from './projects.ts';
import { updateTicket } from './tickets.ts';
import type { ProjectLabel } from '../shared/types.ts';
export const LABEL_LOCK = 'label-catalog';
type RecordLabel = ProjectLabel & { aliases: string[] };
const key = (name: string) => name.toLowerCase();
function scope(ctx: Ctx, project: string | null) { return project === null ? null : requireProject(ctx, project).slug; }
function location(project: string | null) { return project === null ? 'Inbox/Labels.json' : `Projects/${project}/Labels.json`; }
function defaultColor(name: string) {
 let h = 0; for(const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
 const colors = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899'];
 return colors[Math.floor(h / 45)]!;
}
async function catalog(ctx: Ctx, project: string | null): Promise<RecordLabel[]> {
 const file = await resolveVaultPath(ctx.vault, location(project));
 let labels: RecordLabel[] = [];
 try { const parsed = JSON.parse(await fs.readFile(file.abs,'utf8')); if(!Array.isArray(parsed)) throw new Error('Invalid label catalog'); labels = parsed; }
 catch(e) { if((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
 for(const ticket of ctx.index.tickets.values()) if(ticket.project === project) for(const name of ticket.labels) {
  if(!labels.some(l => key(l.name) === key(name) || l.aliases.some(a => key(a) === key(name)))) labels.push({id:createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0,20),project,name,color:defaultColor(name),deleted:false,aliases:[]});
 }
 return labels.map(l => ({...l, project}));
}
async function save(ctx: Ctx, project: string | null, labels: RecordLabel[]) {
 const file = await resolveVaultPath(ctx.vault, location(project)); assertWritable(file,'updated');
 await atomicWrite(file.abs, JSON.stringify(labels,null,2)+'\n'); await syncAndBroadcast(ctx,[file.rel]);
 ctx.hub.broadcast({type:'labels'});
}
export async function initializeLabels(ctx: Ctx) {
 for(const project of [null,...ctx.index.projects.keys()]) {
  const file = await resolveVaultPath(ctx.vault,location(project));
  if(!await pathExists(file.abs)) { const labels = await catalog(ctx,project); if(labels.length) await save(ctx,project,labels); }
 }
}
export async function listLabels(ctx: Ctx): Promise<ProjectLabel[]> {
 const all = await Promise.all([null,...ctx.index.projects.keys()].map(project => catalog(ctx,project)));
 return all.flat().map(({aliases,...label}) => label).sort((a,b) => a.name.localeCompare(b.name));
}
// Called under LABEL_LOCK by task writes. Renamed/deleted names from stale drafts cannot resurrect labels.
export async function canonicalLabels(ctx: Ctx, project: string | null, values: unknown): Promise<string[]> {
 const labels = await catalog(ctx,project); const output: string[] = []; let changed = false;
 for(const name of coerceLabels(values)) {
  const known = labels.find(l => key(l.name) === key(name) || l.aliases.some(a => key(a) === key(name)));
  if(known) { if(!known.deleted) output.push(known.name); }
  else { labels.push({id:randomUUID(),project,name,color:defaultColor(name),deleted:false,aliases:[]}); output.push(name); changed = true; }
 }
 if(changed) await save(ctx,project,labels);
 return coerceLabels(output);
}
export async function mutateLabel(ctx: Ctx, projectInput: string | null, id: string | undefined, input: {name?: string; color?: string; deleted?: boolean; agent?: string}): Promise<ProjectLabel> {
 return ctx.locks.run(LABEL_LOCK, async () => {
  const project = scope(ctx,projectInput), labels = await catalog(ctx,project), by = actingAgent(ctx,input.agent);
  const old = id ? labels.find(l => l.id === id) : undefined;
  if(id && !old) throw notFound('Label not found in this project.');
  const name = input.name === undefined ? old?.name : coerceLabels([input.name])[0];
  if(!name) throw invalid('Label name is required.');
  const color = input.color ?? old?.color ?? defaultColor(name);
  if(!/^#[0-9a-fA-F]{6}$/.test(color)) throw invalid('Use a six-digit hex color.');
  if(labels.some(l => l.id !== old?.id && (key(l.name) === key(name) || l.aliases.some(a => key(a) === key(name))))) throw conflict('This project already has a label with that name.');
  const next: RecordLabel = {...old, id:old?.id ?? randomUUID(),project,name,color,deleted:input.deleted ?? old?.deleted ?? false,aliases:old?.aliases ?? []};
  if(old && old.name !== name) next.aliases = [...new Set([...old.aliases,old.name])];
  if(old && (old.name !== name || next.deleted)) {
   for(const t of [...ctx.index.tickets.values()]) if(t.project === project && t.labels.some(l => key(l) === key(old.name))) {
    const values = t.labels.flatMap(l => key(l) === key(old.name) ? next.deleted ? [] : [name] : [l]);
    await updateTicket(ctx,t.id,{labels:values,by},true);
   }
  }
  const index = labels.findIndex(l => l.id === next.id); if(index < 0) labels.push(next); else labels[index] = next;
  await save(ctx,project,labels);
  await recordActivitySafe(ctx,{agent:by,type:'doc.updated',path:location(project),project,subject:`Label ${next.deleted ? 'deleted' : old ? 'updated' : 'created'}: ${name}`});
  const {aliases,...result} = next; return result;
 });
}
