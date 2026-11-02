import type { MouseEvent } from 'react';
import { rawUrl } from './api';
import { copyText } from './clipboard';
import { getState } from './store';
import { toast } from '../ui/overlays';

export const isImageName = (name: string) => /\.(png|jpe?g|gif|webp|avif|svg|heic|bmp|tiff?)$/i.test(name);

export async function copyPath(path: string) {
  const vault = getState().info?.vault;
  const full = vault ? `${vault}/${path}` : path;
  try {
    await copyText(full);
    toast('Path copied');
  } catch {
    toast(full);
  }
}

/**
 * Link props that open a vault file the app has no viewer for. The desktop app on the vault's
 * own machine hands it to its default app; anywhere else it opens raw in a new window (Electron
 * sends that to the browser), where it can be viewed or downloaded.
 */
export function openFileProps(path: string, mtime?: number) {
  return {
    href: rawUrl(path, mtime),
    target: '_blank',
    rel: 'noopener noreferrer',
    onClick: (e: MouseEvent) => {
      if (!window.centcom || getState().info?.remote) return;
      e.preventDefault();
      window.centcom.open(path);
    },
  };
}

/** Link props for a web URL: always outside the app (Electron opens it in the browser). */
export const externalLinkProps = (url: string) => ({ href: url, target: '_blank', rel: 'noopener noreferrer' });
