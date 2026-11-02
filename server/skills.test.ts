import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SkillReport, SkillCatalog, SkillDocument } from '../shared/skills.ts';
import { filterSkills, skillLibrary } from '../shared/skills.ts';
import { startTestServer, tempDir } from './testkit.ts';
import { githubSource } from './skills.ts';
import { scanSkills } from '../cli/skill-inventory.ts';
const entry = {name:'example',description:'A useful Skill',agent:'Codex',scope:'global' as const,project:null,path:'/home/me/.codex/skills/example/SKILL.md',sourceUrl:'https://github.com/owner/repo',markdown:'---\nname: example\n---\n# Example\n\n| A | B |\n| --- | --- |\n| one | two |\n'};
const report = (deviceId:string, entries: SkillReport['entries'] = [entry], reporter='centcom-cli'): SkillReport => ({deviceId,deviceName:deviceId,reporter,entries});
test('catalog merges devices, scopes, normalized origins; preserves and reads differing copies', async t=>{
  const s=await startTestServer();t.after(()=>s.close());
  assert.equal((await s.api('PUT','/api/skills/inventory',report('mini'))).status,200);
  await s.api('PUT','/api/skills/inventory',report('book',[{...entry,agent:'Grok',scope:'project',project:'/projects/demo',sourceUrl:'git@github.com:Owner/Repo.git',markdown:'# Changed'}]));
  const {json:c}=await s.api<SkillCatalog>('GET','/api/skills');
  assert.equal(c.skills.length,1);assert.equal(c.skills[0]!.versions,2);assert.equal(c.devices.length,2);
  assert.equal(filterSkills(c.skills,{device:'mini',agent:'Grok'}).length,0,'Filters must match one installation, not different copies');
  assert.equal(filterSkills(c.skills,{device:'book',agent:'Grok',project:'/projects/demo'}).length,1);
  const i=c.skills[0]!.installations.find(i=>i.deviceId==='mini')!;
  const {json:d}=await s.api<SkillDocument>('GET',`/api/skills/installations/${i.id}`);
  assert.equal(d.markdown,entry.markdown);assert.equal(d.frontmatter.name,'example');assert.match(d.body,/\| A \| B \|/);
});
test('full snapshots remove uninstalled copies without erasing another device or reporter',async t=>{
  const s=await startTestServer();t.after(()=>s.close());
  await Promise.all([s.api('PUT','/api/skills/inventory',report('mini')),s.api('PUT','/api/skills/inventory',report('book')),s.api('PUT','/api/skills/inventory',report('mini',[entry],'grok'))]);
  const before=(await s.api<SkillCatalog>('GET','/api/skills')).json;
  const old=before.skills[0]!.installations.find(i=>i.deviceId==='mini'&&i.reporter==='centcom-cli')!.id;
  await s.api('PUT','/api/skills/inventory',report('mini',[]));
  const after=(await s.api<SkillCatalog>('GET','/api/skills')).json;
  assert.equal(after.skills[0]!.installations.length,2);assert.equal(after.devices.length,2);
  assert.equal((await s.api('GET',`/api/skills/installations/${old}`)).status,404);
});
test('unknown copies join a unique known origin; same names from different sources stay separate',async t=>{
  const s=await startTestServer();t.after(()=>s.close());
  await s.api('PUT','/api/skills/inventory',report('mini'));
  await s.api('PUT','/api/skills/inventory',report('book',[{...entry,sourceUrl:null,markdown:'# Older version'}]));
  assert.equal((await s.api<SkillCatalog>('GET','/api/skills')).json.skills.length,2, 'A name match alone cannot establish provenance');
  await s.api('PUT','/api/skills/inventory',report('third',[{...entry,sourceUrl:'https://github.com/other/repo',markdown:'# Other'}]));
  assert.equal((await s.api<SkillCatalog>('GET','/api/skills')).json.skills.length,3, 'Unknown copy stays separate when two repositories claim the name');
});
test('rejects invalid snapshots atomically and never interprets executable frontmatter',async t=>{
  const s=await startTestServer();t.after(()=>s.close());
  await s.api('PUT','/api/skills/inventory',report('mini'));
  for (const entries of [[{...entry,scope:'project'}],[{...entry,sourceUrl:'javascript:alert(1)'}],[entry,entry]]) {
    assert.equal((await s.api('PUT','/api/skills/inventory',{...report('mini'),entries})).status,400);
  }
  assert.equal((await s.api<SkillCatalog>('GET','/api/skills')).json.skills[0]!.installations.length,1);
  const markdown='---javascript\n(()=>{throw new Error("must never execute")})()\n---\n# Text';
  assert.equal((await s.api('PUT','/api/skills/inventory',report('mini',[{...entry,markdown}]))).status,200);
  const c=(await s.api<SkillCatalog>('GET','/api/skills')).json;
  const d=(await s.api<SkillDocument>('GET',`/api/skills/installations/${c.skills[0]!.installations[0]!.id}`)).json;
  assert.equal(d.body,markdown);assert.deepEqual(d.frontmatter,{});
});
test('source URLs strip ref paths and never preserve credentials or foreign hosts',()=>{
  assert.equal(githubSource('ssh://git@github.com/Owner/Repo.git'),'https://github.com/owner/repo');
  assert.equal(githubSource('https://github.com/Owner/Repo/tree/main/skills'),'https://github.com/owner/repo');
  assert.equal(githubSource('https://github.com.evil.test/o/r'),null);
  assert.equal(githubSource('https://secret@github.com/o/r'),null);
});
test('scanner follows installed symlinks, handles cycles, extracts project metadata without executing it',async t=>{
  const root=await tempDir('skills');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'actual'),{recursive:true});await fs.writeFile(path.join(root,'actual/SKILL.md'),entry.markdown);
  await fs.mkdir(path.join(root,'global'));await fs.symlink(path.join(root,'actual'),path.join(root,'global/example'));
  await fs.symlink(path.join(root,'global'),path.join(root,'global/cycle'));
  const scanned=await scanSkills([{path:path.join(root,'global'),agent:'Bot',project:root}]);
  assert.equal(scanned.length,1);assert.equal(scanned[0]!.scope,'project');assert.equal(scanned[0]!.markdown,entry.markdown);
});

const SOURCES = {
  libraries: [
    { repository: 'https://github.com/design-team/skills', id: 'design', name: 'Design Team Skills' },
    { repository: 'https://github.com/owner/workflows', id: 'workflows', name: 'Workflows' },
  ],
  pluginNames: { 'app-0123': 'Search Plugin' },
};
const writeSources = (configDir: string, value: unknown) => fs.writeFile(path.join(configDir, 'skill-sources.json'), JSON.stringify(value));

test('libraries group known collections without inventing repository provenance; filters combine', async t => {
  const s = await startTestServer(); t.after(() => s.close());
  await writeSources(s.configDir, SOURCES);
  await s.api('PUT','/api/skills/inventory',report('mini',[
    {...entry,name:'better-layout',sourceUrl:'https://github.com/design-team/skills'},
    {...entry,name:'better-ui',sourceUrl:'https://github.com/design-team/skills',path:'/skills/better-ui/SKILL.md'},
    {...entry,name:'exo-work',sourceUrl:'https://github.com/owner/workflows',path:'/skills/exo-work/SKILL.md'},
    {...entry,name:'plugin-skill',sourceUrl:null,path:'/home/me/.codex/plugins/cache/market/expo/1/skills/test/SKILL.md'},
    {...entry,name:'named-plugin',sourceUrl:null,path:'/home/me/.codex/plugins/cache/market/app-0123/1/skills/x/SKILL.md'},
  ]));
  const catalog = (await s.api<SkillCatalog>('GET','/api/skills')).json;
  assert.equal(filterSkills(catalog.skills,{library:'design'}).length,2);
  assert.equal(filterSkills(catalog.skills,{library:'design',device:'other'}).length,0);
  assert.equal(filterSkills(catalog.skills,{query:'Workflows'}).length,1);
  assert.equal(catalog.skills.find(s=>s.name==='better-layout')!.sourceUrl,'https://github.com/design-team/skills');
  assert.equal(catalog.skills.find(s=>s.name==='plugin-skill')!.library?.id,'plugin:expo');
  assert.deepEqual(catalog.skills.find(s=>s.name==='named-plugin')!.library,{id:'plugin:app-0123',name:'Search Plugin'});
});

test('library attribution follows repository evidence, never a suggestive name prefix',()=>{
 const classify=(name:string,sourceUrl:string|null)=>skillLibrary({name,sourceUrl,installations:[]},{libraries:{'https://github.com/design-team/skills':{id:'design',name:'Design Team Skills'}},pluginNames:{}});
 assert.equal(classify('better-layout',null).id,'local');
 assert.equal(classify('better-layout','https://github.com/other/repo').id,'repo:other/repo');
 assert.equal(classify('example','https://github.com/design-team/skills').name,'Design Team Skills');
 assert.equal(classify('exo-unknown','https://github.com/other/workflows').id,'repo:other/workflows');
 assert.equal(skillLibrary({name:'x',sourceUrl:'https://github.com/design-team/skills',installations:[]}).id,'repo:design-team/skills','no owner data, no label');
});

test('only an exact verified SKILL.md hash supplies a missing repository; malformed sources are ignored',async t=>{
  const s=await startTestServer();t.after(()=>s.close());
  const md='---\nname: verified\n---\n# Verified\n';
  const { createHash } = await import('node:crypto');
  await writeSources(s.configDir,{...SOURCES,verified:[{sha256:createHash('sha256').update(md).digest('hex'),repository:'https://github.com/design-team/skills'}]});
  await s.api('PUT','/api/skills/inventory',report('mini',[{...entry,name:'verified',sourceUrl:null,markdown:md},{...entry,name:'edited',sourceUrl:null,markdown:`${md}\nlocal edit\n`,path:'/x/SKILL.md'}]));
  let c=(await s.api<SkillCatalog>('GET','/api/skills')).json;
  assert.equal(c.skills.find(x=>x.name==='verified')!.sourceUrl,'https://github.com/design-team/skills');
  assert.equal(c.skills.find(x=>x.name==='verified')!.library?.name,'Design Team Skills');
  assert.equal(c.skills.find(x=>x.name==='edited')!.sourceUrl,null);
  await fs.writeFile(path.join(s.configDir,'skill-sources.json'),'{ not json');
  c=(await s.api<SkillCatalog>('GET','/api/skills')).json;
  assert.equal(c.skills.find(x=>x.name==='edited')!.library?.id,'local');
});
test('identical unknown-origin copies can join one known repository without guessing across versions',async t=>{
 const s=await startTestServer();t.after(()=>s.close());
 await s.api('PUT','/api/skills/inventory',report('mini'));
 await s.api('PUT','/api/skills/inventory',report('book',[{...entry,sourceUrl:null}]));
 const c=(await s.api<SkillCatalog>('GET','/api/skills')).json;
 assert.equal(c.skills.length,1);assert.equal(c.skills[0]!.installations.length,2);
 assert.equal(c.skills[0]!.installations.find(i=>i.deviceId==='book')!.sourceUrl,null);
});
