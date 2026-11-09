/** db/reconcile: order of the writes under non-deferrable unique indexes (D-26), on an in-memory table. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reconcile, type ReconcileSpec } from '../../src/db/reconcile.js';

type Row = { id: number; name: string; note: string };
type Item = { id?: number; name: string; note: string };

/** A table whose unique index on `name` is checked on every write, like PostgreSQL does for a plain UNIQUE. */
function makeTable(initial: Row[]) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  const log: string[] = [];
  let nextId = 100;
  const assertFree = (name: string, self?: number) => {
    for (const r of rows.values()) if (r.name === name && r.id !== self) throw new Error(`unique violation on ${name}`);
  };
  const spec: ReconcileSpec<Row, Item> = {
    keyOf: (x) => x.name,
    isSame: (c, w) => c.name === w.name && c.note === w.note,
    remove: (ids) => {
      for (const id of ids) rows.delete(id);
      log.push(`delete ${ids.join(',')}`);
      return Promise.resolve();
    },
    update: (c, w) => {
      assertFree(w.name, c.id);
      rows.set(c.id, { id: c.id, name: w.name, note: w.note });
      log.push(`update ${c.id}`);
      return Promise.resolve();
    },
    create: (w) => {
      assertFree(w.name);
      rows.set((nextId += 1), { id: nextId, name: w.name, note: w.note });
      log.push(`create ${w.name}`);
      return Promise.resolve();
    },
    park: (c, taken) => {
      let n = 1;
      while (taken.has(`~swap~${c.id}~${n}`)) n += 1;
      const name = `~swap~${c.id}~${n}`;
      return {
        key: name,
        write: () => {
          assertFree(name, c.id);
          rows.get(c.id)!.name = name;
          log.push(`park ${c.id}`);
          return Promise.resolve();
        },
      };
    },
  };
  return { rows, log, spec, current: () => [...rows.values()].map((r) => ({ ...r })) };
}

const names = (t: ReturnType<typeof makeTable>) => [...t.rows.values()].sort((a, b) => a.id - b.id).map((r) => r.name);

describe('reconcile', () => {
  it('writes nothing when nothing changes', async () => {
    const t = makeTable([{ id: 1, name: 'a', note: '' }]);
    const r = await reconcile(t.current(), [{ id: 1, name: 'a', note: '' }], t.spec);
    assert.deepEqual(r, { deleted: 0, updated: 0, created: 0, parked: 0 });
    assert.deepEqual(t.log, []);
  });

  it('swaps two names, keeping both ids, parking exactly one row', async () => {
    const t = makeTable([
      { id: 1, name: 'a', note: '' },
      { id: 2, name: 'b', note: '' },
    ]);
    const r = await reconcile(
      t.current(),
      [
        { id: 1, name: 'b', note: '' },
        { id: 2, name: 'a', note: '' },
      ],
      t.spec,
    );
    assert.deepEqual(names(t), ['b', 'a']);
    assert.equal(r.parked, 1);
    assert.equal(r.updated, 2);
  });

  it('rotates three names', async () => {
    const t = makeTable([
      { id: 1, name: 'a', note: '' },
      { id: 2, name: 'b', note: '' },
      { id: 3, name: 'c', note: '' },
    ]);
    await reconcile(
      t.current(),
      [
        { id: 1, name: 'b', note: '' },
        { id: 2, name: 'c', note: '' },
        { id: 3, name: 'a', note: '' },
      ],
      t.spec,
    );
    assert.deepEqual(names(t), ['b', 'c', 'a']);
  });

  it('orders a chain without parking anyone', async () => {
    const t = makeTable([
      { id: 1, name: 'a', note: '' },
      { id: 2, name: 'b', note: '' },
    ]);
    const r = await reconcile(
      t.current(),
      [
        { id: 1, name: 'b', note: '' },
        { id: 2, name: 'c', note: '' },
      ],
      t.spec,
    );
    assert.deepEqual(names(t), ['b', 'c']);
    assert.equal(r.parked, 0);
  });

  it('deletes first, so a new item can take the name of a deleted one; creates last', async () => {
    const t = makeTable([
      { id: 1, name: 'a', note: '' },
      { id: 2, name: 'b', note: '' },
    ]);
    const r = await reconcile(
      t.current(),
      [
        { id: 1, name: 'b', note: '' },
        { name: 'a', note: '' },
      ],
      t.spec,
    );
    assert.deepEqual(r, { deleted: 1, updated: 1, created: 1, parked: 0 });
    assert.equal(t.log[0], 'delete 2');
    assert.equal(t.log.at(-1), 'create a');
  });

  it('the temporary value never collides with current or wanted values', async () => {
    const t = makeTable([
      { id: 1, name: 'a', note: '' },
      { id: 2, name: 'b', note: '' },
      { id: 3, name: '~swap~1~1', note: '' },
    ]);
    await reconcile(
      t.current(),
      [
        { id: 1, name: 'b', note: '' },
        { id: 2, name: 'a', note: '' },
        { id: 3, name: '~swap~1~1', note: 'x' },
      ],
      t.spec,
    );
    assert.deepEqual(names(t), ['b', 'a', '~swap~1~1']);
  });

  it('rejects an id that is not one of the stored rows', async () => {
    const t = makeTable([{ id: 1, name: 'a', note: '' }]);
    await assert.rejects(
      reconcile(t.current(), [{ id: 9, name: 'a', note: '' }], t.spec),
      /not one of the stored rows/,
    );
  });
});
