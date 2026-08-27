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

/** How long to wait for the data-host handshake before reporting it failed. */
const CONNECT_TIMEOUT_MS = 10_000;

declare global {
  interface Window {
    desktop: {
      requestDataHostPort(): void;
      dataHostPortMessage: string;
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
  private failure: Error | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    if (window.desktop === undefined) {
      // The preload bridge is the only path to the data host; without it the
      // app can only show an empty list forever, so say so loudly.
      this.fail('The app could not reach its data process (preload did not load).');
      return;
    }

    // The port is transferred into this world by preload rather than passed
    // through contextBridge, which would strip it to a non-functional proxy.
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window || this.port !== undefined) {
        return;
      }
      if ((event.data as { type?: string })?.type !== window.desktop.dataHostPortMessage) {
        return;
      }
      const [port] = event.ports;
      if (port !== undefined) {
        this.bind(port);
      }
    });

    window.desktop.requestDataHostPort();

    // A handshake that never completes would otherwise leave the UI showing a
    // progress state forever, which reads as "broken" with no explanation.
    this.connectTimer = setTimeout(() => {
      if (this.port === undefined) {
        this.fail('The app could not reach its data process. Restarting usually fixes it.');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  /** Reject everything queued and waiting, and remember why. */
  private fail(message: string): void {
    this.failure = new Error(message);
    for (const entry of this.pending.values()) {
      entry.reject(this.failure);
    }
    this.pending.clear();
    this.queued.length = 0;
    for (const handler of this.handlers.get('index.progress') ?? []) {
      handler({ event: 'index.progress', status: { indexed: 0, total: 0, phase: 'error', message } });
    }
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
    console.log(`[client] connected to data host (${this.queued.length} queued call(s))`);
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    for (const send of this.queued.splice(0)) {
      send();
    }
  }

  call<K extends RpcMethodName>(
    method: K,
    ...params: Parameters<RpcMethods[K]>
  ): Promise<ReturnType<RpcMethods[K]>> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
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
