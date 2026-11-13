/**
 * No operation of the API sends two statements at once on the connection of its transaction (NFR-10, NFR-20). `pg` 8
 * queues them with a deprecation notice and `pg` 9 fails; the transaction (and the row lock it holds) also stays open
 * longer, which is how a PUT under load can reach the 5 s limit of a Prisma transaction.
 *
 * Every write and every read of screens, collections and variables runs here with an exact counter of overlapping
 * statements (tests/helpers/pgOverlap.ts), one assertion per operation, so a failure names the operation and prints the
 * statements. Putting a nested `select` or a `Promise.all` back inside a transaction makes the matching test fail.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { collectionOf, putBodyOf as collectionPut } from '../helpers/collections.js';
import { insertApplication, insertCollection, insertScreen, insertVariable } from '../helpers/fixtures.js';
import { trackPgOverlap } from '../helpers/pgOverlap.js';
import {
  createBodyOf as screenCreate,
  createScreenInStatus,
  createScreenVia,
  putBodyOf as screenPut,
  screenOf,
} from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';
import { putBodyOf as variablePut, variableOf } from '../helpers/variables.js';

describe('transactions send their statements one after the other', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };
  let variable: { id: number };
  let collection: { id: number };
  let target: { id: number };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Sequential app' });
    variable = await insertVariable(t, app.id, { name: 'gSeq' });
    collection = await insertCollection(t, app.id, { name: 'colSeq' });
    target = await insertScreen(t, app.id, { name: 'Target' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const admin = () => asUser(t, t.users.admin.token);

  /** Runs `operation` and asserts that no statement overlapped another; the message lists the overlapping ones. */
  async function assertSequential(
    name: string,
    operation: () => Promise<{ status: number }>,
    status: number,
  ): Promise<void> {
    const watch = trackPgOverlap();
    const res = await operation();
    const overlaps = watch.stop();
    assert.equal(res.status, status, `${name} answered ${res.status}`);
    assert.deepEqual(
      overlaps.map((o) => o.sql),
      [],
      `${name}: ${overlaps.length} statement(s) were sent while another was running on the same connection`,
    );
  }

  const richScreen = {
    components: [
      { name: 'b', type: 'Button', uses: [{ targetType: 'VARIABLE', targetId: 0, description: null }] },
      { name: 'a', type: 'Gallery', uses: [{ targetType: 'COLLECTION', targetId: 0, description: null }] },
    ],
  };
  const screenBody = (over: Record<string, unknown> = {}) => ({
    ...richScreen,
    components: richScreen.components.map((c) => ({
      ...c,
      uses: c.uses.map((u) => ({ ...u, targetId: u.targetType === 'VARIABLE' ? variable.id : collection.id })),
    })),
    variableLinks: [{ variableId: variable.id, accessMode: 'READ', usedIn: 'x.Text' }],
    collectionLinks: [{ collectionId: collection.id, accessMode: 'READ', usedIn: 'y.Items' }],
    navigations: [{ targetScreenId: target.id, description: null }],
    ...over,
  });

  // The tests of a group run in order and share the resource the first one creates.
  describe('screens', () => {
    let screen: ReturnType<typeof screenOf>;
    let etag: string;

    it('POST /screens', async () => {
      await assertSequential(
        'POST /screens',
        async () => {
          const res = await dev().post('/screens', screenCreate(app.id, screenBody({ name: 'Seq screen' })));
          if (res.status === 201) {
            screen = screenOf(res);
            etag = String(res.headers.etag);
          }
          return res;
        },
        201,
      );
    });

    it('GET /screens/{id}', async () => {
      await assertSequential('GET /screens/{id}', () => dev().get(`/screens/${screen.id}`), 200);
    });

    it('PUT /screens/{id}', async () => {
      await assertSequential(
        'PUT /screens/{id}',
        () =>
          dev().put(`/screens/${screen.id}`, screenPut(screen, { miroLink: 'https://miro.com/app/board/seq/' }), etag),
        200,
      );
    });

    it('PUT /screens/{id}/status', async () => {
      const current = await dev().get(`/screens/${screen.id}`);
      await assertSequential(
        'PUT /screens/{id}/status',
        () => dev().put(`/screens/${screen.id}/status`, { status: 'DRAFT' }, String(current.headers.etag)),
        200,
      );
    });

    it('POST /screens/{id}/review', async () => {
      const inReview = await createScreenInStatus(t, dev(), app.id, 'IN_REVIEW');
      await assertSequential(
        'POST /screens/{id}/review',
        () => admin().post(`/screens/${inReview.screen.id}/review`, { decision: 'RETURN', comment: 'Needs work' }),
        200,
      );
    });

    it('DELETE /screens/{id}', async () => {
      const doomed = await createScreenVia(dev(), app.id, screenBody({ name: 'Seq doomed' }));
      await assertSequential('DELETE /screens/{id}', () => dev().delete(`/screens/${doomed.screen.id}`), 204);
    });
  });

  describe('collections', () => {
    let id: number;
    let read: Awaited<ReturnType<ReturnType<typeof dev>['get']>>;

    it('POST /collections', async () => {
      await assertSequential(
        'POST /collections',
        async () => {
          const res = await dev().post('/collections', {
            applicationId: app.id,
            name: 'colSeqPosted',
            environments: [{ environment: 'DEV', notes: 'n' }],
            fields: [{ name: 'Id', dataType: 'NUMBER' }],
            variableAssignments: [
              { variableId: variable.id, screenId: target.id, assignmentFunction: 'SET', usedIn: 'OnVisible' },
            ],
            derivedFrom: [collection.id],
          });
          if (res.status === 201) id = collectionOf(res).id;
          return res;
        },
        201,
      );
    });

    it('GET /collections/{id}', async () => {
      await assertSequential('GET /collections/{id}', async () => (read = await dev().get(`/collections/${id}`)), 200);
    });

    it('PUT /collections/{id}', async () => {
      await assertSequential(
        'PUT /collections/{id}',
        () =>
          dev().put(
            `/collections/${id}`,
            collectionPut(collectionOf(read), { description: 'changed' }),
            String(read.headers.etag),
          ),
        200,
      );
    });

    it('DELETE /collections/{id}', async () => {
      await assertSequential('DELETE /collections/{id}', () => dev().delete(`/collections/${id}`), 204);
    });
  });

  describe('variables', () => {
    let id: number;
    let read: Awaited<ReturnType<ReturnType<typeof dev>['get']>>;

    it('POST /variables', async () => {
      await assertSequential(
        'POST /variables',
        async () => {
          const res = await dev().post('/variables', {
            applicationId: app.id,
            name: 'gSeqPosted',
            dataType: 'TEXT',
            scope: 'GLOBAL',
            originScreenId: target.id,
            environments: [{ environment: 'DEV' }, { environment: 'PROD', notes: 'n' }],
          });
          if (res.status === 201) id = variableOf(res).id;
          return res;
        },
        201,
      );
    });

    it('GET /variables/{id}', async () => {
      await assertSequential('GET /variables/{id}', async () => (read = await dev().get(`/variables/${id}`)), 200);
    });

    it('PUT /variables/{id}', async () => {
      await assertSequential(
        'PUT /variables/{id}',
        () =>
          dev().put(
            `/variables/${id}`,
            variablePut(variableOf(read), { description: 'changed' }),
            String(read.headers.etag),
          ),
        200,
      );
    });

    it('DELETE /variables/{id}', async () => {
      await assertSequential('DELETE /variables/{id}', () => dev().delete(`/variables/${id}`), 204);
    });
  });
});
