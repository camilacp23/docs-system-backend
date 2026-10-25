/**
 * Module 3 under concurrency: the scope of a variable and the assignments that use it are written by two different
 * resources. A PUT /variables that turns a GLOBAL variable into CONTEXT and, at the same moment, a PUT /collections
 * that assigns it with Set must never both commit: the collection reads the variable FOR SHARE, so one of them waits
 * for the other and then judges the committed state.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { collectionOf, createBodyOf, putBodyOf } from '../helpers/collections.js';
import { insertApplication, insertScreen } from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';
import { createBodyOf as variableBody, putBodyOf as variablePutBody, variableOf } from '../helpers/variables.js';

describe('collections: concurrent scope change and assignment', () => {
  let t: TestApp;
  let app: { id: number };
  let screen: { id: number };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Race app' });
    screen = await insertScreen(t, app.id);
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);

  it('a scope change GLOBAL -> CONTEXT and a new Set assignment of the variable: one wins, the other is 422, in every round', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 12; round += 1) {
      const variable = variableOf(await dev().post('/variables', variableBody(app.id, { name: `gRace${round}` })));
      const collection = collectionOf(
        await dev().post('/collections', createBodyOf(app.id, { name: `colRace${round}` })),
      );

      const [variableRes, collectionRes] = await Promise.all([
        dev().put(`/variables/${variable.id}`, variablePutBody(variable, { scope: 'CONTEXT' })),
        dev().put(
          `/collections/${collection.id}`,
          putBodyOf(collection, {
            variableAssignments: [
              { variableId: variable.id, screenId: screen.id, assignmentFunction: 'SET', usedIn: 'OnVisible' },
            ],
          }),
        ),
      ]);

      const label = `round ${round}: ${variableRes.status}/${collectionRes.status} ${JSON.stringify([variableRes.body, collectionRes.body])}`;
      if (variableRes.status === 200) {
        // The scope changed first: the assignment with Set is refused.
        assert.equal(collectionRes.status, 422, label);
        assert.equal(bodyOf(collectionRes).code, 'SCOPE_MISMATCH', label);
        outcomes.add('variable first');
      } else {
        // The assignment committed first: the scope change is refused.
        assert.equal(collectionRes.status, 200, label);
        assert.equal(variableRes.status, 422, label);
        assert.equal(bodyOf(variableRes).code, 'SCOPE_CONFLICT', label);
        outcomes.add('collection first');
      }

      // Never an invalid committed state: no Set on a CONTEXT variable.
      const bad = await t.owner.query(
        `SELECT 1 FROM variable_collection vc JOIN variable v ON v.id = vc.variable_id
          WHERE vc.assignment_function = 'SET' AND v.scope = 'CONTEXT'`,
      );
      assert.equal(bad.rowCount, 0, label);
    }
    assert.ok(outcomes.size >= 1);
  });
});
