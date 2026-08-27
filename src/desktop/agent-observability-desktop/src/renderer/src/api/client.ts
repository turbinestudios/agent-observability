import type {
  RpcEvent,
  RpcEventName,
  RpcMethodName,
  RpcMethods,
  RpcResponse,
} from '../../../shared/rpc';

/**
 * Promise-shaped client over the data-host MessagePort.
 *
 * Requests are correlated by id, so many can be in flight at once — nothing
 * here serializes on the previous call. Unsolicited events (index progress,
 * upserted rows) are dispatched to subscribers rather than resolving requests.
 */

type Handler = (event: RpcEvent) => void;

declare global {
  interface Window {
    desktop: {
      requestDataHostPort(): void;
      onDataHostPort(handler: (port: MessagePort) => void): void;
      openExternal(url: string): Promise<void>;
      openPath(path: string): Promise<string>;
      showItem(path: string): Promise<void>;
      getVersion(): Promise<string>;
    };
  }
}

class DataHostClient {
  private port: MessagePort | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<RpcEventName, Set<Handler>>();
  /** Calls made before the port arrives, replayed once it does. */
  private readonly queued: (() => void)[] = [];
  private ready = false;

  constructor() {
    window.desktop.onDataHostPort((port) => this.bind(port));
    window.desktop.requestDataHostPort();
  }

  private bind(port: MessagePort): void {
    this.port = port;
    port.onmessage = (event: MessageEvent) => {
      const data = event.data as RpcResponse | RpcEvent;
      if ('event' in data) {
        for (const handler of this.handlers.get(data.event) ?? []) {
          handler(data);
        }
        return;
      }
      const entry = this.pending.get(data.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(data.id);
      if (data.ok) {
        entry.resolve(data.value);
      } else {
        entry.reject(new Error(data.error));
      }
    };
    port.start();
    this.ready = true;
    for (const send of this.queued.splice(0)) {
      send();
    }
  }

  call<K extends RpcMethodName>(
    method: K,
    ...params: Parameters<RpcMethods[K]>
  ): Promise<ReturnType<RpcMethods[K]>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const send = () => this.port?.postMessage({ id, method, params });
      if (this.ready) {
        send();
      } else {
        this.queued.push(send);
      }
    });
  }

  /** Subscribe to a push event; returns an unsubscribe function. */
  on(event: RpcEventName, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }
}

export const dataHost = new DataHostClient();
