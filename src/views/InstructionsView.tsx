import { InventoryToolbar } from './InventoryToolbar';
import { useEffect, useState } from 'react';
import type { CatalogInstruction, InstructionCatalog, InstructionDocument, InstructionFilters } from '@shared/instructions';
import { filterInstructions, matchingCopies, groupInstructions, instructionContext, type InstructionSort } from '@shared/instructions';
import { usePersisted } from '../lib/usePersisted';
import { Select } from '../ui/Select';
import { api } from '../lib/api';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import { ViewHeader } from '../shell/ViewHeader';
import { Document, Folder, Globe, ChevronRight, X } from '../ui/icons';
import { Modal } from '../ui/overlays';

export function InstructionsView() {
  const [sort,setSort]=usePersisted<InstructionSort>('instructions.sort','name');
  const [catalog,setCatalog]=useState<InstructionCatalog>({files:[],devices:[]});
  const [filters,setFilters]=useState<InstructionFilters>({});
  const [loading,setLoading]=useState(true);const [error,setError]=useState('');
  const [selected,setSelected]=useState<CatalogInstruction|null>(null);const [connecting,setConnecting]=useState(false);
  const refresh=async(sync=true)=>{setLoading(true);setError('');try{setCatalog(await (sync?api.refreshInstructions():api.instructions()));}catch(e){setError((e as Error).message);}finally{setLoading(false);}};
  useEffect(()=>{void refresh(false);},[]);
  const files=filterInstructions(catalog.files,filters);
  const groups=groupInstructions(files,sort);
  const copies=catalog.files.flatMap(f=>f.copies);
  const agents=[...new Set(copies.map(c=>c.agent))].sort();const projects=[...new Set(copies.flatMap(c=>c.project?[c.project]:[]))].sort();
  const set=(key:keyof InstructionFilters,value:string)=>setFilters({...filters,[key]:value});
  return <>
    <ViewHeader crumbs={[{label:'Instructions',icon:<Document size={15}/>}]}><><button className="btn" disabled={loading} onClick={()=>void refresh()}>{loading?'Refreshing…':'Refresh'}</button><button className="btn" onClick={()=>setConnecting(true)}>Connect a device</button></></ViewHeader>
    <div className="view-body skills-page">
      <header className="skills-heading"><div><h1>Instructions</h1><p>The rules your agents follow, globally or in a project.</p></div><span>{catalog.files.length} files · {catalog.devices.length} {catalog.devices.length===1?'device':'devices'}</span></header>
      <div className="inventory-tabs" aria-label="Instruction scope">{([['','All instructions'],['global','Global'],['project','Projects']] as const).map(([value,label]) => <button key={value} className="chip" aria-pressed={(filters.scope ?? '') === value} onClick={() => set('scope',value)}>{label}</button>)}</div>
      <InventoryToolbar query={filters.query ?? ''} onQuery={v => set('query',v)} label="Instructions" count={`${files.length} of ${catalog.files.length} files · ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`} summary={[catalog.devices.find(d => d.id === filters.device)?.name, filters.agent, filters.project].filter(Boolean).join(' · ')} activeCount={Object.entries(filters).filter(([k,v]) => k !== 'query' && v).length} onClear={() => setFilters({})}>
        <Select aria-label="Device" value={filters.device ?? ''} onChange={v=>set('device',v)}><option value="">All devices</option>{catalog.devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select aria-label="Agent" value={filters.agent ?? ''} onChange={v=>set('agent',v)}><option value="">All agents</option>{agents.map(a=><option key={a}>{a}</option>)}</Select>
        <Select aria-label="Project" value={filters.project ?? ''} onChange={v=>set('project',v)}><option value="">All projects</option>{projects.map(p=><option key={p}>{p}</option>)}</Select>
        <Select aria-label="Sort instructions" value={sort} onChange={v=>setSort(v as InstructionSort)}><option value="name">Project name</option><option value="recent">Recently reported</option></Select>
      </InventoryToolbar>
      {error&&<p role="alert" className="skills-error">{error} <button className="btn" onClick={()=>void refresh()}>Retry</button></p>}
      {loading&&<p role="status">Loading instructions…</p>}
      {!loading&&!error&&!files.length&&<div className="empty"><Document size={30}/><h2>{catalog.files.length?'No matching instructions':'Bring your instructions together'}</h2><p>{catalog.files.length?'Try another device, agent, or scope.':'Connect a device to see its global and project instruction files.'}</p></div>}
      <div className="instruction-groups">{groups.map(group=><details key={`${group.id}:${Object.values(filters).some(Boolean)}`} className="instruction-group" open={group.scope==='global'||Object.values(filters).some(Boolean)}>
        <summary><span className="instruction-group-icon">{group.scope==='global'?<Globe size={20}/>:<Folder size={20}/>}</span><span className="instruction-group-heading"><strong>{group.title}</strong><span>{group.scope === 'global' ? 'Applies across your projects' : [...new Set(group.files.map(f => f.agent))].join(' · ')}</span></span><span className="instruction-group-count">{group.files.length} {group.files.length===1?'file':'files'}</span><ChevronRight size={16}/></summary>
        <div className="instruction-group-files">{group.files.map(file=>{
          const locations=matchingCopies(file,filters);
          return <button className="instruction-file" key={file.id} onClick={()=>setSelected(file)}><Document size={17}/><span className="instruction-file-heading"><strong>{file.name}</strong><span>{instructionContext(file)}</span></span><span className="skill-locations"><span>{[...new Set(locations.map(c=>c.deviceName))].join(' · ')}</span>{file.versions>1&&<span>{file.versions} versions</span>}</span><ChevronRight size={14}/></button>;
        })}</div>
      </details>)}</div>
      {!!catalog.devices.length&&<details className="skill-report-times"><summary>Device reports</summary>{catalog.devices.map(d=><p key={d.id}>{d.name} · Last reported {new Date(d.reportedAt).toLocaleString()}</p>)}<p>{window.centcom?.isElectron?'Refresh updates this Mac’s files and loads the latest reports from other devices.':'Refresh loads the latest device reports. To update files, refresh in the Mac app or run instruction sync on that device.'}</p></details>}
    </div>
    {selected&&<InstructionReader file={selected} initialCopy={matchingCopies(selected,filters)[0]!.id} onClose={()=>setSelected(null)}/>}
    {connecting&&<Modal onClose={()=>setConnecting(false)} width={560}><div className="nav-customize"><header><h2>Connect a device</h2><button className="icon-btn" aria-label="Close" onClick={()=>setConnecting(false)}><X size={18}/></button></header><div style={{padding:'0 24px 24px'}}><p>Run on each Mac using the CLI connected to your shared CENTCOM server:</p><pre className="instruction-command">centcom instruction sync --device macbook --device-name "MacBook"</pre><p>Finds global instruction files, projects under ~/Projects, and ~/CENTCOM. Use --project-dir for other project folders. Reports keep Markdown available here; they don’t overwrite the files on your devices.</p><p>Other bots can submit their files through report_instructions in MCP, or a JSON report with --report-file. Use a unique reporter for a custom subset.</p></div></div></Modal>}
  </>;
}
function InstructionReader({file,initialCopy,onClose}:{file:CatalogInstruction;initialCopy:string;onClose:()=>void}) {
  const [copy,setCopy]=useState(initialCopy);const [doc,setDoc]=useState<InstructionDocument|null>(null);const [error,setError]=useState('');
  useEffect(()=>{let current=true;setDoc(null);setError('');api.instructionDocument(copy).then(d=>{if(current)setDoc(d);}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[copy]);
  const location=file.copies.find(c=>c.id===copy)!;
  return <Modal onClose={onClose} width={900}><div className="skill-reader"><header><div><h2>{file.project ?? instructionContext(file)}</h2><p>{file.name} · {file.scope==='global'?'Global':instructionContext(file)}{file.versions>1?` · ${file.versions} versions`:''}</p></div><button className="icon-btn" aria-label="Close instructions" onClick={onClose}><X size={18}/></button></header><div className="skill-reader-controls"><label>Reported copy<Select aria-label="Reported copy" value={copy} onChange={setCopy}>{file.copies.map(c=><option key={c.id} value={c.id}>{c.deviceName} · {c.agent} · {c.project ?? 'Global'}</option>)}</Select></label></div><details className="inventory-file-details"><summary>File details</summary><p className="skill-path selectable">{location.path}<br/>Last reported {new Date(location.reportedAt).toLocaleString()}</p></details><div className="skill-document selectable">{error?<p role="alert">{error}</p>:!doc?<p>Loading instructions…</p>:<MarkdownEditor key={copy} value={doc.body} docPath="" readOnly toolbar={false} onChange={()=>{}}/>}</div></div></Modal>;
}
