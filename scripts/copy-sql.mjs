/**
 * Copies the files that live next to the compiled code and that `tsc` does not emit from `src/` to `dist/`: the `.sql`
 * files (for example the dependency graph query) and everything inside a `fonts/` folder (the TrueType fonts of the PDF
 * reports with their license). Runs after the compiler in `npm run build`. Plain Node (no `cp`), so it behaves the same
 * on Windows and Ubuntu. `--out <dir>` copies to another directory (the tests use it); the default is `dist/`.
 */
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src');
const outIndex = process.argv.indexOf('--out');
const target = outIndex > 0 && process.argv[outIndex + 1] ? resolve(process.argv[outIndex + 1]) : join(root, 'dist');

/** Every asset file under `dir` (`.sql`, or anything inside a `fonts` folder), as a path relative to `src/`. */
function assetFiles(dir, inFonts = false) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'generated' ? [] : assetFiles(full, inFonts || entry.name === 'fonts');
    return inFonts || entry.name.endsWith('.sql') ? [relative(source, full)] : [];
  });
}

const files = assetFiles(source);
for (const file of files) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  cpSync(join(source, file), join(target, file));
}
console.log(`copied ${files.length} asset file(s) to ${relative(root, target) || '.'}: ${files.join(', ')}`);
