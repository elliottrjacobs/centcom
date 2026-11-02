import { useStore } from '../lib/store';
import { href } from '../lib/router';
import { ViewHeader } from '../shell/ViewHeader';
import { Box } from '../ui/icons';
export function ProjectsView() {
  const projects=useStore(s=>s.projects);
  return <><ViewHeader crumbs={[{label:'Projects',icon:<Box size={15}/>}]}><button className="btn" onClick={()=>window.dispatchEvent(new CustomEvent('centcom:new-project'))}>New project</button></ViewHeader><div className="view-body skills-page"><header className="skills-heading"><div><h1>Projects</h1><p>Your shared workspaces.</p></div></header>{projects.map(p=><a className="skill-row" key={p.slug} href={href({name:'project',slug:p.slug,tab:'overview'})}><Box size={20}/><span className="skill-summary"><strong>{p.name}</strong><span className="skill-description">{p.summary}</span></span></a>)}</div></>;
}
