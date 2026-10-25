/**
 * Repeated values inside one payload (D-65): a 400 `unique` that names the position of each repetition.
 *
 * @module http/repeats
 */
import type { FieldError } from '../security/errors.js';

/**
 * Field errors for the items of an array whose key repeats an earlier item (the first one is not reported).
 *
 * @param items - The array, in payload order.
 * @param keyOf - The value that must be unique; `undefined` means "no key, skip" (for example an absent id).
 * @param fieldOf - Path reported for the item at an index (for example `fields[2].name`).
 */
export function repeatedFields<T>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
  fieldOf: (index: number) => string,
): FieldError[] {
  const seen = new Set<string>();
  const fields: FieldError[] = [];
  items.forEach((item, index) => {
    const key = keyOf(item);
    if (key === undefined) return;
    if (seen.has(key)) {
      fields.push({
        field: fieldOf(index),
        rule: 'unique',
        message: 'This value is repeated. Each one must be unique.',
      });
    }
    seen.add(key);
  });
  return fields;
}
