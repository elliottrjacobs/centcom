import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveConfigDir } from '../server/config.ts';
import { atomicWrite } from '../server/fsutil.ts';
import { localInstructionReport } from './instruction-inventory.ts';
import type { InstructionReport } from '../shared/instructions.ts';

const sourceSchema = z.object({
  deviceId: z.string().trim().min(1),
  deviceName: z.string().trim().min(1),
  projects: z.array(z.string().min(1)).optional(),
});
type Source = z.infer<typeof sourceSchema>;
const sourceFile = (configDir?: string) => path.join(resolveConfigDir(configDir), 'instruction-source.json');

export async function readInstructionSource(configDir?: string): Promise<Partial<Source>> {
  try {
    return sourceSchema.parse(JSON.parse(await fs.readFile(sourceFile(configDir), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Remember only a successful local default report, never caller-supplied report-file paths. */
export async function rememberInstructionSource(report: InstructionReport, projects?: string[], configDir?: string) {
  const source = sourceSchema.parse({ deviceId: report.deviceId, deviceName: report.deviceName, projects });
  await atomicWrite(sourceFile(configDir), JSON.stringify(source));
}

/** The desktop accepts no paths from the renderer; roots come from local CLI settings. */
export async function desktopInstructionReport(configDir?: string, home?: string) {
  return localInstructionReport({ ...await readInstructionSource(configDir), reporter: 'centcom-cli', home });
}
