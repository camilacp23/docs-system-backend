/**
 * Copies the `.sql` files that live next to the compiled code (for example the dependency graph query) from `src/`
 * to `dist/`, because `tsc` only emits JavaScript. Runs after the compiler in `npm run build`. Plain Node (no `cp`),
 * so it behaves the same on Windows and Ubuntu.
 */
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src');
const target = join(root, 'dist');

/** Every `.sql` file under `dir`, as a path relative to `src/`. */
function sqlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sqlFiles(full);
    return entry.name.endsWith('.sql') ? [relative(source, full)] : [];
  });
}

const files = sqlFiles(source);
for (const file of files) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  cpSync(join(source, file), join(target, file));
}
console.log(`copied ${files.length} SQL file(s) to dist/: ${files.join(', ')}`);
