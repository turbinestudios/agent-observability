import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BackgroundController } from './controller';
import type { BackgroundWorker } from './protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeWorker extends EventEmitter implements BackgroundWorker {
  readonly stopped = deferred<number>();
  terminate = vi.fn(() => this.stopped.promise);
  finish(): void {
    this.emit('message', { type: 'done' });
    this.emit('exit', 0);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const onMessage = vi.fn();
  const onError = vi.fn();
  const spawn = vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const controller = new BackgroundController({ spawn, onMessage, onError, onStart: vi.fn(), onStopped: vi.fn() });
  return { controller, workers, spawn, onMessage, onError };
}

describe('background scheduling', () => {
  it('returns immediately and coalesces refresh storms into one follow-up', () => {
    const { controller, workers, spawn } = setup();
    controller.request();
    for (let i = 0; i < 50; i++) { controller.request(); }
    expect(spawn).toHaveBeenCalledTimes(1);
    workers[0].finish();
    expect(spawn).toHaveBeenCalledTimes(2);
    workers[1].finish();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('waits for worker termination before a destructive mutation and ignores late events', async () => {
    const { controller, workers, spawn, onMessage } = setup();
    controller.request();
    const mutate = vi.fn();
    const pending = controller.exclusive(mutate);
    await Promise.resolve();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    controller.request();
    workers[0].emit('message', { type: 'rows', keys: ['claude:deleted'] });
    workers[0].emit('exit', 1);
    expect(onMessage).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    workers[0].stopped.resolve(1);
    await pending;
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    workers[1].finish();
  });

  it('serializes settings/delete/rebuild mutations and restarts with the latest snapshot', async () => {
    const { controller, workers, spawn } = setup();
    const order: string[] = [];
    controller.request();
    const first = controller.exclusive(() => order.push('settings'));
    const second = controller.exclusive(() => order.push('delete'));
    const third = controller.exclusive(() => order.push('rebuild'));
    await Promise.resolve();
    workers[0].stopped.resolve(1);
    await Promise.all([first, second, third]);
    expect(order).toEqual(['settings', 'delete', 'rebuild']);
    expect(spawn).toHaveBeenCalledTimes(2);
    workers[1].finish();
  });

  it('does not wedge the mutation queue when an operation fails', async () => {
    const { controller, workers } = setup();
    const first = controller.exclusive(() => { throw new Error('bad setting'); });
    const second = controller.exclusive(() => 42);
    await expect(first).rejects.toThrow('bad setting');
    await expect(second).resolves.toBe(42);
    expect(workers).toHaveLength(1);
    workers[0].finish();
  });

  it('fails closed if termination fails instead of starting another writer', async () => {
    const { controller, workers, spawn, onError } = setup();
    controller.request();
    const mutate = vi.fn();
    const pending = controller.exclusive(mutate);
    await Promise.resolve();
    workers[0].stopped.reject(new Error('cannot terminate'));
    await expect(pending).rejects.toThrow('cannot terminate');
    controller.request();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports worker crashes without respawning in a loop, and Refresh retries', () => {
    const { controller, workers, spawn, onError } = setup();
    controller.request();
    controller.request();
    workers[0].emit('error', new Error('parse failure'));
    workers[0].emit('exit', 1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    controller.request();
    expect(spawn).toHaveBeenCalledTimes(2);
    workers[1].finish();
  });

  it('reports exits without a completion message, even with exit code zero', () => {
    const { controller, workers, onError } = setup();
    controller.request();
    workers[0].emit('exit', 0);
    expect(onError.mock.calls[0][0].message).toContain('unexpectedly');
  });

  it('contains failures while handling a worker notification', () => {
    const { controller, workers, onMessage, onError } = setup();
    onMessage.mockImplementation(() => { throw new Error('index read failed'); });
    controller.request();
    expect(() => workers[0].emit('message', { type: 'rows', keys: [] })).not.toThrow();
    workers[0].emit('message', { type: 'rows', keys: [] });
    workers[0].finish();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports spawn failure without breaking interactive callers', () => {
    const { controller, spawn, onError } = setup();
    spawn.mockImplementationOnce(() => { throw new Error('missing worker bundle'); });
    expect(() => controller.request()).not.toThrow();
    expect(onError.mock.calls[0][0].message).toBe('missing worker bundle');
  });

  it('disposal waits for the current writer and never restarts queued work', async () => {
    const { controller, workers, spawn } = setup();
    controller.request();
    controller.request();
    const closed = controller.dispose();
    workers[0].stopped.resolve(1);
    await closed;
    workers[0].finish();
    controller.request();
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(controller.exclusive(() => undefined)).rejects.toThrow('closed');
  });
});