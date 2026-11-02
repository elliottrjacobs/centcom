/** Copy in Electron, secure browsers, and browsers without the Clipboard API. */
export async function copyText(text: string): Promise<void> {
  if (window.centcom?.copyText) {
    await window.centcom.copyText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some embedded browsers expose the API but deny clipboard permission.
    }
  }
  const previous = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable. Select the text and copy it manually.');
  } finally {
    field.remove();
    previous?.focus({ preventScroll: true });
  }
}
