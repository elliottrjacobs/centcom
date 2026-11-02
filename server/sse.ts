import type { ServerEvent } from '../shared/types.ts';

const HEARTBEAT_MS = 25_000;
const encoder = new TextEncoder();

interface Client {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
}

/** Fan-out of `ServerEvent`s to every connected `/api/events` stream. */
export class EventHub {
  private readonly clients = new Set<Client>();
  private closed = false;

  get size(): number {
    return this.clients.size;
  }

  /** A fresh SSE body. The stream unregisters itself when the client goes away. */
  stream(): ReadableStream<Uint8Array> {
    let client: Client | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (this.closed) {
          controller.close();
          return;
        }
        const heartbeat = setInterval(() => this.write(current, ': ping\n\n'), HEARTBEAT_MS);
        heartbeat.unref?.();
        const current: Client = { controller, heartbeat };
        client = current;
        this.clients.add(current);
        // Flushes headers immediately and tells EventSource how long to wait before reconnecting.
        this.write(current, 'retry: 2000\n: connected\n\n');
      },
      cancel: () => {
        if (client) this.drop(client);
      },
    });
  }

  broadcast(event: ServerEvent): void {
    if (this.clients.size === 0) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of [...this.clients]) this.write(client, frame);
  }

  closeAll(): void {
    this.closed = true;
    for (const client of [...this.clients]) {
      this.drop(client);
      try {
        client.controller.close();
      } catch {
        /* already closed */
      }
    }
  }

  private write(client: Client, text: string): void {
    try {
      client.controller.enqueue(encoder.encode(text));
    } catch {
      this.drop(client);
    }
  }

  private drop(client: Client): void {
    clearInterval(client.heartbeat);
    this.clients.delete(client);
  }
}
