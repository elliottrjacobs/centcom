import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Ctx } from './context.ts';
import { atomicWrite } from './fsutil.ts';
import { invalid, notFound } from './errors.ts';
import type { InstructionReport, InstructionCatalog, CatalogInstruction, InstructionDocument } from '../shared/instructions.ts';

const text = z.string().trim().min(1).max(1000);
export const instructionReportSchema = z.object({
  deviceId: text, deviceName: text, reporter: text,
  entries: z.array(z.object({
    name: z.enum(['AGENTS.md','CLAUDE.md']), agent: text, scope: z.enum(['global','project']),
    project: text.nullable(), projectKey: text.nullable(), relativePath: text,
    path: z.string().min(1).max(4000), markdown: z.string().max(500000),
  }).refine(e => e.scope === 'global' ? e.project === null && e.projectKey === null : !!e.project && !!e.projectKey, 'Project files require project and projectKey; global files must omit both.')).max(5000),
});
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
interface Snapshot extends InstructionReport { reportedAt:number }
const folder = (ctx:Ctx) => path.join(ctx.configDir,'instruction-inventories');
async function snapshots(ctx:Ctx):Promise<Snapshot[]> {
  let files:string[];
  try { files=await fs.readdir(folder(ctx)); } catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e; }
  return Promise.all(files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(async f=>JSON.parse(await fs.readFile(path.join(folder(ctx),f),'utf8')) as Snapshot));
}
const copyId=(r:Snapshot,e:InstructionReport['entries'][number])=>hash(JSON.stringify([r.deviceId,r.reporter,e.path]));
export async function reportInstructions(ctx:Ctx,input:InstructionReport) {
  const parsed=instructionReportSchema.safeParse(input);
  if(!parsed.success)throw invalid(parsed.error.issues.map(i=>i.message).join('; '));
  const report=parsed.data;
  if(new Set(report.entries.map(e=>e.path)).size!==report.entries.length)throw invalid('Duplicate instruction path in report.');
  const id=hash(JSON.stringify([report.deviceId,report.reporter]));
  return ctx.locks.run(`instruction-report:${id}`,async()=>{
    const snapshot={...report,reportedAt:Date.now()};
    await atomicWrite(path.join(folder(ctx),`${id}.json`),JSON.stringify(snapshot));
    return {ok:true,files:report.entries.length,reportedAt:snapshot.reportedAt};
  });
}
export async function instructionCatalog(ctx:Ctx):Promise<InstructionCatalog> {
  const files=new Map<string,CatalogInstruction>();
  const devices=new Map<string,InstructionCatalog['devices'][number]>();
  for(const r of await snapshots(ctx)) {
    if((devices.get(r.deviceId)?.reportedAt ?? 0)<r.reportedAt)devices.set(r.deviceId,{id:r.deviceId,name:r.deviceName,reportedAt:r.reportedAt});
    for(const e of r.entries) {
      // Same repository + relative location across hosts; global tool folders stay distinct.
      const id=hash(JSON.stringify([e.scope,e.projectKey,e.relativePath,e.name]));
      let file=files.get(id);
      if(!file){file={id,name:e.name,agent:e.agent,scope:e.scope,project:e.project,relativePath:e.relativePath,versions:0,copies:[]};files.set(id,file);}
      const {markdown,...metadata}=e;
      file.copies.push({...metadata,id:copyId(r,e),deviceId:r.deviceId,deviceName:r.deviceName,reporter:r.reporter,reportedAt:r.reportedAt,hash:hash(markdown)});
    }
  }
  for(const file of files.values()){file.versions=new Set(file.copies.map(c=>c.hash)).size;file.copies.sort((a,b)=>b.reportedAt-a.reportedAt);}
  return {files:[...files.values()].sort((a,b)=>`${a.project ?? ''}${a.relativePath}`.localeCompare(`${b.project ?? ''}${b.relativePath}`)),devices:[...devices.values()].sort((a,b)=>a.name.localeCompare(b.name))};
}
export async function instructionDocument(ctx:Ctx,id:string):Promise<InstructionDocument> {
  for(const r of await snapshots(ctx))for(const e of r.entries)if(copyId(r,e)===id)return {markdown:e.markdown,body:e.markdown};
  throw notFound('This file is no longer in the device report. Refresh Instructions.');
}
