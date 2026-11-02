import * as Icons from './icons';

export const PROJECT_ICONS = ['Box', 'Command', 'BookOpen', 'Video', 'Palette', 'Image', 'Globe', 'Folder', 'Rocket', 'Target', 'Bolt', 'User', 'Map', 'Code', 'Bulb', 'Music', 'Camera', 'Bookmark', 'Cloud', 'Heart', 'Home', 'Briefcase', 'Users', 'Tree', 'Coffee', 'Gift', 'Star', 'Sun', 'Moon', 'Headphone', 'Microphone', 'Gamepad', 'Car', 'Airplane', 'Wallet', 'Chart', 'Shield', 'Lock', 'Database', 'Monitor', 'Mobile', 'GraduationCap', 'ShoppingBag', 'ShoppingCart', 'Compass', 'Leaf', 'Flask', 'Building'] as const;
export const PROJECT_COLORS = ['#64748b', '#3b82f6', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#a16207'];

export function ProjectIcon({ icon, color, size = 16 }: { icon?: string; color: string; size?: number }) {
  const Glyph = Icons[PROJECT_ICONS.find((name) => name === icon) ?? 'Box'];
  return <span className="project-icon" style={{ '--project-color': color } as React.CSSProperties}><Glyph size={size} /></span>;
}

export function ProjectAppearance({ icon, color, onIcon, onColor }: { icon: string; color: string; onIcon: (v: string) => void; onColor: (v: string) => void }) {
  return <div className="project-appearance">
    <fieldset><legend className="field-label">Icon</legend><div className="project-icon-options">{PROJECT_ICONS.map((name) => <button key={name} type="button" className="icon-choice" aria-label={name} aria-pressed={icon === name} onClick={() => onIcon(name)}><ProjectIcon icon={name} color={color} size={20} /></button>)}</div></fieldset>
    <fieldset><legend className="field-label">Color</legend><div className="swatches">{PROJECT_COLORS.map((value) => <button key={value} type="button" className="swatch" style={{ background: value }} aria-label={value} aria-pressed={color === value} onClick={() => onColor(value)} />)}<input type="color" aria-label="Custom project color" value={color} onChange={(e) => onColor(e.target.value)} /></div></fieldset>
  </div>;
}
