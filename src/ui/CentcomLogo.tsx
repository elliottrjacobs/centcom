import { useId } from 'react';
import artwork from '../assets/centcom-logo.png';

/** Use the original artwork's ink as a mask, leaving its white paper transparent. */
export function CentcomLogo({ size, className }: { size: number; className?: string }) {
  const id = useId();
  const ink = `${id}-ink`;
  const mask = `${id}-mask`;
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" className={className} aria-hidden="true" focusable="false">
      <defs>
        <filter id={ink} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -0.2126 -0.7152 -0.0722 0 1" />
        </filter>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256" style={{ maskType: 'alpha' }}>
          <image href={artwork} width="256" height="256" filter={`url(#${ink})`} />
        </mask>
      </defs>
      <rect width="256" height="256" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}
