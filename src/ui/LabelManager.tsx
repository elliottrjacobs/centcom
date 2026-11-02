import { useState } from 'react';
import type { ProjectLabel } from '@shared/types';
import { api } from '../lib/api';
import { refreshLabels, refreshTickets, useStore } from '../lib/store';
import { Modal, confirm, toastError } from './overlays';
export function LabelManager({project,onClose}:{project:string|null;onClose:()=>void}) {
 const catalog = useStore(s=>s.labels);
 const [selected,setSelected] = useState<ProjectLabel|null>(null);
 const [name,setName] = useState(''); const [color,setColor] = useState('#64748b');
 const [busy,setBusy] = useState(false); const [archived,setArchived] = useState(false);
 const labels = catalog.filter(l=>l.project===project && l.deleted===archived);
 const run = async (action:()=>Promise<unknown>) => {setBusy(true);try{await action();await Promise.all([refreshLabels(),refreshTickets()]);setSelected(null);setName('');}catch(e){toastError(e);}finally{setBusy(false);}};
 return <Modal onClose={onClose} width={540}><div className="label-manager">
  <div className="section-head"><h2>Labels · {project ?? 'Inbox'}</h2><button className="btn" onClick={onClose}>Done</button></div>
  <p className="quiet">Labels belong to this project. Renaming updates its tasks; deleting removes the label from them.</p>
  <form className="label-edit" onSubmit={e=>{e.preventDefault();void run(()=>selected ? api.updateLabel(selected,{name:name.trim(),color}) : api.createLabel(project,name.trim(),color));}}>
   <input aria-label="Label name" placeholder="Label name" maxLength={60} value={name} onChange={e=>setName(e.target.value)} />
   <input type="color" aria-label="Label color" value={color} onChange={e=>setColor(e.target.value)} />
   <button className="btn btn-primary" disabled={busy || !name.trim()}>{selected?'Save':'Create'}</button>
   {selected && <button type="button" className="btn" onClick={()=>{setSelected(null);setName('');}}>Cancel</button>}
  </form>
  <button className="btn btn-ghost" onClick={()=>setArchived(!archived)}>{archived?'Show active labels':'Deleted labels'}</button>
  <div className="label-manager-list">{labels.length===0 && <p className="quiet">{archived?'No deleted labels.':'Create the first label for this project.'}</p>}{labels.map(l=><div className="label-manager-row" key={l.id}>
   <span className="pill-dot" style={{background:l.color}}/><span>{l.name}</span><span className="header-spacer"/>
   {archived ? <button className="btn" disabled={busy} onClick={()=>void run(()=>api.updateLabel(l,{deleted:false}))}>Restore</button> : <>
   <button className="btn" disabled={busy} onClick={()=>{setSelected(l);setName(l.name);setColor(l.color);}}>Edit</button>
   <button className="btn" disabled={busy} onClick={async()=>{if(await confirm({title:`Delete “${l.name}”?`,body:'Remove it from this project’s tasks. You can restore the label from Deleted labels; task assignments are not restored.',confirmLabel:'Delete label',danger:true}))void run(()=>api.updateLabel(l,{deleted:true}));}}>Delete</button></>}
  </div>)}</div>
 </div></Modal>;
}
