/**
 * The complete screen, collection and variable as the API answers them (FR-05, FR-08, FR-09, NFR-10, NFR-20): POST, GET
 * and PUT of one large resource of each kind are compared with a stored reference, so changing HOW the detail is read
 * (statement by statement, in what order) can never change WHAT is answered: same fields, same order, same status.
 * Ids, dates and the ETag are normalized (tests/helpers/golden.ts); nothing else is.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { collectionOf, putBodyOf as collectionPut } from '../helpers/collections.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import {
  insertApplication,
  insertCollection,
  insertComments,
  insertScreen,
  insertScreenCollection,
  insertSubtasks,
  insertVariable,
} from '../helpers/fixtures.js';
import { assertMatchesGolden } from '../helpers/golden.js';
import { createBodyOf as screenCreate, putBodyOf as screenPut, screenOf } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';
import { putBodyOf as variablePut, variableOf } from '../helpers/variables.js';

describe('read models: the answers of the large resources never change', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Golden app' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);

  it('a screen with 50 components, 100 links and 20 navigations: POST, GET and PUT', async () => {
    const variables = [] as { id: number }[];
    for (let i = 0; i < 120; i += 1)
      variables.push(await insertVariable(t, app.id, { name: `gGold${String(i).padStart(3, '0')}` }));
    const collections = [] as { id: number }[];
    for (let i = 0; i < 30; i += 1)
      collections.push(await insertCollection(t, app.id, { name: `colGold${String(i).padStart(2, '0')}` }));
    const targets = [] as { id: number }[];
    for (let i = 0; i < 20; i += 1)
      targets.push(await insertScreen(t, app.id, { name: `Target ${String(i).padStart(2, '0')}` }));

    const post = await dev().post(
      '/screens',
      screenCreate(app.id, {
        name: 'Golden big screen',
        miroLink: 'https://miro.com/app/board/golden/',
        template: {
          onStart: 'on start',
          workingProcess: 'process',
          architecture: null,
          dataModel: 'model',
          requirements: null,
          knownIssues: 'issues',
          risks: null,
        },
        components: Array.from({ length: 50 }, (_, i) => ({
          name: `cmp${String(49 - i).padStart(2, '0')}`,
          type: i % 2 === 0 ? 'Button' : 'Gallery',
          onSelect: i % 3 === 0 ? `Navigate(S${i})` : null,
          description: i % 5 === 0 ? `component ${i}` : null,
          // Component 0 uses a variable and a collection, 1..39 a variable, 40..49 a collection.
          uses:
            i === 0
              ? [
                  { targetType: 'VARIABLE', targetId: variables[0]!.id, description: 'first' },
                  { targetType: 'COLLECTION', targetId: collections[0]!.id, description: null },
                ]
              : i < 40
                ? [{ targetType: 'VARIABLE', targetId: variables[i]!.id, description: `uses ${i}` }]
                : [{ targetType: 'COLLECTION', targetId: collections[i - 39]!.id, description: null }],
        })),
        variableLinks: Array.from({ length: 70 }, (_, i) => ({
          variableId: variables[50 + i]!.id,
          accessMode: (['READ', 'WRITE', 'READ_WRITE'] as const)[i % 3],
          usedIn: `ctl${i}.Text`,
        })),
        collectionLinks: Array.from({ length: 30 }, (_, i) => ({
          collectionId: collections[i]!.id,
          accessMode: (['READ', 'WRITE', 'READ_WRITE'] as const)[(i + 1) % 3],
          usedIn: `gal${i}.Items`,
        })),
        navigations: targets.map((s, i) => ({ targetScreenId: s.id, description: i % 2 === 0 ? `nav ${i}` : null })),
      }),
    );
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assertMatchesGolden('screen.post', post);
    await assertConformsToContract(post);

    const created = screenOf(post);
    // A variable that originates in the screen (the database adds its `origin` link), Jira Subtasks and comments.
    await insertVariable(t, app.id, { name: 'gGoldOrigin', originScreenId: created.id });
    await insertSubtasks(t, created.id, ['TO_DO', 'DONE', 'IN_PROGRESS']);
    await insertComments(t, created.id, 3);
    await insertScreenCollection(t, {
      screenId: created.id,
      collectionId: collections[29]!.id,
      accessMode: 'READ',
      usedIn: 'extra.Items',
    });

    const get = await dev().get(`/screens/${created.id}`);
    assert.equal(get.status, 200);
    assertMatchesGolden('screen.get', get);
    await assertConformsToContract(get);

    const read = screenOf(get);
    const put = await dev().put(
      `/screens/${created.id}`,
      screenPut(read, { name: 'Golden big screen 2', miroLink: null }),
      String(get.headers.etag),
    );
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assertMatchesGolden('screen.put', put);
    await assertConformsToContract(put);
  });

  it('a collection with environments, fields, assignments, derivations and screen links: POST, GET and PUT', async () => {
    const screenA = await insertScreen(t, app.id, { name: 'Golden screen A' });
    const screenB = await insertScreen(t, app.id, { name: 'Golden screen B' });
    const vars = [] as { id: number }[];
    for (let i = 0; i < 4; i += 1)
      vars.push(
        await insertVariable(t, app.id, {
          name: `gColl${i}`,
          scope: i === 3 ? 'CONTEXT' : 'GLOBAL',
          originScreenId: i === 3 ? screenA.id : null,
        }),
      );
    const bases = [
      await insertCollection(t, app.id, { name: 'colBaseB' }),
      await insertCollection(t, app.id, { name: 'colBaseA' }),
    ];

    const post = await dev().post('/collections', {
      applicationId: app.id,
      name: 'colGolden',
      description: 'Golden collection',
      creationCondition: 'ClearCollect',
      environments: [
        { environment: 'PROD', notes: 'Real data' },
        { environment: 'DEV', notes: 'Mock data' },
      ],
      fields: [
        { name: 'Id', dataType: 'NUMBER' },
        { name: 'Estado', dataType: 'TEXT', description: 'Status' },
        { name: 'Alta', dataType: 'DATE', position: 9 },
        { name: 'Activo', dataType: 'BOOLEAN', position: 1 },
      ],
      variableAssignments: [
        {
          variableId: vars[0]!.id,
          screenId: screenB.id,
          assignmentFunction: 'SET',
          usedIn: 'OnVisible',
          tableFunction: 'CountRows',
        },
        { variableId: vars[1]!.id, screenId: screenA.id, assignmentFunction: 'SET', usedIn: 'OnStart' },
        {
          variableId: vars[3]!.id,
          screenId: screenA.id,
          assignmentFunction: 'UPDATE_CONTEXT',
          usedIn: 'btnSave.OnSelect',
        },
      ],
      derivedFrom: bases.map((b) => b.id),
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assertMatchesGolden('collection.post', post);
    await assertConformsToContract(post);

    const created = collectionOf(post);
    await insertScreenCollection(t, {
      screenId: screenA.id,
      collectionId: created.id,
      accessMode: 'READ',
      usedIn: 'gal.Items',
    });

    const get = await dev().get(`/collections/${created.id}`);
    assert.equal(get.status, 200);
    assertMatchesGolden('collection.get', get);
    await assertConformsToContract(get);

    const put = await dev().put(
      `/collections/${created.id}`,
      collectionPut(collectionOf(get), { description: 'Golden collection, changed' }),
      String(get.headers.etag),
    );
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assertMatchesGolden('collection.put', put);
    await assertConformsToContract(put);
  });

  it('a variable with environments and an origin screen: POST, GET and PUT', async () => {
    const origin = await insertScreen(t, app.id, { name: 'Golden origin screen' });
    const post = await dev().post('/variables', {
      applicationId: app.id,
      name: 'gGoldenVariable',
      dataType: 'TEXT',
      scope: 'GLOBAL',
      description: 'Golden variable',
      originScreenId: origin.id,
      environments: [{ environment: 'PROD', notes: 'Real' }, { environment: 'DEV' }],
    });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assertMatchesGolden('variable.post', post);
    await assertConformsToContract(post);

    const created = variableOf(post);
    const get = await dev().get(`/variables/${created.id}`);
    assert.equal(get.status, 200);
    assertMatchesGolden('variable.get', get);
    await assertConformsToContract(get);

    const put = await dev().put(
      `/variables/${created.id}`,
      variablePut(variableOf(get), { description: 'Golden variable, changed' }),
      String(get.headers.etag),
    );
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assertMatchesGolden('variable.put', put);
    await assertConformsToContract(put);
  });
});
