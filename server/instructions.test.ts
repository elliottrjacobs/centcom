import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startTestServer, tempDir } from './testkit.ts';
import { localInstructionReport } from '../cli/instruction-inventory.ts';
import { desktopInstructionReport, rememberInstructionSource } from '../cli/instruction-source.ts';
import { filterInstructions, groupInstructions, instructionContext, type InstructionCatalog, type InstructionReport, type InstructionEntry } from '../shared/instructions.ts';
const exec=promisify(execFile);
const entry:InstructionEntry={name:'AGENTS.md',agent:'Codex',scope:'global',project:null,projectKey:null,relativePath:'.codex/AGENTS.md',path:'/home/a/.codex/AGENTS.md',markdown:'# Rules\n\nUse **CENTCOM**.'};
const report=(deviceId:string,entries=[entry],reporter='centcom-cli'):InstructionReport=>({deviceId,deviceName:deviceId,reporter,entries});
test('desktop refresh rereads edits, additions and removals using saved local identity and roots',async t=>{
 const s=await startTestServer();t.after(()=>s.close());
 const home=await tempDir('instruction-refresh');t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const configDir=path.join(home,'config');const projects=[path.join(home,'custom-project')];
 await fs.mkdir(path.join(home,'.codex'),{recursive:true});await fs.mkdir(projects[0]!,{recursive:true});
 const globalFile=path.join(home,'.codex/AGENTS.md');const removedFile=path.join(projects[0]!,'CLAUDE.md');
 await fs.writeFile(globalFile,'# Old mapping');await fs.writeFile(removedFile,'# Old project');
 const initial=await localInstructionReport({home,deviceId:'mini',deviceName:'Mac mini',reporter:'centcom-cli',projects});
 await s.api('PUT','/api/instructions/inventory',initial);
 await rememberInstructionSource(initial,projects,configDir);
 await s.api('PUT','/api/instructions/inventory',report('book'));
 await s.api('PUT','/api/instructions/inventory',report('mini',[entry],'custom-bot'));
 await fs.writeFile(globalFile,'# Current rules');await fs.unlink(removedFile);
 await fs.writeFile(path.join(projects[0]!,'AGENTS.md'),'# New project');
 const fresh=await desktopInstructionReport(configDir,home);
 assert.equal(fresh.deviceId,'mini');assert.equal(fresh.deviceName,'Mac mini');
 assert.equal((await s.api('PUT','/api/instructions/inventory',fresh)).status,200);
 const c=(await s.api<InstructionCatalog>('GET','/api/instructions')).json;
 assert.equal(c.devices.length,2);
 const copies=c.files.flatMap(f=>f.copies);
 const local=copies.filter(c=>c.deviceId==='mini'&&c.reporter==='centcom-cli');
 assert.equal(local.length,2);assert.ok(!local.some(c=>c.path===removedFile));
 const global=local.find(c=>c.path===globalFile)!;
 assert.equal((await s.api<{body:string}>('GET',`/api/instructions/copies/${global.id}`)).json.body,'# Current rules');
 assert.equal(copies.filter(c=>c.deviceId==='book'||c.reporter==='custom-bot').length,2);
 await fs.writeFile(globalFile,'x'.repeat(500001));
 await assert.rejects(desktopInstructionReport(configDir,home),/exceeds 500 KB/);
 assert.equal((await s.api<{body:string}>('GET',`/api/instructions/copies/${global.id}`)).json.body,'# Current rules');
});
test('instruction catalog merges logical copies, preserves file content and filters one copy at a time',async t=>{
 const s=await startTestServer();t.after(()=>s.close());
 await s.api('PUT','/api/instructions/inventory',report('mini'));
 await s.api('PUT','/api/instructions/inventory',report('book',[{...entry,path:'/Users/b/.codex/AGENTS.md',markdown:'# Changed',agent:'Bot'}]));
 let c=(await s.api<InstructionCatalog>('GET','/api/instructions')).json;
 assert.equal(c.files.length,1);assert.equal(c.files[0]!.versions,2);assert.equal(c.files[0]!.copies.length,2);
 assert.equal(filterInstructions(c.files,{device:'mini',agent:'Bot'}).length,0);
 assert.equal(filterInstructions(c.files,{device:'book',agent:'Bot'}).length,1);
 const copy=c.files[0]!.copies.find(i=>i.deviceId==='mini')!;
 assert.equal((await s.api<{body:string}>('GET',`/api/instructions/copies/${copy.id}`)).json.body,entry.markdown);
 await s.api('PUT','/api/instructions/inventory',report('book',[{...entry,scope:'project',project:'app',projectKey:'repo:github.com/owner/app',relativePath:'AGENTS.md'}]));
 c=(await s.api<InstructionCatalog>('GET','/api/instructions')).json;
 assert.equal(c.files.length,2);assert.equal(filterInstructions(c.files,{scope:'project'}).length,1);
});
test('instruction snapshots replace only one reporter/device and reject invalid replacement atomically',async t=>{
 const s=await startTestServer();t.after(()=>s.close());
 for(const r of [report('mini'),report('book'),report('mini',[entry],'bot')])await s.api('PUT','/api/instructions/inventory',r);
 for(const entries of [[entry,entry],[{...entry,name:'secrets.env'}],[{...entry,scope:'project'}]])assert.equal((await s.api('PUT','/api/instructions/inventory',{...report('mini'),entries})).status,400);
 let c=(await s.api<InstructionCatalog>('GET','/api/instructions')).json;assert.equal(c.files[0]!.copies.length,3);
 const id=c.files[0]!.copies.find(i=>i.deviceId==='mini'&&i.reporter==='centcom-cli')!.id;
 await s.api('PUT','/api/instructions/inventory',report('mini',[]));
 c=(await s.api<InstructionCatalog>('GET','/api/instructions')).json;assert.equal(c.files[0]!.copies.length,2);assert.equal(c.devices.length,2);
 assert.equal((await s.api('GET',`/api/instructions/copies/${id}`)).status,404);
});
test('project identity and relative path prevent unrelated instruction files from collapsing',async t=>{
 const s=await startTestServer();t.after(()=>s.close());
 const project={...entry,scope:'project' as const,project:'app',projectKey:'repo:github.com/owner/app',relativePath:'AGENTS.md'};
 await s.api('PUT','/api/instructions/inventory',report('mini',[project,{...project,path:'/another/AGENTS.md',projectKey:'repo:github.com/other/app'},{...project,path:'/home/a/web/AGENTS.md',relativePath:'web/AGENTS.md'}]));
 await s.api('PUT','/api/instructions/inventory',report('book',[{...project,path:'/Users/b/Projects/app/AGENTS.md'}]));
 const c=(await s.api<InstructionCatalog>('GET','/api/instructions')).json;
 assert.equal(c.files.length,3);assert.equal(c.files.find(f=>f.copies.length===2)?.versions,1);
});
test('scanner discovers global and nested project instructions while skipping dependencies and cycles',async t=>{
 const home=await tempDir('instructions');t.after(()=>fs.rm(home,{recursive:true,force:true}));
 async function write(file:string,body='# Instructions'){await fs.mkdir(path.dirname(path.join(home,file)),{recursive:true});await fs.writeFile(path.join(home,file),body);}
 await write('.codex/AGENTS.md');await write('.claude/CLAUDE.md');await write('Projects/app/AGENTS.md');await write('Projects/app/web/claude.md');await write('Projects/app/.claude/CLAUDE.md');await write('Projects/app/node_modules/dependency/AGENTS.md');await write('.claude/plugins/cache/CLAUDE.md');
 await fs.symlink(path.join(home,'Projects/app'),path.join(home,'Projects/app/cycle'));
 const r=await localInstructionReport({home,deviceId:'mini',reporter:'test'});
 assert.equal(r.entries.length,5);assert.equal(r.entries.filter(e=>e.scope==='global').length,2);
 assert.ok(r.entries.some(e=>e.relativePath==='web/claude.md'));
 assert.ok(r.entries.every(e=>e.projectKey===null||e.projectKey.startsWith('local:mini:')));
 const explicit=await localInstructionReport({home,projects:[],reporter:'test'});assert.equal(explicit.entries.length,2);
});
test('scanner groups repository clones using origin and keeps exact Markdown without executing it',async t=>{
 const home=await tempDir('instruction-repos');t.after(()=>fs.rm(home,{recursive:true,force:true}));
 for(const dir of ['one','two']){
  const root=path.join(home,dir);await fs.mkdir(root);await exec('git',['init',root]);await exec('git',['-C',root,'remote','add','origin','git@github.com:Owner/Repo.git']);await fs.writeFile(path.join(root,'AGENTS.md'),'---javascript\nthrow new Error("never execute")\n---\n# Rules');
 }
 const r=await localInstructionReport({home,projects:[path.join(home,'one'),path.join(home,'two')],reporter:'test'});
 assert.equal(r.entries.length,2);assert.equal(r.entries[0]!.projectKey,'repo:github.com/owner/repo');assert.equal(r.entries[0]!.projectKey,r.entries[1]!.projectKey);assert.match(r.entries[0]!.markdown,/never execute/);
});
test('CLI report-file and MCP inventory reads share the authenticated REST inventory',async t=>{
 const s=await startTestServer();t.after(()=>s.close());const dir=await tempDir('instruction-cli');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'report.json');await fs.writeFile(file,JSON.stringify(report('mini')));
 const {stdout}=await exec(process.execPath,['--import','tsx',path.resolve('cli/centcom.ts'),'instruction','sync','--report-file',file,'--json'],{env:{...process.env,CENTCOM_URL:s.base,CENTCOM_TOKEN:s.token}});
 assert.equal(JSON.parse(stdout).files,1);
 const call=async(name:string,args:Record<string,unknown>)=>{
  const response=await fetch(`${s.base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  const rpc=await response.json() as {result:{isError?:boolean;content:{text:string}[]}};assert.equal(rpc.result.isError,undefined);return JSON.parse(rpc.result.content[0]!.text);
 };
 await call('report_instructions',report('book') as unknown as Record<string,unknown>);
 const c=await call('list_instructions',{});assert.equal(c.files[0].copies.length,2);
 const doc=await call('get_instruction',{id:c.files[0].copies[0].id});assert.equal(doc.body,entry.markdown);
});

test('instruction groups retain distinct projects with the same name and lead with context',async t=>{
 const s=await startTestServer();t.after(()=>s.close());
 const project={...entry,scope:'project' as const,project:'App',projectKey:'repo:github.com/owner/app',relativePath:'web/AGENTS.md',path:'/Users/a/App/web/AGENTS.md',agent:'Shared'};
 await s.api('PUT','/api/instructions/inventory',report('mini',[entry,project,{...project,path:'/Users/a/another/web/AGENTS.md',projectKey:'repo:github.com/other/app'}]));
 const c=(await s.api<InstructionCatalog>('GET','/api/instructions')).json;
 const groups=groupInstructions(c.files);
 assert.equal(groups.length,3);assert.equal(groups[0]!.title,'Global instructions');
 assert.notEqual(groups[1]!.id,groups[2]!.id);assert.notEqual(groups[1]!.location,groups[2]!.location);
 assert.equal(instructionContext(groups[0]!.files[0]!), 'Codex');
 assert.equal(instructionContext(groups[1]!.files[0]!), 'web · Shared agents');
});
