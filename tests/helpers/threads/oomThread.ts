/** A generator thread that runs out of memory: it keeps allocating until the limit of its heap is reached. */
const hoard: number[][] = [];
for (;;) hoard.push(new Array<number>(1_000_000).fill(1));
