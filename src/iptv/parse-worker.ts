import { parseM3U8 } from './m3u';
import type { Channel } from '../types';

type Request = { id: number; text: string };
type Response = { id: number; channels?: Channel[]; error?: string };

const WORKER_THRESHOLD = 250_000;
const WORKER_TIMEOUT_MS = 25000;
const pending = new Map<number, {
  resolve: (channels: Channel[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();
let worker: Worker | null = null;
let counter = 0;

function stopBrokenWorker(error: Error): void {
  worker?.terminate();
  worker = null;
  for (const task of pending.values()) {
    clearTimeout(task.timeout);
    task.reject(error);
  }
  pending.clear();
}
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/m3u.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<Response>) => {
    const task = pending.get(event.data.id);
    if (!task) return;
    pending.delete(event.data.id);
    clearTimeout(task.timeout);
    if (event.data.error || !event.data.channels) {
      task.reject(new Error(event.data.error || 'Worker sem resultado'));
    } else {
      task.resolve(event.data.channels);
    }
  });
  worker.addEventListener('error', () => stopBrokenWorker(new Error('Worker M3U indisponível')));
  return worker;
}
function markDirectIps(channels: Channel[], callback?: (host: string) => void): void {
  if (!callback) return;
  const visited = new Set<string>();
  for (const ch of channels) {
    if (!ch.host || visited.has(ch.host)) continue;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ch.host) || ch.host.includes(':')) {
      visited.add(ch.host);
      callback(ch.host);
    }
  }
}

/** Mantém catálogos pequenos síncronos; grandes são analisados em Web Worker. */
export async function parseM3UAsync(text: string, onDirectIp?: (host: string) => void): Promise<Channel[]> {
  if (text.length < WORKER_THRESHOLD || typeof Worker === 'undefined') {
    return parseM3U8(text, onDirectIp);
  }
  try {
    const instance = getWorker();
    const id = ++counter;
    const parsed = await new Promise<Channel[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Timeout do Worker M3U'));
      }, WORKER_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      const request: Request = { id, text };
      instance.postMessage(request);
    });
    markDirectIps(parsed, onDirectIp);
    return parsed;
  } catch (error) {
    console.info('Worker M3U indisponível; usando parser local:', error);
    return parseM3U8(text, onDirectIp);
  }
}
