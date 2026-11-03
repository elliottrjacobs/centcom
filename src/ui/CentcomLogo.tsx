import artwork from '../assets/centcom-logo.png';

/** Preserve the radar artwork's cyan light and glossy black backing in either appearance. */
export function CentcomLogo({ size, className }: { size: number; className?: string }) {
  return (
    <img src={artwork} width={size} height={size} className={className}
      style={{ borderRadius: '22%', objectFit: 'contain' }} alt="" aria-hidden="true" draggable={false} />
  );
}
