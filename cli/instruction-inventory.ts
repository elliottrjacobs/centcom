import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstructionEntry, InstructionReport } from '../shared/instructions.ts';
const exec=promisify(execFile);
const excluded=new Set(['.git','node_modules','.next','.build','build','dist','Pods','vendor','.codex','.claude','.agents','.venv','venv','.expo','.cache']);
async function children(dir:string) {
  try{return await fs.readdir(dir,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
}
/** No whole-home crawl or dependency caches. Explicit projects replace the default ~/Projects roots. */
export async function localInstructionReport(options:{deviceId?:string;deviceName?:string;reporter:string;projects?:string[];home?:string}):Promise<InstructionReport> {
  const home=options.home ?? os.homedir();const deviceId=options.deviceId ?? os.hostname();
  const entries:InstructionEntry[]=[];const seenPaths=new Set<string>();
  const add=async(file:string,scope:'global'|'project',project:string|null,projectKey:string|null,relativePath:string)=>{
    const name=path.basename(file).toUpperCase();if(name!=='AGENTS.MD'&&name!=='CLAUDE.MD')return;
    if(seenPaths.has(file))return;
    let stat;try{stat=await fs.stat(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    if(!stat.isFile())return;if(stat.size>500000)throw new Error(`Instruction file exceeds 500 KB: ${file}`);
    entries.push({name:name==='AGENTS.MD'?'AGENTS.md':'CLAUDE.md',agent:name==='CLAUDE.MD'?'Claude Code':relativePath.startsWith('.codex/')?'Codex':'Shared',scope,project,projectKey,relativePath,path:file,markdown:await fs.readFile(file,'utf8')});seenPaths.add(file);
  };
  for(const dir of ['','.codex','.claude','.agents'])for(const entry of await children(path.join(home,dir)))if(/^(agents|claude)\.md$/i.test(entry.name))await add(path.join(home,dir,entry.name),'global',null,null,path.posix.join(dir,entry.name));
  const roots=options.projects ?? [...(await children(path.join(home,'Projects'))).filter(d=>d.isDirectory()||d.isSymbolicLink()).map(d=>path.join(home,'Projects',d.name)),path.join(home,'CENTCOM')];
  const visited=new Set<string>();
  async function walk(dir:string,base:string,key:string,depth:number):Promise<void>{
    if(depth>12)throw new Error(`Instruction scan exceeds 12 levels: ${dir}. Use --project-dir for a narrower folder.`);
    let real:string;try{real=await fs.realpath(dir);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    if(visited.has(real))return;visited.add(real);
    // Nested repositories have their own identity rather than inheriting their parent's.
    const items=await children(dir);
    try {
      if(dir!==base && !items.some(e=>e.name==='.git'))throw new Error('Not a repository root');
      const root=(await exec('git',['-C',dir,'rev-parse','--show-toplevel'],{timeout:3000})).stdout.trim();
      if(root===real || dir===base){
        const remote=(await exec('git',['-C',dir,'config','--get','remote.origin.url'],{timeout:3000})).stdout.trim();
        const match=remote.match(/^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/git@|git@)([^/:]+)[/:]([^?#]+?)(?:\.git)?$/);
        if(match){key=`repo:${match[1]!.toLowerCase()}/${match[2]!.replace(/\.git$/,'').toLowerCase()}`;base=root;}
      }
    } catch { /* Unversioned folders stay device-local, never merged by basename alone. */ }
    const project=path.basename(base);
    for(const entry of items){
      const file=path.join(dir,entry.name);
      if(/^(agents|claude)\.md$/i.test(entry.name))await add(file,'project',project,key,path.relative(base,file).split(path.sep).join('/'));
      else if(entry.isDirectory()&&!excluded.has(entry.name)&&!entry.name.startsWith('.')&&!/\.(app|xcarchive|framework|bundle)$/.test(entry.name))await walk(file,base,key,depth+1);
    }
    for(const hidden of ['.claude','.codex','.agents'])for(const entry of await children(path.join(dir,hidden)))if(/^(agents|claude)\.md$/i.test(entry.name))await add(path.join(dir,hidden,entry.name),'project',project,key,path.relative(base,path.join(dir,hidden,entry.name)).split(path.sep).join('/'));
  }
  for(const root of roots)await walk(path.resolve(root),path.resolve(root),`local:${deviceId}:${path.resolve(root)}`,0);
  return {deviceId,deviceName:options.deviceName ?? os.hostname(),reporter:options.reporter,entries};
}
