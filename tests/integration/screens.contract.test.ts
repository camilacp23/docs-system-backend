/**
 * Module 4 (FR-10, FR-11): the responses of `GET`, `POST` and `PUT /screens` match the `Screen` schema of the
 * contract, including the components with their uses (the read shape has `target`, the write shape `targetId`).
 */
import '../helpers/env.js';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { insertApplication, insertCollection, insertVariable } from '../helpers/fixtures.js';
import { createBodyOf, putBodyOf, screenOf, templateWith } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

describe('screens: responses match the contract', () => {
  let t: TestApp;
  let appId: number;
  let variableId: number;
  let collectionId: number;

  before(async () => {
    t = await startTestApp();
    appId = (await insertApplication(t, { name: 'Contract screens' })).id;
    variableId = (await insertVariable(t, appId, { name: 'gContract' })).id;
    collectionId = (await insertCollection(t, appId, { name: 'colContract' })).id;
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);

  it('POST 201, GET 200 and PUT 200 of a screen with components that use a variable and a collection', async () => {
    const body = createBodyOf(appId, {
      name: 'Conforming',
      miroLink: 'https://miro.com/app/board/y/',
      template: templateWith({ workingProcess: 'Lists requests.' }),
      components: [
        {
          name: 'galItems',
          type: 'Gallery',
          onSelect: null,
          description: null,
          uses: [
            { targetType: 'VARIABLE', targetId: variableId, description: 'filters' },
            { targetType: 'COLLECTION', targetId: collectionId, description: null },
          ],
        },
        { name: 'lblTitle', type: 'Label', uses: [] },
      ],
      variableLinks: [{ variableId, accessMode: 'READ', usedIn: 'galItems.OnSelect' }],
      collectionLinks: [{ collectionId, accessMode: 'READ_WRITE', usedIn: 'OnVisible' }],
    });
    const created = await dev().post('/screens', body);
    await assertConformsToContract(created);
    const id = screenOf(created).id;
    const read = await dev().get(`/screens/${id}`);
    await assertConformsToContract(read);
    const updated = await dev().put(`/screens/${id}`, putBodyOf(screenOf(read)), String(read.headers.etag));
    await assertConformsToContract(updated);
  });
});
