/** A generator thread that reports the flags it started with, as the "file" it returns. */
import { parentPort } from 'node:worker_threads';

const bytes = new TextEncoder().encode(JSON.stringify(process.execArgv));
parentPort!.postMessage(
  { type: 'done', buffer: bytes.buffer, mimeType: 'application/json', replacedCharacters: 0, heapPeakMb: 0 },
  [bytes.buffer],
);
