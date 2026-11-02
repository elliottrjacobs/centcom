import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only surface the page gets. Narrow actions re-validated in the main
 * process; no fs, no shell, no generic IPC passthrough or clipboard read access.
 */
contextBridge.exposeInMainWorld('centcom', {
  isElectron: true,
  platform: process.platform,
  scanInstructions: () => ipcRenderer.invoke('centcom:scan-instructions'),
  reveal: (path: string) => ipcRenderer.send('centcom:reveal', String(path)),
  open: (path: string) => ipcRenderer.send('centcom:open', String(path)),
  openVault: () => ipcRenderer.send('centcom:open-vault'),
  copyServerToken: () => ipcRenderer.invoke('centcom:copy-server-token'),
  copyText: (text: string) => ipcRenderer.invoke('centcom:copy-text', text),
  onboarding: () => ipcRenderer.invoke('centcom:onboarding'),
  finishOnboarding: () => ipcRenderer.invoke('centcom:onboarding-done'),
  loginItem: (enable?: boolean) => ipcRenderer.invoke('centcom:login-item', typeof enable === 'boolean' ? enable : undefined),
});
