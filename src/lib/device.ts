/** This browser's explicit name; the shared server cannot identify its clients' hardware. */
export function currentDevice(): string | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('centcom.deviceName') ?? 'null');
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch { return undefined; }
}
