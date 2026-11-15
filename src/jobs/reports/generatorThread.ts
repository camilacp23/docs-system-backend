/**
 * Entry of the thread that writes the file of a report (`worker_threads`, inside the API process).
 *
 * It receives ONLY the data of the report (the content already read) and the options of the format, and answers with the
 * file as a transferred `ArrayBuffer` (no copy) or with the KIND of the failure. It has no database, no configuration, no
 * credentials and no logger: nothing from `src/db`, `src/config`, `src/security` or `src/http` is imported here or by the
 * generators (a test checks the imports). pdfkit and exceljs are loaded here, so the API process never loads them. The text
 * of an error never leaves the thread (it could hold a value of the documentation): only its class and a kind.
 *
 * @module jobs/reports/generatorThread
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { ReportContent } from '../../modules/reports/content.js';
import type { GeneratedFile } from './types.js';

/** What the main thread sends in `workerData`. */
export type ThreadInput = { format: 'PDF' | 'XLSX'; content: ReportContent; maxBytes: number };

/** What the thread answers: the file, or why there is none. */
export type ThreadOutput =
  | { type: 'done'; buffer: ArrayBuffer; mimeType: string; replacedCharacters: number; heapPeakMb: number }
  | { type: 'failed'; kind: 'TOO_LARGE' | 'OTHER'; errorClass: string; code?: string };

const input = workerData as ThreadInput;
let heapPeak = 0;
const sampleHeap = (): void => {
  heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
};

async function generate(): Promise<GeneratedFile> {
  const context = {
    checkpoint: sampleHeap,
    maxBytes: input.maxBytes,
    // The deadline and the stop signal are the main thread's business (it terminates this thread).
    deadlineMs: Number.POSITIVE_INFINITY,
    signal: new AbortController().signal,
  };
  if (input.format === 'PDF') return (await import('./pdf.js')).generatePdf(input.content, context);
  return (await import('./excel.js')).generateExcel(input.content, context);
}

try {
  const file = await generate();
  sampleHeap();
  const { buffer } = file;
  // Transfer the memory of the buffer itself; copy only when it is a slice of a larger (pooled) memory.
  const whole = buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength;
  const transferable = (
    whole ? buffer.buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  ) as ArrayBuffer;
  const output: ThreadOutput = {
    type: 'done',
    buffer: transferable,
    mimeType: file.mimeType,
    replacedCharacters: file.replacedCharacters,
    heapPeakMb: Math.round(heapPeak / 1_048_576),
  };
  parentPort!.postMessage(output, [transferable]);
} catch (error) {
  const errorClass = error instanceof Error ? error.name : 'NonError';
  const code = (error as { code?: unknown } | null)?.code;
  const output: ThreadOutput = {
    type: 'failed',
    kind: errorClass === 'ReportTooLargeError' ? 'TOO_LARGE' : 'OTHER',
    errorClass,
    // The `code` of an error is a fixed identifier (`ERR_…`, `ENOENT`), never a value of the documentation.
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? { code } : {}),
  };
  parentPort!.postMessage(output);
}
