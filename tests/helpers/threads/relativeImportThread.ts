/** A thread that imports a TypeScript file by a relative path with the .js extension, as the real generator does. */
import { parentPort } from 'node:worker_threads';

const { VALUE } = await import('./relativeImportTarget.js');
parentPort!.postMessage({ value: VALUE });
