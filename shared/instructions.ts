export interface InstructionEntry {
  name: 'AGENTS.md' | 'CLAUDE.md';
  agent: string;
  scope: 'global' | 'project';
  project: string | null;
  projectKey: string | null;
  relativePath: string;
  path: string;
  markdown: string;
}
export interface InstructionReport { deviceId: string; deviceName: string; reporter: string; entries: InstructionEntry[] }
export interface InstructionCopy extends Omit<InstructionEntry, 'markdown'> {
  id: string; deviceId: string; deviceName: string; reporter: string; reportedAt: number; hash: string;
}
export interface CatalogInstruction {
  id: string; name: string; agent: string; scope: 'global' | 'project'; project: string | null;
  relativePath: string; versions: number; copies: InstructionCopy[];
}
export interface InstructionCatalog { files: CatalogInstruction[]; devices: { id: string; name: string; reportedAt: number }[] }
export interface InstructionDocument { markdown: string; body: string }
export interface InstructionFilters { query?: string; device?: string; agent?: string; scope?: string; project?: string }
export function matchingCopies(file: CatalogInstruction, f: InstructionFilters) {
  return file.copies.filter(c => (!f.device || c.deviceId === f.device) && (!f.agent || c.agent === f.agent) && (!f.scope || c.scope === f.scope) && (!f.project || c.project === f.project));
}
export function filterInstructions(files: CatalogInstruction[], f: InstructionFilters) {
  const q = f.query?.trim().toLowerCase();
  return files.filter(file => matchingCopies(file,f).length > 0 && (!q || `${file.name} ${file.agent} ${file.project ?? ''} ${file.relativePath}`.toLowerCase().includes(q)));
}

export type InstructionSort = 'name' | 'recent';
export interface InstructionGroup { id:string; title:string; location:string; scope:'global'|'project'; files:CatalogInstruction[]; reportedAt:number }
export function instructionContext(file:CatalogInstruction):string {
  const folder=file.relativePath.split('/').slice(0,-1).join('/');
  const tool=file.agent==='Shared' ? 'Shared agents' : file.agent;
  return file.scope==='global' || !folder || ['.claude','.codex','.agents'].includes(folder) ? tool : `${folder} · ${tool}`;
}
export function groupInstructions(files:CatalogInstruction[],sort:InstructionSort='name'):InstructionGroup[] {
  const groups=new Map<string,InstructionGroup>();
  for(const file of files){
    const c=file.copies[0]!;
    const id=file.scope==='global'?'global':c.projectKey ?? `project:${file.project}`;
    let group=groups.get(id);
    if(!group){
      const root=c.path.endsWith(file.relativePath)?c.path.slice(0,-file.relativePath.length).replace(/\/$/,''):'';
      const location=root.replace(/^\/(?:Users|home)\/[^/]+/,'~');
      group={id,title:file.scope==='global'?'Global instructions':file.project ?? 'Project',location:file.scope==='global'?'Defaults used across your projects':location,scope:file.scope,files:[],reportedAt:0};groups.set(id,group);
    }
    group.files.push(file);group.reportedAt=Math.max(group.reportedAt,...file.copies.map(c=>c.reportedAt));
  }
  for(const group of groups.values())group.files.sort((a,b)=>instructionContext(a).localeCompare(instructionContext(b))||a.name.localeCompare(b.name));
  return [...groups.values()].sort((a,b)=>a.scope!==b.scope?(a.scope==='global'?-1:1):sort==='recent'?b.reportedAt-a.reportedAt||a.title.localeCompare(b.title):a.title.localeCompare(b.title));
}
