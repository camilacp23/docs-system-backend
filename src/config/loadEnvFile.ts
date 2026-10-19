/**
 * Loads `.env` into `process.env` when the file exists (Node's built-in loader; real environment variables win).
 * Import this module FIRST in an entry point: `src/security/config.ts` reads the environment when it is imported.
 *
 * @module config/loadEnvFile
 */
import { existsSync } from 'node:fs';

/**
 * Loads the given env file if present.
 *
 * @param path - File to load (default `.env` in the working directory).
 */
export function loadEnvFile(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

loadEnvFile();
