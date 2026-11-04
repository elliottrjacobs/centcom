import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { META_DIR, type ActivityEvent, type ActivityType } from '../shared/types.ts';
import { isErrno } from './errors.ts';
import { atomicWrite, Mutex } from './fsutil.ts';

const ACTIVITY_TYPES: ReadonlySet<string> = new Set<ActivityType>([
  'ticket.created',
  'ticket.updated',
  'ticket.comment',
  'ticket.deleted',
  'doc.created',
  'doc.updated',
  'doc.deleted',
  'doc.moved',
  'agent.instructions_changed',
]);

/** Newest events kept in memory. Older ones stay on disk and are scanned on demand. */
const MEMORY_WINDOW = 50_000;
const FILE_PATTERN = /^\d{4}-\d{2}\.jsonl$/;

export interface ActivityQuery {
  limit?: number | undefined;
  agent?: string | undefined;
  project?: string | undefined;
  /** Any of these ticket ids (current id plus previous ids). */
  tickets?: string[] | undefined;
}

export type NewActivity = Omit<ActivityEvent, 'id' | 'ts'> & { ts?: number };

function coerceEvent(value: unknown): ActivityEvent | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.ts !== 'number' || typeof v.agent !== 'string') return null;
  if (typeof v.type !== 'string' || !ACTIVITY_TYPES.has(v.type)) return null;
  // Old logs have no device. Ignore malformed optional metadata instead of breaking clients.
  const { device, ...rest } = v;
  return { ...rest, ...(typeof device === 'string' && device.trim() && device.length <= 100 && !/[\x00-\x1f\x7f]/.test(device) ? { device: device.trim() } : {}) } as unknown as ActivityEvent;
}

function idOfLine(line: string): string | null {
  try {
    const value = JSON.parse(line) as { id?: unknown } | null;
    return typeof value?.id === 'string' ? value.id : null;
  } catch {
    return null;
  }
}

function monthFile(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
}

function matches(event: ActivityEvent, query: ActivityQuery, ticketSet: Set<string> | null): boolean {
  if (query.agent && event.agent !== query.agent) return false;
  if (query.project && (event.project ?? null) !== query.project) return false;
  if (ticketSet && !(event.ticket && ticketSet.has(event.ticket.toUpperCase()))) return false;
  return true;
}

/** Append-only JSONL log under `.centcom/activity/YYYY-MM.jsonl`; `replace` is the one exception. */
export class ActivityLog {
  private readonly dir: string;
  private readonly lock = new Mutex();
  /** Oldest → newest. */
  private events: ActivityEvent[] = [];
  /** True when the log on disk holds more than the in-memory window. */
  private truncated = false;

  constructor(
    vaultRoot: string,
    private readonly warn: (msg: string) => void,
  ) {
    this.dir = path.join(vaultRoot, META_DIR, 'activity');
  }

  private async files(): Promise<string[]> {
    try {
      return (await fs.readdir(this.dir)).filter((f) => FILE_PATTERN.test(f)).sort();
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return [];
      throw err;
    }
  }

  private async readFile(name: string): Promise<ActivityEvent[]> {
    const out: ActivityEvent[] = [];
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.dir, name), 'utf8');
    } catch (err) {
      this.warn(`Could not read activity file ${name}: ${(err as Error).message}`);
      return out;
    }
    let bad = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = coerceEvent(JSON.parse(line));
        if (event) out.push(event);
        else bad += 1;
      } catch {
        bad += 1;
      }
    }
    if (bad > 0) this.warn(`Skipped ${bad} malformed line(s) in activity file ${name}.`);
    return out;
  }

  async load(): Promise<void> {
    const files = await this.files();
    const collected: ActivityEvent[][] = [];
    let count = 0;
    this.truncated = false;
    for (let i = files.length - 1; i >= 0; i -= 1) {
      if (count >= MEMORY_WINDOW) {
        this.truncated = true;
        break;
      }
      const events = await this.readFile(files[i] as string);
      collected.unshift(events);
      count += events.length;
    }
    const all = collected.flat().sort((a, b) => a.ts - b.ts);
    if (all.length > MEMORY_WINDOW) {
      this.truncated = true;
      this.events = all.slice(all.length - MEMORY_WINDOW);
    } else {
      this.events = all;
    }
  }

  /** Append one event. Writes are serialised so lines never interleave. */
  append(input: NewActivity): Promise<ActivityEvent> {
    return this.lock.run(async () => {
      const ts = input.ts ?? Date.now();
      const event: ActivityEvent = { ...input, id: `${ts.toString(36)}-${randomBytes(5).toString('hex')}`, ts };
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(path.join(this.dir, monthFile(ts)), `${JSON.stringify(event)}\n`, 'utf8');
      this.events.push(event);
      if (this.events.length > MEMORY_WINDOW + 1000) {
        this.events.splice(0, this.events.length - MEMORY_WINDOW);
        this.truncated = true;
      }
      return event;
    });
  }

  /**
   * Rewrite one event where it lies on disk, so a comment can be corrected or taken back together
   * with anything it leaked. `update` gets the stored event and returns its replacement; `id`, `ts`
   * and `type` never change. null when no file holds `id`. Serialised with appends.
   */
  replace(id: string, update: (event: ActivityEvent) => ActivityEvent): Promise<ActivityEvent | null> {
    return this.lock.run(async () => {
      // Ids start with their timestamp in base 36, which names the month file to look in first.
      const ts = this.events.find((e) => e.id === id)?.ts ?? Number.parseInt(id.split('-')[0] ?? '', 36);
      const guess = Number.isFinite(ts) ? monthFile(ts) : null;
      const files = await this.files();
      const order = guess && files.includes(guess) ? [guess, ...files.filter((f) => f !== guess)] : files;
      for (const name of order) {
        const file = path.join(this.dir, name);
        const lines = (await fs.readFile(file, 'utf8')).split('\n');
        const index = lines.findIndex((line) => line.includes(id) && idOfLine(line) === id);
        if (index < 0) continue;
        const current = coerceEvent(JSON.parse(lines[index] as string));
        if (!current) return null;
        const next: ActivityEvent = { ...update(current), id: current.id, ts: current.ts, type: current.type };
        lines[index] = JSON.stringify(next);
        await atomicWrite(file, lines.join('\n'), { createDirs: false });
        const at = this.events.findIndex((e) => e.id === id);
        if (at >= 0) this.events[at] = next;
        return next;
      }
      return null;
    });
  }

  /** Newest first. */
  query(query: ActivityQuery): ActivityEvent[] {
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    const ticketSet = query.tickets && query.tickets.length > 0 ? new Set(query.tickets.map((t) => t.toUpperCase())) : null;
    const out: ActivityEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const event = this.events[i] as ActivityEvent;
      if (matches(event, query, ticketSet)) out.push(event);
    }
    return out;
  }

  /** Full history for one ticket (all of its ids), oldest first. Reaches past the memory window when needed. */
  async forTickets(ids: string[]): Promise<ActivityEvent[]> {
    const ticketSet = new Set(ids.map((t) => t.toUpperCase()));
    const inMemory = this.events.filter((e) => matches(e, {}, ticketSet));
    if (!this.truncated) return inMemory;
    const oldestInMemory = this.events[0]?.ts ?? Number.POSITIVE_INFINITY;
    const seen = new Set(inMemory.map((e) => e.id));
    const older: ActivityEvent[] = [];
    for (const file of await this.files()) {
      for (const event of await this.readFile(file)) {
        if (event.ts <= oldestInMemory && !seen.has(event.id) && matches(event, {}, ticketSet)) older.push(event);
      }
    }
    return [...older, ...inMemory].sort((a, b) => a.ts - b.ts);
  }

  /** Resolves once every queued append has hit the disk. */
  async flush(): Promise<void> {
    await this.lock.run(() => undefined);
  }
}
