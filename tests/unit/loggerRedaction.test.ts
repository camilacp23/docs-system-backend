/** The logger never writes passwords, tokens or cookies (NFR-06, CLAUDE.md rule 7). */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../../src/http/logger.js';

describe('pino redaction', () => {
  const capture = () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, { write: (l: string) => void lines.push(l) });
    return { lines, logger };
  };

  it('redacts accessToken, refreshToken, password and passwordHash at the top level and one level down', () => {
    const { lines, logger } = capture();
    logger.info({
      accessToken: 'SECRET-ACCESS-1',
      refreshToken: 'SECRET-REFRESH-1',
      password: 'SECRET-PASSWORD-1',
      passwordHash: 'SECRET-HASH-1',
      data: { accessToken: 'SECRET-ACCESS-2', refreshToken: 'SECRET-REFRESH-2', password: 'SECRET-PASSWORD-2' },
    });
    const out = lines.join('');
    assert.doesNotMatch(out, /SECRET-/);
    assert.match(out, /\[Redacted\]/);
  });

  it('redacts the Authorization and Cookie request headers and the Set-Cookie response header', () => {
    const { lines, logger } = capture();
    logger.info({
      req: { headers: { authorization: 'Bearer SECRET-BEARER', cookie: 'rt=SECRET-RT' } },
      res: { headers: { 'set-cookie': ['rt=SECRET-SET; HttpOnly'] } },
    });
    const out = lines.join('');
    assert.doesNotMatch(out, /SECRET-/);
  });
});
