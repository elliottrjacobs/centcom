import { invalid } from './errors.ts';

/** Caller-reported execution location. Never infer this from the server host or agent id. */
export function reportedDevice(input: unknown): { device?: string } {
  if (input === undefined) return {};
  if (typeof input !== 'string') throw invalid('device must be a device name, such as "Mac mini".');
  const device = input.trim();
  if (!device || device.length > 100 || /[\x00-\x1f\x7f]/.test(device)) throw invalid('device must contain 1–100 characters without control characters.');
  return { device };
}
