/// <reference types="vite/client" />

/** Bridge exposed by the Electron preload. Absent when the UI runs in a plain browser. */
interface CentcomBridge {
  isElectron: true;
  platform: string;
  /** Scan this device's configured instruction roots. No renderer-supplied paths. */
  scanInstructions?(): Promise<import('@shared/instructions').InstructionReport>;
  /** Show a vault-relative path in Finder. */
  reveal(path: string): void;
  /** Open a vault file in its default app. Refuses anything the OS would run rather than view. */
  open(path: string): void;
  /** Open the vault folder itself. */
  openVault(): void;
  /** Write text to the native clipboard; clipboard reads are not exposed. */
  copyServerToken?(): Promise<void>;
  copyText(text: string): Promise<void>;
  /** First run only: where the vault is and the owner token, once. `show: false` every other time. */
  onboarding?(): Promise<{ show: false } | { show: true; vault: string; token: string | null; docs: string | null }>;
  finishOnboarding?(): Promise<void>;
  /** Read (no argument) or set whether the app opens at login. Unsupported outside the packaged app. */
  loginItem?(enable?: boolean): Promise<{ supported: boolean; enabled: boolean }>;
}

interface Window {
  centcom?: CentcomBridge;
}
