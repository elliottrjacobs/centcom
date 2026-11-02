import { InventoryToolbar } from './InventoryToolbar';
import { Select } from '../ui/Select';
import { useEffect, useState } from 'react';
import type { CatalogSkill, SkillCatalog, SkillDocument, SkillFilters } from '@shared/skills';
import { filterSkills, libraryOf, matchingInstallations } from '@shared/skills';
import { api } from '../lib/api';
import { MarkdownEditor } from '../editor/MarkdownEditor';
import { ViewHeader } from '../shell/ViewHeader';
import { BookOpen, ChevronRight, X } from '../ui/icons';
import { Modal } from '../ui/overlays';

export function SkillsView() {
  const [catalog, setCatalog] = useState<SkillCatalog>({skills:[],devices:[]});
  const [filters,setFilters] = useState<SkillFilters>({});
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [selected,setSelected] = useState<CatalogSkill | null>(null);
  const [connecting,setConnecting] = useState(false);
  const [browse, setBrowse] = useState<'skills' | 'libraries'>('skills');
  const refresh = async () => {
    setLoading(true);setError('');
    try { setCatalog(await api.skills()); } catch(e) { setError((e as Error).message); } finally {setLoading(false);}
  };
  useEffect(() => { void refresh(); }, []);
  const skills = filterSkills(catalog.skills,filters);
  const installs = catalog.skills.flatMap(s=>s.installations);
  const libraries = [...new Map(catalog.skills.map(s => { const l = libraryOf(s); return [l.id,l]; })).values()].sort((a,b)=>a.name.localeCompare(b.name));
  const agents = [...new Set(installs.map(i=>i.agent))].sort();
  const projects = [...new Set(installs.flatMap(i=>i.project ? [i.project] : []))].sort();
  const set = (key: keyof SkillFilters,value:string) => setFilters({...filters,[key]:value});
  return <>
    <ViewHeader crumbs={[{label:'Skills',icon:<BookOpen size={15}/>}]}> <><button className="btn" disabled={loading} onClick={()=>void refresh()}>Refresh</button><button className="btn" onClick={()=>setConnecting(true)}>Connect a device</button></></ViewHeader>
    <div className="view-body skills-page">
      <header className="skills-heading"><div><h1>Skills</h1><p>Reusable capabilities available to your agents.</p></div><span>{catalog.skills.length} Skills · {catalog.devices.length} {catalog.devices.length===1 ? 'device' : 'devices'}</span></header>
      <div className="inventory-tabs" aria-label="Browse Skills">
        <button className="chip" aria-pressed={browse === 'skills'} onClick={() => {setBrowse('skills');set('library','');}}>All Skills</button>
        <button className="chip" aria-pressed={browse === 'libraries'} onClick={() => {setBrowse('libraries');set('library','');}}>Libraries</button>
      </div>
      <InventoryToolbar query={filters.query ?? ''} onQuery={v => set('query',v)} label="Skills" count={`${skills.length} of ${catalog.skills.length} Skills${filters.library ? ` · ${libraries.find(l => l.id === filters.library)?.name ?? ''}` : ''}`} summary={[catalog.devices.find(d => d.id === filters.device)?.name, filters.agent, filters.scope, filters.project?.split('/').pop()].filter(Boolean).join(' · ')} activeCount={Object.entries(filters).filter(([k,v]) => k !== 'query' && v).length} onClear={() => setFilters({})}>
        <Select aria-label="Library" value={filters.library ?? ''} onChange={value=>set('library',value)}><option value="">All libraries</option>{libraries.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</Select>
        <Select aria-label="Device" value={filters.device ?? ''} onChange={value=>set('device',value)}><option value="">All devices</option>{catalog.devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select aria-label="Agent" value={filters.agent ?? ''} onChange={value=>set('agent',value)}><option value="">All agents</option>{agents.map(a=><option key={a}>{a}</option>)}</Select>
        <Select aria-label="Scope" value={filters.scope ?? ''} onChange={value=>set('scope',value)}><option value="">All scopes</option><option value="global">Global</option><option value="project">Project only</option></Select>
        <Select aria-label="Project" value={filters.project ?? ''} onChange={value=>set('project',value)}><option value="">All projects</option>{projects.map(p=><option key={p} value={p}>{p.split('/').pop()}</option>)}</Select>
      </InventoryToolbar>
      {error && <p role="alert" className="skills-error">{error} <button className="btn" onClick={()=>void refresh()}>Retry</button></p>}
      {loading && <p role="status">Loading Skills…</p>}
      {!loading && !error && !skills.length && <div className="empty"><BookOpen size={30}/><h2>{catalog.skills.length ? 'No matching Skills' : 'Bring your Skills together'}</h2><p>{catalog.skills.length ? 'Try another device, agent, or scope.' : 'Connect a Mac or agent runtime to see its installed Skills here.'}</p></div>}
      {browse === 'libraries' ? <div className="inventory-library-list">{libraries.map(l => ({...l, count: skills.filter(s => libraryOf(s).id === l.id).length})).filter(l => l.count > 0).map(l =>
        <button key={l.id} className="inventory-library" onClick={() => {set('library',l.id);setBrowse('skills');}}><BookOpen size={20}/><span><strong>{l.name}</strong><span>{l.count} {l.count === 1 ? 'Skill' : 'Skills'}</span></span><ChevronRight size={16}/></button>
      )}</div> : <div className="skills-list">{skills.map(s=>{
        const locations=matchingInstallations(s,filters);
        return <button className="skill-row" key={s.id} onClick={()=>setSelected(s)}>
          <span className="skill-symbol"><BookOpen size={20}/></span>
          <span className="skill-summary"><strong>{s.name}</strong><span className="skill-description">{s.description || 'No description in SKILL.md'}</span><span className="skill-source">{libraryOf(s).name}</span></span>
          <span className="skill-locations"><span>{[...new Set(locations.map(i=>i.deviceName))].join(' · ')}</span><span>{[...new Set(locations.map(i=>i.agent))].join(' · ')}</span><span>{locations.some(i=>i.scope==='global') ? 'Global' : ''}{locations.some(i=>i.scope==='global') && locations.some(i=>i.scope==='project') ? ' + ' : ''}{locations.some(i=>i.scope==='project') ? 'Project' : ''}{s.versions>1 ? ` · ${s.versions} versions` : ''}</span></span>
        </button>;
      })}</div>}
      {catalog.devices.length>0 && <details className="skill-report-times"><summary>Device reports</summary>{catalog.devices.map(d=><p key={d.id}>{d.name} · Last reported {new Date(d.reportedAt).toLocaleString()}</p>)}<p>Refresh loads the latest reports. Run inventory sync on a device to update its installed Skills.</p></details>}
    </div>
    {selected && <SkillReader skill={selected} initialInstallation={matchingInstallations(selected,filters)[0]!.id} onClose={()=>setSelected(null)}/>}
    {connecting && <Modal onClose={()=>setConnecting(false)}><div className="skill-connect"><h2>Connect a device or agent</h2><p>Run this on each Mac with the CENTCOM CLI connected to your shared server:</p><pre>centcom skill sync --device macbook --device-name "MacBook"</pre><p>Use a unique device ID on each machine. Global Skills and project folders under ~/Projects are discovered automatically. Repeat the command after installs or updates.</p><p>For a bot’s custom Skills folder:</p><pre>centcom skill sync --device grok-host --root /path/to/skills --agent Grok --reporter grok</pre><p>This reports the inventory and Markdown files. It does not install or overwrite Skills.</p><button className="btn" onClick={()=>setConnecting(false)}>Done</button></div></Modal>}
  </>;
}
function SkillReader({skill,initialInstallation,onClose}:{skill:CatalogSkill;initialInstallation:string;onClose:()=>void}) {
  const [installation,setInstallation]=useState(initialInstallation);
  const [doc,setDoc]=useState<SkillDocument|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{let current=true;setDoc(null);setError('');api.skillDocument(installation).then(d=>{if(current)setDoc(d);}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[installation]);
  const location=skill.installations.find(i=>i.id===installation)!;
  return <Modal onClose={onClose} width={900}><div className="skill-reader">
    <header><div><h2>{skill.name}</h2><p>{skill.versions>1 ? `${skill.versions} different file versions across installations` : libraryOf(skill).name}</p></div><button className="icon-btn" aria-label="Close Skill" onClick={onClose}><X size={18}/></button></header>
    {skill.description && <p className="inventory-reader-description">{skill.description}</p>}
    <div className="skill-reader-controls"><label>Installed copy <Select aria-label="Installed copy" value={installation} onChange={value=>setInstallation(value)}>{skill.installations.map(i=><option value={i.id} key={i.id}>{i.deviceName} · {i.agent} · {i.project?.split('/').pop() ?? 'Global'}</option>)}</Select></label>{skill.sourceUrl && <a className="btn" href={skill.sourceUrl} target="_blank" rel="noreferrer">GitHub ↗</a>}</div>
    <details className="inventory-file-details"><summary>Installation details</summary><p className="skill-path">Found on {location.deviceName} in {location.agent}’s {location.scope} Skills folder.<br/><span className="selectable">{location.path}</span><br/>Last reported {new Date(location.reportedAt).toLocaleString()}</p></details>
    <div className="skill-document selectable">{error ? <p role="alert">{error}</p> : !doc ? <p>Loading SKILL.md…</p> : <MarkdownEditor key={installation} value={doc.body} docPath="" readOnly toolbar={false} onChange={()=>{}}/>}</div>
  </div></Modal>;
}
