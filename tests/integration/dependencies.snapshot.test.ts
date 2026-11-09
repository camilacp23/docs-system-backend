/**
 * Module 5, one snapshot per read (FR-15; D-104): the graph and the environment keys are read in the same
 * REPEATABLE READ transaction, so a write committed by another connection in between is not seen. The repository takes
 * an optional callback that production never passes; here it commits a change with the owner connection after the graph
 * was read and before the environment is. Without REPEATABLE READ the second read would see the change and the variable
 * would vanish from a response that otherwise still contains it.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { assertNoDanglingEdges, keyOf, seedSar, type SarFixture } from '../helpers/dependencies.js';
import { createDependenciesRepository } from '../../src/modules/dependencies/repository.js';
import { createDependenciesService } from '../../src/modules/dependencies/service.js';

describe('dependencies: one snapshot per read', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let f: SarFixture;

  before(async () => {
    t = await startTestApp();
    try {
      f = await seedSar(t);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  /** A service whose repository runs `change` once, inside the snapshot, between the graph and the environment. */
  const serviceWith = (change: () => Promise<unknown>) => {
    let done = false;
    return createDependenciesService(
      createDependenciesRepository(t.db, {
        afterGraph: async () => {
          if (done) return;
          done = true;
          await change();
        },
      }),
    );
  };

  it('a variable (gUsuario) removed from DEV by another connection in the middle of the read is still in the response', async () => {
    const service = serviceWith(() =>
      t.owner.query(`DELETE FROM element_environment WHERE element_id = $1 AND environment = 'DEV'`, [f.gUsuario]),
    );
    const graph = await service.graph({ applicationId: f.sar.id, environment: 'DEV' });
    assertNoDanglingEdges({ nodes: graph.nodes, edges: graph.edges });
    assert.ok(
      graph.nodes.some((n) => n.key === keyOf('variable', f.gUsuario)),
      'the snapshot was taken before the change',
    );
    assert.ok(
      graph.edges.some((e) => e.kind === 'FEEDS'),
      'and so are the edges that depend on it',
    );

    // The next read, a new snapshot, sees the committed change.
    const next = await createDependenciesService(createDependenciesRepository(t.db)).graph({
      applicationId: f.sar.id,
      environment: 'DEV',
    });
    assert.ok(!next.nodes.some((n) => n.key === keyOf('variable', f.gUsuario)));
    assertNoDanglingEdges({ nodes: next.nodes, edges: next.edges });
  });

  it('the same holds for the neighborhood of an element', async () => {
    const service = serviceWith(() => t.owner.query(`DELETE FROM dependency WHERE id = $1`, [f.rows.usesBtn]));
    const graph = await service.neighborhood({ type: 'VARIABLE', id: f.locFiltro, depth: 1 });
    assertNoDanglingEdges({ nodes: graph.nodes, edges: graph.edges });
    const later = await createDependenciesService(createDependenciesRepository(t.db)).neighborhood({
      type: 'VARIABLE',
      id: f.locFiltro,
      depth: 1,
    });
    assert.ok(!later.nodes.some((n) => n.key === keyOf('component', f.btnFiltrar)), 'the next snapshot has the change');
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
