/**
 * A comment and the ETag of its screen (D-101, D-123): a new comment changes the ETag of `GET /screens/{id}` (the
 * `commentCount` part) without touching `updatedAt`, so `If-None-Match` stops answering 304 with a stale counter; and a
 * `PUT /screens/{id}` whose `If-Match` was read BEFORE the comment is not a 412, because `If-Match` compares only the
 * `updatedAt` part. Editing a comment does not change the screen: the counter is the same.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, startTestApp, type TestApp } from '../helpers/app.js';
import { commentOf } from '../helpers/comments.js';
import { insertApplication } from '../helpers/fixtures.js';
import { createScreenVia, putBodyOf, screenOf, templateWith } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

describe('comments and the ETag of the screen (D-101)', () => {
  let t: TestApp;
  let app: { id: number };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Counted' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const reader = () => asUser(t, t.users.reader.token);
  const read = (id: number, ifNoneMatch?: string) => {
    const r = t.http.get(`/api/v1/screens/${id}`).set('Authorization', bearer(t.users.reader.token));
    return ifNoneMatch === undefined ? r : r.set('If-None-Match', ifNoneMatch);
  };

  it('a new comment changes the ETag (only the counter part), leaves updatedAt alone, and ends the 304', async () => {
    const { screen } = await createScreenVia(dev(), app.id);
    const before = await read(screen.id);
    const etagBefore = String(before.headers.etag);
    assert.ok(etagBefore.startsWith(`W/"${Date.parse(screenOf(before).updatedAt)}-0-0-`));

    const created = await reader().post(`/screens/${screen.id}/comments`, { text: 'A first comment' });
    assert.equal(created.status, 201);

    const after = await read(screen.id);
    assert.equal(screenOf(after).commentCount, 1);
    assert.equal(screenOf(after).updatedAt, screenOf(before).updatedAt, 'updatedAt did not move');
    assert.ok(String(after.headers.etag).startsWith(`W/"${Date.parse(screenOf(before).updatedAt)}-0-1-`));
    assert.notEqual(after.headers.etag, etagBefore);
    assert.equal((await read(screen.id, etagBefore)).status, 200, 'the old tag no longer gives a 304');
    assert.equal((await read(screen.id, String(after.headers.etag))).status, 304);

    const second = await dev().post(`/screens/${screen.id}/comments`, { text: 'A second one' });
    assert.equal(second.status, 201);
    assert.match(String((await read(screen.id)).headers.etag), /-0-2-[0-9a-f]{8}"$/);
  });

  it('PUT /screens/{id} with an If-Match read BEFORE the comment is a 200, not a 412', async () => {
    const { screen, etag } = await createScreenVia(dev(), app.id);
    const posted = await reader().post(`/screens/${screen.id}/comments`, { text: 'Written while you were editing' });
    assert.equal(posted.status, 201);
    assert.notEqual(String((await read(screen.id)).headers.etag), etag, 'the full tag did change');

    const res = await dev().put(
      `/screens/${screen.id}`,
      putBodyOf(screen, { template: templateWith({ onStart: 'Edited' }) }),
      etag,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(screenOf(res).commentCount, 1, 'the response carries the counter that changed meanwhile');
    assert.match(String(res.headers.etag), /-0-1-[0-9a-f]{8}"$/);
  });

  it('a stale updatedAt is still a 412 with the full ETag, comments or not', async () => {
    const { screen, etag } = await createScreenVia(dev(), app.id);
    assert.equal((await reader().post(`/screens/${screen.id}/comments`, { text: 'x' })).status, 201);
    const first = await dev().put(
      `/screens/${screen.id}`,
      putBodyOf(screen, { template: templateWith({ onStart: 'One' }) }),
      etag,
    );
    assert.equal(first.status, 200);
    const stale = await dev().put(
      `/screens/${screen.id}`,
      putBodyOf(screen, { template: templateWith({ onStart: 'Two' }) }),
      etag,
    );
    assert.equal(stale.status, 412);
    assert.equal((stale.body as { details: { currentETag: string } }).details.currentETag, first.headers.etag);
  });

  it('editing a comment does not change the ETag of the screen (the counter is the same)', async () => {
    const { screen } = await createScreenVia(dev(), app.id);
    const posted = await dev().post(`/screens/${screen.id}/comments`, { text: 'v1' });
    const before = String((await read(screen.id)).headers.etag);
    const edited = await dev().put(`/comments/${commentOf(posted).id}`, { text: 'v2' }, String(posted.headers.etag));
    assert.equal(edited.status, 200);
    assert.equal(String((await read(screen.id)).headers.etag), before);
    assert.equal((await read(screen.id, before)).status, 304);
  });
});
