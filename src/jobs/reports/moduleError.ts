/**
 * Which module a thread could not load. The text of an error never leaves the generator thread (it could hold a value of
 * the documentation), with one exception: for the errors of Node that say a MODULE is missing, the name of that module is
 * a fact about the installation, not content, and it is the one thing that explains the failure. It is sent as a package
 * name or a path relative to the repository, never an absolute path of the machine. Imports nothing, so the thread can
 * use it.
 *
 * @module jobs/reports/moduleError
 */
import { basename, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The codes of Node for which the specifier is reported. */
const MODULE_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);

/** A specifier that is safe to log: a package name or a relative path made of ordinary characters. */
const SAFE = /^[A-Za-z0-9@_./\-:]{1,200}$/;

/** A path inside `node_modules`: `pkg/rest` or `@scope/pkg/rest`. */
function inPackage(path: string): string | undefined {
  const parts = path.split(sep === '\\' ? /[\\/]/ : /\//);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at === parts.length - 1) return undefined;
  const rest = parts.slice(at + 1);
  const name = rest[0]!.startsWith('@') ? rest.slice(0, 2).join('/') : rest[0]!;
  return name;
}

/** Turns a path or `file:` URL of the machine into a package name or a path relative to the repository. */
function shorten(raw: string, root: string): string {
  const path = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
  if (!isAbsolute(path)) return path;
  const pkg = inPackage(path);
  if (pkg !== undefined) return pkg;
  const rel = relative(root, path).split(sep).join('/');
  return rel.startsWith('..') ? basename(path) : rel;
}

/**
 * The module an error of Node says is missing.
 *
 * @param error - The thrown value.
 * @param root - The root of the repository (`process.cwd()` in the thread).
 * @returns The package name or the path relative to the repository, or `undefined` for any other error.
 */
export function missingModuleOf(error: unknown, root: string): string | undefined {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !MODULE_CODES.has(code) || typeof message !== 'string') return undefined;
  const found =
    /Cannot find (?:module|package) '([^']+)'/.exec(message)?.[1] ??
    /Package subpath '([^']+)' is not defined by "exports" in (.+?)(?: imported from|$)/.exec(message)?.slice(1);
  if (found === undefined) return undefined;
  try {
    const specifier = Array.isArray(found)
      ? `${shorten(found[1]!, root).replace(/\/package\.json$/, '')}${found[0]!.replace(/^\./, '')}`
      : shorten(found, root);
    return SAFE.test(specifier) ? specifier : undefined;
  } catch {
    return undefined;
  }
}
