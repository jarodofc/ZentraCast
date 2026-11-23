import { parseM3U8 } from '../iptv/m3u';
import type { Channel } from '../types';

type Request = { id: number; text: string };
type Response = { id: number; channels?: Channel[]; error?: string };

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const { id, text } = event.data;
  try {
    const response: Response = { id, channels: parseM3U8(text) };
    self.postMessage(response);
  } catch (error) {
    const response: Response = { id, error: error instanceof Error ? error.message : String(error) };
    self.postMessage(response);
  }
});
