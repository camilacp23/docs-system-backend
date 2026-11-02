/**
 * Module 4, PUT /screens/{id} (FR-10, FR-11, FR-14; SDD Table 50; D-26, D-62, D-71, D-75, D-81, D-84 to D-87): the
 * whole representation is replaced, the nested arrays are reconciled by id (an updated item keeps its row and its
 * audit history), only what changes is written, and every error carries its code and details in the order of the
 * service.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { auditCount, auditRows } from '../helpers/collections.js';
import {
  deleteScreen,
  insertApplication,
  insertCollection,
  insertScreen,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { createScreenVia, detailsOf, putBodyOf, screenOf, templateWith, type ScreenBody } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

describe('screens: PUT /screens/{id}', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };
  let other: { id: number; name: string };
  let gA: { id: number; name: string };
  let gB: { id: number; name: string };
  let colA: { id: number; name: string };
  let colB: { id: number; name: string };
  let target: { id: number; name: string };
  let target2: { id: number; name: string };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Screen editors' });
    other = await insertApplication(t, { name: 'Foreign app' });
    gA = await insertVariable(t, app.id, { name: 'gA' });
    gB = await insertVariable(t, app.id, { name: 'gB' });
    colA = await insertCollection(t, app.id, { name: 'colA' });
    colB = await insertCollection(t, app.id, { name: 'colB' });
    target = await insertScreen(t, app.id, { name: 'Target' });
    target2 = await insertScreen(t, app.id, { name: 'Target 2' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const admin = () => asUser(t, t.users.admin.token);
  const reader = () => asUser(t, t.users.reader.token);
  const create = (over: Record<string, unknown> = {}) => createScreenVia(dev(), app.id, over);
  const read = async (id: number): Promise<{ screen: ScreenBody; etag: string }> => {
    const res = await dev().get(`/screens/${id}`);
    return { screen: screenOf(res), etag: String(res.headers.etag) };
  };
  const put = (s: ScreenBody, etag: string | undefined, over: Record<string, unknown> = {}) =>
    dev().put(`/screens/${s.id}`, putBodyOf(s, over), etag);
  const actions = async (entity: string, id: number) => (await auditRows(t, entity, String(id))).map((r) => r.action);
  const use = (targetType: string, targetId: number, description?: string) => ({ targetType, targetId, description });

  describe('success and D-71', () => {
    it('200 replaces the representation, moves the ETag and audits the actor; the response shows the status', async () => {
      const { screen, etag } = await create({ name: 'Editable' });
      const res = await put(screen, etag, {
        name: 'Edited',
        miroLink: 'https://miro.com/app/board/y/',
        template: templateWith({ onStart: 'Loads data.' }),
        components: [{ name: 'btn', type: 'Button', uses: [use('VARIABLE', gA.id)] }],
        variableLinks: [{ variableId: gA.id, accessMode: 'READ', usedIn: 'btn.OnSelect' }],
        collectionLinks: [{ collectionId: colA.id, accessMode: 'READ', usedIn: 'gal.Items' }],
        navigations: [{ targetScreenId: target.id, description: 'Go' }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = screenOf(res);
      assert.equal(s.name, 'Edited');
      assert.equal(s.documentationStatus, 'DRAFT');
      assert.equal(s.template.onStart, 'Loads data.');
      assert.equal(s.components.length, 1);
      assert.equal(s.navigations.length, 1);
      assert.notEqual(res.headers.etag, etag);
      assert.equal(res.headers.etag, `W/"${new Date(s.updatedAt).getTime()}"`);
      assert.deepEqual(
        await auditRows(t, 'screen', String(s.id)).then((r) => r.map((x) => [x.action, x.actor_user_id])),
        [
          ['CREATE', t.users.developer.id],
          ['UPDATE', t.users.developer.id],
        ],
      );
    });

    it('a PUT that changes nothing writes nothing: 200, the same ETag, no audit row (D-71)', async () => {
      const { screen, etag } = await create({
        name: 'Stable',
        components: [{ name: 'btn', type: 'Button', uses: [use('VARIABLE', gA.id)] }],
        variableLinks: [{ variableId: gA.id, accessMode: 'READ', usedIn: 'btn.OnSelect' }],
        navigations: [{ targetScreenId: target.id }],
      });
      const rows = await auditCount(t);
      const res = await put(screen, etag);
      assert.equal(res.status, 200);
      assert.equal(res.headers.etag, etag);
      assert.deepEqual(screenOf(res), screen);
      assert.equal(await auditCount(t), rows);
      assert.equal((await put(screen, undefined)).status, 200, 'If-Match is optional');
      assert.equal(await auditCount(t), rows);
    });

    it('If-Match is verified even when nothing changes: 412 with currentETag and nothing written', async () => {
      const { screen, etag } = await create({ name: 'Guarded' });
      const rows = await auditCount(t);
      const res = await put(screen, 'W/"1"');
      assert.equal(res.status, 412);
      assert.equal(bodyOf(res).code, 'PRECONDITION_FAILED');
      assert.equal(
        bodyOf(res).message,
        'Someone else saved changes to this screen after you opened it. Reload to see their version.',
      );
      assert.deepEqual(detailsOf(res), { element: 'screen', currentETag: etag });
      assert.equal(await auditCount(t), rows);
    });

    it('a change only in a nested array also moves updated_at and the ETag of the screen (D-62)', async () => {
      const { screen, etag } = await create({ name: 'Nested only' });
      const res = await put(screen, etag, { components: [{ name: 'added', type: 'Label' }] });
      assert.equal(res.status, 200);
      assert.notEqual(res.headers.etag, etag);
      assert.equal(screenOf(res).components.length, 1);
      assert.ok(new Date(screenOf(res).updatedAt) > new Date(screen.updatedAt));
    });

    it('with an id the item is updated and keeps its id; without an id it is created; what is left out is deleted', async () => {
      const { screen, etag } = await create({
        name: 'Reconciled',
        components: [
          { name: 'keep', type: 'Button', uses: [use('VARIABLE', gA.id), use('VARIABLE', gB.id)] },
          { name: 'drop', type: 'Label' },
        ],
        variableLinks: [
          { variableId: gA.id, accessMode: 'READ', usedIn: 'keep.A' },
          { variableId: gB.id, accessMode: 'READ', usedIn: 'keep.B' },
        ],
        navigations: [{ targetScreenId: target.id }],
      });
      const keep = screen.components.find((c) => c.name === 'keep')!;
      const drop = screen.components.find((c) => c.name === 'drop')!;
      const linkA = screen.variableLinks.find((l) => l.usedIn === 'keep.A')!;
      const linkB = screen.variableLinks.find((l) => l.usedIn === 'keep.B')!;
      const res = await put(screen, etag, {
        components: [
          {
            id: keep.id,
            name: 'keep',
            type: 'Button2',
            uses: [
              {
                id: keep.uses[0]!.id,
                targetType: keep.uses[0]!.targetType,
                targetId: keep.uses[0]!.target.id,
                description: 'now described',
              },
            ],
          },
          { name: 'fresh', type: 'Label' },
        ],
        variableLinks: [{ id: linkA.id, variableId: gA.id, accessMode: 'WRITE', usedIn: 'keep.A' }],
        navigations: [{ targetScreenId: target2.id }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = screenOf(res);
      const keptNow = s.components.find((c) => c.name === 'keep')!;
      assert.equal(keptNow.id, keep.id);
      assert.equal(keptNow.type, 'Button2');
      assert.equal(keptNow.uses.length, 1);
      assert.equal(keptNow.uses[0]!.id, keep.uses[0]!.id);
      assert.equal(keptNow.uses[0]!.description, 'now described');
      assert.ok(s.components.some((c) => c.name === 'fresh' && c.id !== keep.id));
      assert.ok(!s.components.some((c) => c.id === drop.id));
      assert.deepEqual(
        s.variableLinks.map((l) => [l.id, l.accessMode]),
        [[linkA.id, 'WRITE']],
      );
      assert.deepEqual(await actions('component', keep.id), ['CREATE', 'UPDATE']);
      assert.deepEqual(await actions('component', drop.id), ['CREATE', 'DELETE']);
      assert.deepEqual(await actions('screen_variable', linkA.id), ['CREATE', 'UPDATE']);
      assert.deepEqual(await actions('screen_variable', linkB.id), ['CREATE', 'DELETE']);
      assert.deepEqual(
        s.navigations.map((n) => n.targetScreen.id),
        [target2.id],
      );
    });

    it('an empty array deletes its elements; a component without "uses" loses its uses; the dependencies go with them', async () => {
      const { screen, etag } = await create({
        name: 'Emptied',
        components: [{ name: 'c', type: 'Button', uses: [use('VARIABLE', gA.id)] }],
        collectionLinks: [{ collectionId: colA.id, accessMode: 'READ', usedIn: 'g.Items' }],
        navigations: [{ targetScreenId: target.id }],
      });
      const useId = screen.components[0]!.uses[0]!.id;
      const withoutUses = putBodyOf(screen, { collectionLinks: [], navigations: [] });
      delete (withoutUses.components[0] as { uses?: unknown }).uses;
      const res = await dev().put(`/screens/${screen.id}`, withoutUses, etag);
      assert.equal(res.status, 200);
      assert.deepEqual(screenOf(res).components[0]!.uses, []);
      assert.deepEqual([screenOf(res).collectionLinks, screenOf(res).navigations], [[], []]);
      assert.equal((await t.owner.query(`SELECT 1 FROM dependency WHERE id = $1`, [useId])).rowCount, 0);
      const emptied = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screenOf(res), { components: [] }),
        String(res.headers.etag),
      );
      assert.deepEqual(screenOf(emptied).components, []);
    });
  });

  describe('swaps keep the ids and are audited as UPDATE, never DELETE + CREATE (D-26)', () => {
    it('two components exchange their names in one PUT', async () => {
      const { screen, etag } = await create({
        name: 'Swapper',
        components: [
          { name: 'left', type: 'Button' },
          { name: 'right', type: 'Label' },
        ],
      });
      const left = screen.components.find((c) => c.name === 'left')!;
      const right = screen.components.find((c) => c.name === 'right')!;
      const res = await put(screen, etag, {
        components: [
          { id: left.id, name: 'right', type: 'Button' },
          { id: right.id, name: 'left', type: 'Label' },
        ],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = screenOf(res);
      assert.equal(s.components.find((c) => c.id === left.id)!.name, 'right');
      assert.equal(s.components.find((c) => c.id === right.id)!.name, 'left');
      for (const id of [left.id, right.id]) {
        const history = await actions('component', id);
        assert.equal(history[0], 'CREATE');
        assert.ok(history.length >= 2 && history.slice(1).every((a) => a === 'UPDATE'), history.join());
      }
    });

    it('three components rotate their names', async () => {
      const { screen, etag } = await create({
        name: 'Rotator',
        components: [
          { name: 'one', type: 'T' },
          { name: 'two', type: 'T' },
          { name: 'three', type: 'T' },
        ],
      });
      const [one, two, three] = ['one', 'two', 'three'].map((n) => screen.components.find((c) => c.name === n)!);
      const res = await put(screen, etag, {
        components: [
          { id: one!.id, name: 'two', type: 'T' },
          { id: two!.id, name: 'three', type: 'T' },
          { id: three!.id, name: 'one', type: 'T' },
        ],
      });
      assert.equal(res.status, 200);
      const byId = new Map(screenOf(res).components.map((c) => [c.id, c.name]));
      assert.deepEqual([byId.get(one!.id), byId.get(two!.id), byId.get(three!.id)], ['two', 'three', 'one']);
      for (const c of [one!, two!, three!]) {
        assert.ok((await actions('component', c.id)).slice(1).every((a) => a === 'UPDATE'));
      }
    });

    it('two links of the same variable exchange their usedIn; so do two links of a collection', async () => {
      const { screen, etag } = await create({
        name: 'Link swapper',
        variableLinks: [
          { variableId: gA.id, accessMode: 'READ', usedIn: 'a.One' },
          { variableId: gA.id, accessMode: 'WRITE', usedIn: 'a.Two' },
        ],
        collectionLinks: [
          { collectionId: colA.id, accessMode: 'READ', usedIn: 'g.One' },
          { collectionId: colA.id, accessMode: 'READ', usedIn: 'g.Two' },
        ],
      });
      const [v1, v2] = ['a.One', 'a.Two'].map((u) => screen.variableLinks.find((l) => l.usedIn === u)!);
      const [c1, c2] = ['g.One', 'g.Two'].map((u) => screen.collectionLinks.find((l) => l.usedIn === u)!);
      const res = await put(screen, etag, {
        variableLinks: [
          { id: v1!.id, variableId: gA.id, accessMode: 'READ', usedIn: 'a.Two' },
          { id: v2!.id, variableId: gA.id, accessMode: 'WRITE', usedIn: 'a.One' },
        ],
        collectionLinks: [
          { id: c1!.id, collectionId: colA.id, accessMode: 'READ', usedIn: 'g.Two' },
          { id: c2!.id, collectionId: colA.id, accessMode: 'READ', usedIn: 'g.One' },
        ],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = screenOf(res);
      assert.equal(s.variableLinks.find((l) => l.id === v1!.id)!.usedIn, 'a.Two');
      assert.equal(s.variableLinks.find((l) => l.id === v2!.id)!.usedIn, 'a.One');
      assert.equal(s.collectionLinks.find((l) => l.id === c1!.id)!.usedIn, 'g.Two');
      assert.equal(s.collectionLinks.find((l) => l.id === c2!.id)!.usedIn, 'g.One');
      for (const [entity, id] of [
        ['screen_variable', v1!.id],
        ['screen_variable', v2!.id],
        ['screen_collection', c1!.id],
        ['screen_collection', c2!.id],
      ] as const) {
        const history = await actions(entity, id);
        assert.ok(
          history.slice(1).every((a) => a === 'UPDATE') && history.length >= 2,
          `${entity} ${id}: ${history.join()}`,
        );
      }
    });

    it('D-86: exchanging the targets of two navigations re-creates ONE row; the other keeps its id with UPDATE', async () => {
      const { screen, etag } = await create({
        name: 'Navigation swapper',
        navigations: [
          { targetScreenId: target.id, description: 'to target' },
          { targetScreenId: target2.id, description: 'to target 2' },
        ],
      });
      const [n1, n2] = [target.id, target2.id].map((id) => screen.navigations.find((n) => n.targetScreen.id === id)!);
      const res = await put(screen, etag, {
        navigations: [
          { id: n1!.id, targetScreenId: target2.id, description: 'to target 2' },
          { id: n2!.id, targetScreenId: target.id, description: 'to target' },
        ],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = screenOf(res);
      assert.deepEqual(s.navigations.map((n) => [n.targetScreen.id, n.description]).sort(), [
        [target.id, 'to target'],
        [target2.id, 'to target 2'],
      ]);
      const kept = [n1!.id, n2!.id].filter((id) => s.navigations.some((n) => n.id === id));
      assert.equal(kept.length, 1, 'exactly one of the two rows keeps its id');
      const recreated = [n1!.id, n2!.id].find((id) => !kept.includes(id))!;
      assert.deepEqual(await actions('dependency', recreated), ['CREATE', 'DELETE']);
      assert.deepEqual(await actions('dependency', kept[0]!), ['CREATE', 'UPDATE']);
    });

    it('D-86: exchanging the targets of two uses of a component behaves the same way', async () => {
      const { screen, etag } = await create({
        name: 'Use swapper',
        components: [
          { name: 'c', type: 'T', uses: [use('VARIABLE', gA.id, 'first'), use('VARIABLE', gB.id, 'second')] },
        ],
      });
      const component = screen.components[0]!;
      const [u1, u2] = [gA.id, gB.id].map((id) => component.uses.find((u) => u.target.id === id)!);
      const res = await put(screen, etag, {
        components: [
          {
            id: component.id,
            name: 'c',
            type: 'T',
            uses: [
              { id: u1!.id, targetType: 'VARIABLE', targetId: gB.id, description: 'second' },
              { id: u2!.id, targetType: 'VARIABLE', targetId: gA.id, description: 'first' },
            ],
          },
        ],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const uses = screenOf(res).components[0]!.uses;
      assert.deepEqual(uses.map((u) => [u.target.id, u.description]).sort(), [
        [gA.id, 'first'],
        [gB.id, 'second'],
      ]);
      assert.equal([u1!.id, u2!.id].filter((id) => uses.some((u) => u.id === id)).length, 1);
    });

    it('a use that changes its target to a free one keeps its id (UPDATE), even to a collection', async () => {
      const { screen, etag } = await create({
        name: 'Retarget',
        components: [{ name: 'c', type: 'T', uses: [use('VARIABLE', gA.id)] }],
      });
      const component = screen.components[0]!;
      const res = await put(screen, etag, {
        components: [
          {
            id: component.id,
            name: 'c',
            type: 'T',
            uses: [{ id: component.uses[0]!.id, targetType: 'COLLECTION', targetId: colB.id }],
          },
        ],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        screenOf(res).components[0]!.uses.map((u) => [u.id, u.targetType, u.target.id]),
        [[component.uses[0]!.id, 'COLLECTION', colB.id]],
      );
      assert.deepEqual(await actions('dependency', component.uses[0]!.id), ['CREATE', 'UPDATE']);
    });
  });

  describe('origin rows belong to the variables module (D-84)', () => {
    async function withOrigin() {
      const s = await insertScreen(t, app.id, { name: `Owner ${Math.random()}` });
      const ctx = await insertVariable(t, app.id, { name: `loc${s.id}`, scope: 'CONTEXT', originScreenId: s.id });
      const { screen, etag } = await read(s.id);
      const origin = screen.variableLinks.find((l) => l.isOrigin)!;
      return { screen, etag, origin, ctx };
    }

    it('are never updated or deleted by a PUT, even when the body omits them, and leave no audit row', async () => {
      const { screen, etag, origin } = await withOrigin();
      const before = await auditRows(t, 'screen_variable', String(origin.id));
      const res = await put(screen, etag, {
        template: templateWith({ onStart: 'text' }),
        variableLinks: [{ variableId: gA.id, accessMode: 'READ', usedIn: 'x.Y' }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        screenOf(res)
          .variableLinks.map((l) => [l.usedIn, l.isOrigin])
          .sort(),
        [
          ['origin', true],
          ['x.Y', false],
        ],
      );
      const again = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screenOf(res), { variableLinks: [] }),
        String(res.headers.etag),
      );
      assert.deepEqual(
        screenOf(again).variableLinks.map((l) => [l.id, l.usedIn]),
        [[origin.id, 'origin']],
      );
      assert.deepEqual(await auditRows(t, 'screen_variable', String(origin.id)), before);
    });

    it('the id of an origin row in the body is 404 "variable link" at its position (D-75)', async () => {
      const { screen, etag, origin } = await withOrigin();
      const res = await put(screen, etag, {
        variableLinks: [{ id: origin.id, variableId: origin.variable.id, accessMode: 'WRITE', usedIn: 'x.Y' }],
      });
      assert.equal(res.status, 404);
      assert.equal(bodyOf(res).code, 'NOT_FOUND');
      assert.equal(bodyOf(res).message, "This variable link doesn't exist. It may have been deleted.");
      assert.deepEqual(detailsOf(res), { element: 'variable link', id: origin.id, field: 'variableLinks[0].id' });
    });

    it('usedIn "origin" in the body is 400 at its position', async () => {
      const { screen, etag } = await withOrigin();
      const res = await put(screen, etag, {
        variableLinks: [{ variableId: gA.id, accessMode: 'WRITE', usedIn: 'origin' }],
      });
      assert.equal(res.status, 400);
      assert.deepEqual(
        bodyOf(res).details.fields.map((f) => f.field),
        ['variableLinks[0].usedIn'],
      );
    });
  });

  describe('404 for nested ids that are not rows of this screen (D-75)', () => {
    it('each kind of nested id, with element, id and the position; ids out of range too', async () => {
      const mine = await create({
        name: 'Mine',
        components: [
          { name: 'c1', type: 'T', uses: [use('VARIABLE', gA.id)] },
          { name: 'c2', type: 'T', uses: [use('VARIABLE', gB.id)] },
        ],
      });
      const theirs = await create({
        name: 'Theirs',
        components: [{ name: 'x', type: 'T', uses: [use('VARIABLE', gA.id)] }],
        variableLinks: [{ variableId: gA.id, accessMode: 'READ', usedIn: 'x.Y' }],
        collectionLinks: [{ collectionId: colA.id, accessMode: 'READ', usedIn: 'x.Z' }],
        navigations: [{ targetScreenId: target.id }],
      });
      const [c1, c2] = ['c1', 'c2'].map((n) => mine.screen.components.find((c) => c.name === n)!);
      const bad = async (over: Record<string, unknown>, element: string, id: number, field: string) => {
        const res = await put(mine.screen, mine.etag, over);
        assert.equal(res.status, 404, `${field}: ${JSON.stringify(res.body)}`);
        assert.deepEqual(detailsOf(res), { element, id, field });
      };
      const keep = putBodyOf(mine.screen).components;
      await bad(
        { components: [...keep, { id: theirs.screen.components[0]!.id, name: 'z', type: 'T' }] },
        'component',
        theirs.screen.components[0]!.id,
        'components[2].id',
      );
      await bad({ components: [{ id: 999999, name: 'z', type: 'T' }] }, 'component', 999999, 'components[0].id');
      await bad(
        { components: [{ id: 2147483648, name: 'z', type: 'T' }] },
        'component',
        2147483648,
        'components[0].id',
      );
      // A use of another component of the SAME screen is not valid under this one.
      await bad(
        {
          components: [
            {
              id: c1!.id,
              name: 'c1',
              type: 'T',
              uses: [{ id: c2!.uses[0]!.id, targetType: 'VARIABLE', targetId: gB.id }],
            },
          ],
        },
        'component use',
        c2!.uses[0]!.id,
        'components[0].uses[0].id',
      );
      await bad(
        { components: [{ name: 'new', type: 'T', uses: [{ id: 5, targetType: 'VARIABLE', targetId: gB.id }] }] },
        'component use',
        5,
        'components[0].uses[0].id',
      );
      await bad(
        {
          variableLinks: [
            { id: theirs.screen.variableLinks[0]!.id, variableId: gA.id, accessMode: 'READ', usedIn: 'x.Y' },
          ],
        },
        'variable link',
        theirs.screen.variableLinks[0]!.id,
        'variableLinks[0].id',
      );
      await bad(
        {
          collectionLinks: [
            { id: theirs.screen.collectionLinks[0]!.id, collectionId: colA.id, accessMode: 'READ', usedIn: 'x.Z' },
          ],
        },
        'collection link',
        theirs.screen.collectionLinks[0]!.id,
        'collectionLinks[0].id',
      );
      await bad(
        { navigations: [{ id: theirs.screen.navigations[0]!.id, targetScreenId: target.id }] },
        'navigation',
        theirs.screen.navigations[0]!.id,
        'navigations[0].id',
      );
    });

    it('a variable, collection or target screen that does not exist is 404 with the position', async () => {
      const { screen, etag } = await create({ name: 'Refs' });
      const res = await put(screen, etag, { navigations: [{ targetScreenId: target.id }, { targetScreenId: 999999 }] });
      assert.equal(res.status, 404);
      assert.deepEqual(detailsOf(res), { element: 'screen', id: 999999, field: 'navigations[1].targetScreenId' });
      const v = await put(screen, etag, { variableLinks: [{ variableId: 999999, accessMode: 'READ', usedIn: 'a.B' }] });
      assert.deepEqual(detailsOf(v), { element: 'variable', id: 999999, field: 'variableLinks[0].variableId' });
      const c = await put(screen, etag, {
        collectionLinks: [{ collectionId: 999999, accessMode: 'READ', usedIn: 'a.B' }],
      });
      assert.deepEqual(detailsOf(c), { element: 'collection', id: 999999, field: 'collectionLinks[0].collectionId' });
    });

    it('404 for a screen that does not exist or whose id cannot exist', async () => {
      const { screen } = await create({ name: 'Ghost' });
      for (const id of [999999, 2147483648]) {
        const res = await dev().put(`/screens/${id}`, putBodyOf(screen));
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).message, "This screen doesn't exist. It may have been deleted.");
      }
    });
  });

  describe('400 VALIDATION_ERROR comes first and writes nothing', () => {
    it('repeated names, targets, links, navigations and ids name each position', async () => {
      const { screen, etag } = await create({ name: 'Repeating', components: [{ name: 'a', type: 'T' }] });
      const rows = await auditCount(t);
      const res = await put(screen, etag, {
        components: [
          {
            id: screen.components[0]!.id,
            name: 'dup',
            type: 'T',
            uses: [use('VARIABLE', gA.id), use('VARIABLE', gA.id)],
          },
          { id: screen.components[0]!.id, name: 'dup', type: 'T' },
        ],
        variableLinks: [
          { variableId: gA.id, accessMode: 'READ', usedIn: 'a.B' },
          { variableId: gA.id, accessMode: 'READ', usedIn: 'a.B' },
        ],
        collectionLinks: [
          { collectionId: colA.id, accessMode: 'READ', usedIn: 'a.B' },
          { collectionId: colA.id, accessMode: 'READ', usedIn: 'a.B' },
        ],
        navigations: [{ targetScreenId: target.id }, { targetScreenId: target.id }],
      });
      assert.equal(res.status, 400);
      assert.deepEqual(
        bodyOf(res)
          .details.fields.map((f) => [f.field, f.rule])
          .sort(),
        [
          ['collectionLinks[1].usedIn', 'unique'],
          ['components[0].uses[1].targetId', 'unique'],
          ['components[1].id', 'unique'],
          ['components[1].name', 'unique'],
          ['navigations[1].targetScreenId', 'unique'],
          ['variableLinks[1].usedIn', 'unique'],
        ],
      );
      assert.equal(await auditCount(t), rows);
    });

    it('a screen navigating to itself is 400 "self" at navigations[i].targetScreenId, before any 404 (D-84)', async () => {
      const { screen, etag } = await create({ name: 'Narcissus' });
      const res = await put(screen, etag, {
        navigations: [{ targetScreenId: target.id }, { targetScreenId: screen.id }],
        variableLinks: [{ variableId: 999999, accessMode: 'READ', usedIn: 'a.B' }],
      });
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      assert.deepEqual(bodyOf(res).details.fields, [
        { field: 'navigations[1].targetScreenId', rule: 'self', message: 'A screen cannot navigate to itself.' },
      ]);
    });

    it('the same name for a component twice is 400 "unique", not DUPLICATE_NAME (D-63)', async () => {
      const { screen, etag } = await create({ name: 'Same names' });
      const res = await put(screen, etag, {
        components: [
          { name: 'same', type: 'T' },
          { name: 'same', type: 'T' },
        ],
      });
      assert.equal(res.status, 400);
      assert.deepEqual(
        bodyOf(res).details.fields.map((f) => [f.field, f.rule]),
        [['components[1].name', 'unique']],
      );
    });
  });

  describe('D-81: the status after the edit', () => {
    const withStatus = async (status: 'UNDOCUMENTED' | 'DRAFT' | 'IN_PROGRESS' | 'APPROVED') => {
      const s = await insertScreen(t, app.id, {
        name: `Status ${status} ${Math.random()}`,
        documentationStatus: status,
      });
      return read(s.id);
    };

    it('UNDOCUMENTED becomes DRAFT only when a field gets content; renaming alone keeps it', async () => {
      const a = await withStatus('UNDOCUMENTED');
      const renamed = await put(a.screen, a.etag, { name: `${a.screen.name} renamed` });
      assert.equal(screenOf(renamed).documentationStatus, 'UNDOCUMENTED');
      const blank = await put(screenOf(renamed), String(renamed.headers.etag), {
        template: templateWith({ risks: '  ' }),
      });
      assert.equal(screenOf(blank).documentationStatus, 'UNDOCUMENTED');
      const filled = await put(screenOf(blank), String(blank.headers.etag), {
        template: templateWith({ risks: 'Real risk.' }),
      });
      assert.equal(screenOf(filled).documentationStatus, 'DRAFT');
    });

    it('DRAFT and IN_PROGRESS keep their status when edited', async () => {
      for (const status of ['DRAFT', 'IN_PROGRESS'] as const) {
        const a = await withStatus(status);
        const res = await put(a.screen, a.etag, { template: templateWith({ onStart: 'edited' }) });
        assert.equal(screenOf(res).documentationStatus, status);
      }
    });

    it('APPROVED goes back to IN_PROGRESS on any real change: a column or a nested element', async () => {
      const column = await withStatus('APPROVED');
      const byColumn = await put(column.screen, column.etag, { miroLink: 'https://miro.com/app/board/z/' });
      assert.equal(screenOf(byColumn).documentationStatus, 'IN_PROGRESS');
      const nested = await withStatus('APPROVED');
      const byNested = await put(nested.screen, nested.etag, { components: [{ name: 'new', type: 'T' }] });
      assert.equal(screenOf(byNested).documentationStatus, 'IN_PROGRESS');
      assert.notEqual(byNested.headers.etag, nested.etag);
    });

    it('a PUT without changes leaves an APPROVED screen APPROVED, with the same ETag', async () => {
      const a = await withStatus('APPROVED');
      const res = await put(a.screen, a.etag);
      assert.equal(res.status, 200);
      assert.equal(screenOf(res).documentationStatus, 'APPROVED');
      assert.equal(res.headers.etag, a.etag);
    });

    it('the status is never taken from the body', async () => {
      const a = await withStatus('DRAFT');
      const res = await put(a.screen, a.etag, { documentationStatus: 'APPROVED' });
      assert.equal(res.status, 400);
    });
  });

  describe('422 and 409', () => {
    it('SCREEN_IN_REVIEW for every role that can edit; the screen is untouched', async () => {
      const s = await insertScreen(t, app.id, { name: 'Under review', documentationStatus: 'IN_REVIEW' });
      const { screen, etag } = await read(s.id);
      for (const api of [dev(), admin()]) {
        const res = await api.put(`/screens/${s.id}`, putBodyOf(screen, { name: 'Changed' }), etag);
        assert.equal(res.status, 422);
        assert.equal(bodyOf(res).code, 'SCREEN_IN_REVIEW');
        assert.equal(
          bodyOf(res).message,
          'This screen is in review. Edit it after the review, or withdraw it from review.',
        );
        assert.equal((res.body as { details: unknown }).details, null);
      }
      assert.equal((await read(s.id)).etag, etag);
    });

    it('APPLICATION_ARCHIVED; it comes before 412 and after the 404s', async () => {
      const archivedApp = await insertApplication(t, { name: 'Archived editors' });
      const s = await insertScreen(t, archivedApp.id, { name: 'In archive' });
      const { screen, etag } = await read(s.id);
      await setApplicationStatus(t, archivedApp.id, 'ARCHIVED');
      const stale = await dev().put(`/screens/${s.id}`, putBodyOf(screen, { name: 'X' }), 'W/"1"');
      assert.equal(stale.status, 422);
      assert.equal(bodyOf(stale).code, 'APPLICATION_ARCHIVED');
      assert.deepEqual(detailsOf(stale), { applicationId: archivedApp.id });
      const missing = await dev().put(
        `/screens/${s.id}`,
        putBodyOf(screen, { navigations: [{ targetScreenId: 999999 }] }),
        etag,
      );
      assert.equal(missing.status, 404);
    });

    it('the order is 412 -> APP_CONTEXT_PROTECTED -> SCREEN_IN_REVIEW -> CROSS_APPLICATION -> CONTEXT_SCREEN_MISMATCH -> 409', async () => {
      const foreign = await insertVariable(t, other.id, { name: 'gOrderForeign' });
      const owner = await insertScreen(t, app.id, { name: 'Order owner' });
      const ctx = await insertVariable(t, app.id, { name: 'locOrderCtx', scope: 'CONTEXT', originScreenId: owner.id });
      await insertScreen(t, app.id, { name: 'Order taken' });
      const s = await insertScreen(t, app.id, { name: 'Order subject', documentationStatus: 'IN_REVIEW' });
      const { screen, etag } = await read(s.id);
      const everything = {
        name: 'Order taken',
        variableLinks: [
          { variableId: ctx.id, accessMode: 'READ', usedIn: 'a.B' },
          { variableId: foreign.id, accessMode: 'READ', usedIn: 'a.C' },
        ],
      };
      const code = async (ifMatch: string) => bodyOf(await put(screen, ifMatch, everything)).code;
      assert.equal(await code('W/"1"'), 'PRECONDITION_FAILED');
      assert.equal(await code(etag), 'SCREEN_IN_REVIEW');
      await t.owner.query(`UPDATE screen SET documentation_status = 'DRAFT' WHERE id = $1`, [s.id]);
      const fresh = (await read(s.id)).etag;
      assert.equal(await code(fresh), 'CROSS_APPLICATION');
      const withoutForeign = { ...everything, variableLinks: [everything.variableLinks[0]] };
      assert.equal(bodyOf(await put(screen, fresh, withoutForeign)).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal(bodyOf(await put(screen, fresh, { name: 'Order taken' })).code, 'DUPLICATE_NAME');
    });

    it('CROSS_APPLICATION names the first offending new link of each array', async () => {
      const foreignVar = await insertVariable(t, other.id, { name: 'gForeignPut' });
      const foreignCol = await insertCollection(t, other.id, { name: 'colForeignPut' });
      const foreignScreen = await insertScreen(t, other.id, { name: 'ForeignPut' });
      const { screen, etag } = await create({ name: 'Cross editor' });
      const cross = async (over: Record<string, unknown>, field: string) => {
        const res = await put(screen, etag, over);
        assert.equal(res.status, 422, JSON.stringify(res.body));
        assert.equal(bodyOf(res).code, 'CROSS_APPLICATION');
        assert.deepEqual(detailsOf(res), { field });
      };
      await cross(
        { variableLinks: [{ variableId: foreignVar.id, accessMode: 'READ', usedIn: 'a.B' }] },
        'variableLinks[0].variableId',
      );
      await cross(
        { collectionLinks: [{ collectionId: foreignCol.id, accessMode: 'READ', usedIn: 'a.B' }] },
        'collectionLinks[0].collectionId',
      );
      await cross({ navigations: [{ targetScreenId: foreignScreen.id }] }, 'navigations[0].targetScreenId');
      await cross(
        { components: [{ name: 'a', type: 'T', uses: [use('VARIABLE', foreignVar.id)] }] },
        'components[0].uses[0].targetId',
      );
    });

    it('CONTEXT_SCREEN_MISMATCH carries the id of the screen and the field; the origin screen itself may use READ', async () => {
      const owner = await insertScreen(t, app.id, { name: 'Context owner' });
      const ctx = await insertVariable(t, app.id, { name: 'locEdited', scope: 'CONTEXT', originScreenId: owner.id });
      const free = await insertVariable(t, app.id, { name: 'locEditedFree', scope: 'CONTEXT' });
      const { screen, etag } = await create({ name: 'Context editor' });
      const mismatch = await put(screen, etag, {
        variableLinks: [{ variableId: ctx.id, accessMode: 'READ_WRITE', usedIn: 'a.B' }],
      });
      assert.equal(mismatch.status, 422);
      assert.equal(
        bodyOf(mismatch).message,
        'locEdited belongs to Context owner. From here you can only write it with Navigate.',
      );
      assert.deepEqual(detailsOf(mismatch), {
        variableId: ctx.id,
        variable: 'locEdited',
        originScreenId: owner.id,
        screen: 'Context owner',
        screenId: screen.id,
        targetScreen: 'Context editor',
        field: 'variableLinks[0].variableId',
      });
      const noOrigin = await put(screen, etag, {
        variableLinks: [{ variableId: free.id, accessMode: 'WRITE', usedIn: 'a.B' }],
      });
      assert.equal(
        bodyOf(noOrigin).message,
        'locEditedFree has no origin screen. Set its origin screen before linking it.',
      );
      assert.deepEqual(detailsOf(noOrigin), {
        variableId: free.id,
        variable: 'locEditedFree',
        originScreenId: null,
        screenId: screen.id,
        targetScreen: 'Context editor',
        field: 'variableLinks[0].variableId',
      });
      const ownRead = await read(owner.id);
      const ok = await dev().put(
        `/screens/${owner.id}`,
        putBodyOf(ownRead.screen, { variableLinks: [{ variableId: ctx.id, accessMode: 'READ', usedIn: 'a.B' }] }),
        ownRead.etag,
      );
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    });

    it('D-85: a link that already existed is not judged again after its origin screen is deleted; a new one is', async () => {
      const origin = await insertScreen(t, app.id, { name: 'Doomed origin' });
      const ctx = await insertVariable(t, app.id, { name: 'locOrphan', scope: 'CONTEXT', originScreenId: origin.id });
      const holder = await create({
        name: 'Holder',
        variableLinks: [{ variableId: ctx.id, accessMode: 'WRITE', usedIn: 'nav.Go' }],
      });
      await deleteScreen(t, origin.id);
      const orphan = await t.owner.query(`SELECT origin_screen_id FROM variable WHERE id = $1`, [ctx.id]);
      assert.equal((orphan.rows[0] as { origin_screen_id: number | null }).origin_screen_id, null);

      const edited = await put(holder.screen, holder.etag, { template: templateWith({ onStart: 'still editable' }) });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const kept = screenOf(edited);
      assert.equal(kept.variableLinks.length, 1);
      const another = await put(kept, String(edited.headers.etag), {
        variableLinks: [
          { id: kept.variableLinks[0]!.id, variableId: ctx.id, accessMode: 'WRITE', usedIn: 'nav.Go' },
          { variableId: ctx.id, accessMode: 'WRITE', usedIn: 'nav.Other' },
        ],
      });
      assert.equal(another.status, 422);
      assert.equal(bodyOf(another).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal((detailsOf(another) as { field: string }).field, 'variableLinks[1].variableId');
      const modified = await put(kept, String(edited.headers.etag), {
        variableLinks: [{ id: kept.variableLinks[0]!.id, variableId: ctx.id, accessMode: 'READ', usedIn: 'nav.Go' }],
      });
      assert.equal(bodyOf(modified).code, 'CONTEXT_SCREEN_MISMATCH', 'a modified link is judged');
    });

    it('409 DUPLICATE_NAME only when the name changes; container "application" (D-63)', async () => {
      await create({ name: 'Occupied' });
      const { screen, etag } = await create({ name: 'Renamable' });
      const res = await put(screen, etag, { name: 'Occupied' });
      assert.equal(res.status, 409);
      assert.equal(bodyOf(res).code, 'DUPLICATE_NAME');
      assert.deepEqual(detailsOf(res), {
        field: 'name',
        type: 'screen',
        name: 'Occupied',
        application: 'Screen editors',
        container: 'application',
      });
      assert.equal((await put(screen, etag, { name: 'Renamable' })).status, 200);
      assert.equal((await put(screen, etag, { name: 'Renamed ok' })).status, 200);
    });
  });

  describe('D-87: the App (OnStart) screen', () => {
    it('cannot be renamed: 422 APP_CONTEXT_PROTECTED with its own message, before SCREEN_IN_REVIEW', async () => {
      const { screen, etag } = await read(app.appContextScreenId);
      assert.equal(screen.isAppContext, true);
      const res = await put(screen, etag, { name: 'Home' });
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'APP_CONTEXT_PROTECTED');
      assert.equal(bodyOf(res).message, "The App (OnStart) screen can't be renamed.");
      assert.equal((res.body as { details: unknown }).details, null);
      await t.owner.query(`UPDATE screen SET documentation_status = 'IN_REVIEW' WHERE id = $1`, [screen.id]);
      const stale = await put(screen, (await read(screen.id)).etag, { name: 'Home' });
      assert.equal(bodyOf(stale).code, 'APP_CONTEXT_PROTECTED');
      const other412 = await put(screen, 'W/"1"', { name: 'Home' });
      assert.equal(bodyOf(other412).code, 'PRECONDITION_FAILED', '412 comes first');
      await t.owner.query(`UPDATE screen SET documentation_status = 'UNDOCUMENTED' WHERE id = $1`, [screen.id]);
    });

    it('keeps its template, links, components and status editable', async () => {
      const { screen, etag } = await read(app.appContextScreenId);
      const res = await put(screen, etag, {
        template: templateWith({ onStart: 'Set(gAppReady, true)' }),
        components: [{ name: 'tmrBoot', type: 'Timer' }],
        variableLinks: [{ variableId: gA.id, accessMode: 'WRITE', usedIn: 'App.OnStart' }],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(screenOf(res).documentationStatus, 'DRAFT');
      assert.equal(screenOf(res).name, 'App (OnStart)');
      assert.equal((await put(screenOf(res), String(res.headers.etag), { name: 'App (OnStart)' })).status, 200);
    });
  });

  describe('roles', () => {
    it('401 without a token; 403 for a Reader with requiredRoles and nothing written', async () => {
      const { screen, etag } = await create({ name: 'Role target' });
      assert.equal((await t.http.put(`/api/v1/screens/${screen.id}`).send(putBodyOf(screen))).status, 401);
      const res = await reader().put(`/screens/${screen.id}`, putBodyOf(screen, { name: 'Hacked' }), etag);
      assert.equal(res.status, 403);
      assert.deepEqual(bodyOf(res).details, { requiredRoles: ['ADMINISTRATOR', 'DEVELOPER'] });
      assert.equal((await read(screen.id)).screen.name, 'Role target');
      assert.equal(
        (await admin().put(`/screens/${screen.id}`, putBodyOf(screen, { name: 'Admin edit' }), etag)).status,
        200,
      );
    });
  });
});
