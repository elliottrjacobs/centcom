import { useState } from 'react';
import { defaultNavigation, normalizeNavigation, movePage, type PageId } from '../lib/navigation';
import { usePersisted } from '../lib/usePersisted';
import { href,useRoute } from '../lib/router';
import { Activity, BookOpen, Box, Document, ChevronDown, Bot, Inbox, Search, Settings, Ticket, Trash, X } from '../ui/icons';
import { Modal,Popover,usePopover } from '../ui/overlays';
export const pages = {
  projects:{label:'Projects',icon:Box},
  tickets:{label:'All tasks',icon:Ticket},inbox:{label:'Inbox',icon:Inbox},activity:{label:'Activity',icon:Activity},
  agents:{label:'Agents',icon:Bot},skills:{label:'Skills',icon:BookOpen},instructions:{label:'Instructions',icon:Document},settings:{label:'Settings',icon:Settings},trash:{label:'Trash',icon:Trash},
};
export function useNavigationPreferences() {
  const [raw,set] = usePersisted('navigation.v1',defaultNavigation);
  return [normalizeNavigation(raw),set] as const;
}
export function PageMenu({onSearch, sidebar = false}:{onSearch:()=>void; sidebar?:boolean}) {
  const route=useRoute();const pop=usePopover();const [customize,setCustomize]=useState(false);
  const [prefs,setPrefs]=useNavigationPreferences();const [drag,setDrag]=useState<PageId|null>(null);
  const visible=prefs.order.filter(id=>!prefs.hidden.includes(id));
  const move=(id:PageId,target:PageId)=>setPrefs({...prefs,order:movePage(prefs.order,id,target)});
  return <>
    <button className={sidebar ? "icon-btn sidebar-customize" : "page-menu-trigger"} aria-label={sidebar ? "Customize sidebar" : "Open page menu"} aria-expanded={!!pop.anchor} onClick={e=>sidebar?setCustomize(true):pop.anchor?pop.close():pop.open(e.currentTarget)}>{sidebar ? <Settings size={13}/> : <>CENTCOM <ChevronDown size={14}/></>}</button>
    {pop.anchor && <Popover anchor={pop.anchor} onClose={pop.close} width={260} className="page-menu"><header><span>CENTCOM</span><button className="icon-btn" aria-label="Customize navigation" onClick={()=>{pop.close();setCustomize(true);}}><Settings size={16}/></button></header><nav>{visible.map(id=>{const p=pages[id];return <a className="nav-row" key={id} href={href({name:id})} data-active={route.name===id} onClick={pop.close}><p.icon size={17}/>{p.label}</a>;})}<button className="nav-row" onClick={()=>{pop.close();onSearch();}}><Search size={17}/>Search</button></nav></Popover>}
    {customize && <Modal onClose={()=>setCustomize(false)} width={460}><div className="nav-customize"><header><h2>Customize</h2><button className="icon-btn" aria-label="Close customization" onClick={()=>setCustomize(false)}><X size={18}/></button></header><p>Drag to reorder pages. Hide the ones you don’t need. Settings and Trash stay in the sidebar footer.</p><div>{prefs.order.map((id,index)=>{const p=pages[id];const hidden=prefs.hidden.includes(id);return <div className="nav-config-row" key={id} draggable onDragStart={()=>setDrag(id)} onDragEnd={()=>setDrag(null)} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(drag)move(drag,id);setDrag(null);}}><span className="drag-handle" aria-hidden>⠿</span><p.icon size={16}/><span>{p.label}</span><button className="icon-btn" aria-label={`Move ${p.label} up`} disabled={index===0} onClick={()=>move(id,prefs.order[index-1]!)}>↑</button><button className="icon-btn" aria-label={`Move ${p.label} down`} disabled={index===prefs.order.length-1} onClick={()=>move(id,prefs.order[index+1]!)}>↓</button><button className="btn" aria-pressed={!hidden} onClick={()=>setPrefs({...prefs,hidden:hidden?prefs.hidden.filter(p=>p!==id):[...prefs.hidden,id]})}>{hidden?'Show':'Hide'}</button></div>;})}</div><footer><button className="btn" onClick={()=>setPrefs(defaultNavigation)}>Reset to default</button><button className="btn" onClick={()=>setCustomize(false)}>Done</button></footer></div></Modal>}
  </>;
}
