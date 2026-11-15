/** A generator thread that reports the names of the environment variables it can see, as the "file" it returns. */
import { parentPort } from 'node:worker_threads';

const bytes = new TextEncoder().encode(JSON.stringify(Object.keys(process.env).sort()));
parentPort!.postMessage(
  { type: 'done', buffer: bytes.buffer, mimeType: 'application/json', replacedCharacters: 0, heapPeakMb: 0 },
  [bytes.buffer],
);
