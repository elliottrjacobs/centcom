export interface SkillReportEntry {
  name: string;
  description: string;
  agent: string;
  scope: 'global' | 'project';
  project: string | null;
  path: string;
  sourceUrl: string | null;
  markdown: string;
}
export interface SkillReport {
  deviceId: string;
  deviceName: string;
  reporter: string;
  entries: SkillReportEntry[];
}
export interface SkillInstallation extends Omit<SkillReportEntry, 'name' | 'description' | 'markdown'> {
  id: string;
  deviceId: string;
  deviceName: string;
  reporter: string;
  reportedAt: number;
  hash: string;
}
export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  sourceUrl: string | null;
  library?: SkillLibrary;
  versions: number;
  installations: SkillInstallation[];
}
export interface SkillCatalog {
  skills: CatalogSkill[];
  devices: { id: string; name: string; reportedAt: number }[];
}
export interface SkillDocument { markdown: string; body: string; frontmatter: Record<string, unknown> }
export interface SkillFilters { device?: string; agent?: string; scope?: string; project?: string; library?: string; query?: string }
export function matchingInstallations(skill: CatalogSkill, filters: SkillFilters) {
  return skill.installations.filter(i => (!filters.device || i.deviceId === filters.device) &&
    (!filters.agent || i.agent === filters.agent) && (!filters.scope || i.scope === filters.scope) &&
    (!filters.project || i.project === filters.project));
}
export function filterSkills(skills: CatalogSkill[], filters: SkillFilters) {
  const query = (filters.query ?? '').trim().toLowerCase();
  return skills.filter(s => (!filters.library || libraryOf(s).id === filters.library) && matchingInstallations(s, filters).length > 0 &&
    (!query || `${s.name} ${s.description} ${s.sourceUrl ?? ''} ${libraryOf(s).name}`.toLowerCase().includes(query)));
}

export interface SkillLibrary { id: string; name: string }
/** The owner's own provenance knowledge (the server loads it from `skill-sources.json`). */
export interface SkillSources {
  /** Lowercased GitHub repository URL → the collection's label. */
  libraries: Record<string, SkillLibrary>;
  /** SHA-256 of an exact SKILL.md → the repository it was verified against. */
  verified: Record<string, string>;
  /** Plugin package id → display name. */
  pluginNames: Record<string, string>;
}
/** Libraries describe collections; they never supply unverified repository links. */
export function skillLibrary(skill: Pick<CatalogSkill, 'name' | 'sourceUrl' | 'installations'>, sources: Pick<SkillSources, 'libraries' | 'pluginNames'> = { libraries: {}, pluginNames: {} }): SkillLibrary {
  if (skill.sourceUrl) {
    const known = sources.libraries[skill.sourceUrl.toLowerCase()];
    if (known) return { ...known };
    const repo = skill.sourceUrl.replace('https://github.com/', '');
    return { id: `repo:${repo}`, name: repo };
  }
  const packages = [...new Set(skill.installations.flatMap(i => {
    const match = i.path.match(/\/plugins\/cache\/[^/]+\/([^/]+)\//);
    return match ? [match[1]!] : [];
  }))];
  if (packages.length === 1) return { id: `plugin:${packages[0]}`, name: sources.pluginNames[packages[0]!] ?? packages[0]! };
  return { id: 'local', name: 'Other local Skills' };
}
/** What the server decided (it knows the owner's sources); recomputed only for a catalog that predates `library`. */
export const libraryOf = (skill: Pick<CatalogSkill, 'name' | 'sourceUrl' | 'installations' | 'library'>): SkillLibrary => skill.library ?? skillLibrary(skill);
