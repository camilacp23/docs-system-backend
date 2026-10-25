/**
 * Reconciliation of a nested array by id (D-26): items with an id are updated, items without one are created and the
 * existing items left out are deleted, so every surviving row keeps its id and its audit history.
 *
 * The unique indexes of the nested tables are not deferrable: PostgreSQL checks them row by row, even inside one
 * statement, so a PUT that swaps two names (or rotates three) would fail halfway although the final state is valid.
 * The writes are therefore ordered, with no migration:
 *
 * 1. delete what was left out (frees values);
 * 2. update in dependency order: a row whose new value is still held by another surviving row waits for it;
 * 3. when the waiting rows form a cycle (a swap, a rotation) ONE row is parked on a temporary value, which frees
 *    the cycle; the row reaches its final value later with its own UPDATE;
 * 4. create what is new, last, when every value it needs is free.
 *
 * The database stays the judge of the final state: this only chooses the order. Written generically on purpose
 * (components, links and navigations of Module 4 reuse it).
 *
 * @module db/reconcile
 */

/** What `reconcile` needs to know about one nested array. */
export type ReconcileSpec<Current extends { id: number }, Wanted extends { id?: number | undefined }> = {
  /**
   * The value the unique index is built on, as a string: the same text for the same value. Called for the stored rows
   * and for the wanted items.
   */
  keyOf: (item: Current | Wanted) => string;
  /** Whether the stored row already has the content of the wanted item (nothing to write). */
  isSame: (current: Current, wanted: Wanted) => boolean;
  /** Deletes rows by id. */
  remove: (ids: number[]) => Promise<void>;
  /** Writes the wanted content on a stored row (its key may change). */
  update: (current: Current, wanted: Wanted) => Promise<void>;
  /** Inserts a new item. */
  create: (wanted: Wanted, index: number) => Promise<void>;
  /**
   * Parks a row on a temporary value that respects the limits and CHECKs of the column (length, not blank) and is not
   * in `taken` (current and wanted values). Returns the key of that value and the write that stores it.
   */
  park: (current: Current, taken: ReadonlySet<string>) => { key: string; write: () => Promise<void> };
};

/** How many rows each step wrote. Zero everywhere means the array already was as wanted. */
export type ReconcileResult = { deleted: number; updated: number; created: number; parked: number };

/**
 * Makes the stored rows equal to the wanted items, writing only what differs.
 *
 * @param current - Stored rows (all with an id).
 * @param wanted - Wanted items, in payload order. An id must be one of the stored rows (the service checks it first).
 * @param spec - Keys, comparison and writes of the array.
 * @returns How many rows were deleted, updated, created and parked.
 */
export async function reconcile<Current extends { id: number }, Wanted extends { id?: number | undefined }>(
  current: readonly Current[],
  wanted: readonly Wanted[],
  spec: ReconcileSpec<Current, Wanted>,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { deleted: 0, updated: 0, created: 0, parked: 0 };
  const byId = new Map(current.map((c) => [c.id, c]));
  const kept = new Set<number>();
  for (const w of wanted) {
    if (w.id === undefined) continue;
    if (!byId.has(w.id)) throw new Error(`reconcile: item ${w.id} is not one of the stored rows`);
    kept.add(w.id);
  }

  const gone = current.filter((c) => !kept.has(c.id)).map((c) => c.id);
  if (gone.length > 0) {
    await spec.remove(gone);
    result.deleted = gone.length;
  }

  // Values held right now by the surviving rows.
  const held = new Map<string, number>();
  for (const c of current) if (kept.has(c.id)) held.set(spec.keyOf(c), c.id);

  type Pending = { row: Current; item: Wanted; from: string; to: string };
  const pending: Pending[] = [];
  for (const w of wanted) {
    if (w.id === undefined) continue;
    const row = byId.get(w.id)!;
    if (spec.isSame(row, w)) continue;
    pending.push({ row, item: w, from: spec.keyOf(row), to: spec.keyOf(w) });
  }

  const taken = new Set<string>([...held.keys(), ...wanted.map((w) => spec.keyOf(w))]);
  const apply = async (p: Pending): Promise<void> => {
    await spec.update(p.row, p.item);
    result.updated += 1;
    if (held.get(p.from) === p.row.id) held.delete(p.from);
    held.set(p.to, p.row.id);
  };

  while (pending.length > 0) {
    // A row whose value does not change, or whose new value is free, can be written now.
    const ready = pending.findIndex((p) => p.from === p.to || !held.has(p.to));
    if (ready >= 0) {
      await apply(pending.splice(ready, 1)[0]!);
      continue;
    }
    // Everyone waits for another pending row (a surviving row that does not move cannot hold a wanted value, the
    // final state would repeat it). Following "waits for" from any row ends in a cycle; park a row OF that cycle,
    // so that the row waiting for its value can go next.
    const waitsFor = (p: Pending): Pending => pending.find((q) => held.get(p.to) === q.row.id)!;
    const walked = new Set<Pending>();
    let onCycle = pending[0]!;
    while (!walked.has(onCycle)) {
      walked.add(onCycle);
      onCycle = waitsFor(onCycle);
    }
    const parked = spec.park(onCycle.row, taken);
    await parked.write();
    result.parked += 1;
    taken.add(parked.key);
    held.delete(onCycle.from);
    held.set(parked.key, onCycle.row.id);
    onCycle.from = parked.key;
  }

  let index = 0;
  for (const w of wanted) {
    if (w.id === undefined) {
      await spec.create(w, index);
      result.created += 1;
    }
    index += 1;
  }
  return result;
}
