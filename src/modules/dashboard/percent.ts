/**
 * The percentage of approved screens (FR-19, D-106 a). Pure; exact integer arithmetic, never binary floating point
 * for the rounding.
 *
 * @module modules/dashboard/percent
 */

/**
 * `approved` over `total` as a percentage with one decimal, rounded half up.
 *
 * The tenths are `floor((2 * approved * 1000 + total) / (2 * total))`: all integers, so 6.25 gives 6.3 and 18.75 gives
 * 18.8 with no floating point error. A total of 0 gives 0; in practice it never happens, because every application
 * has its App (OnStart) screen.
 *
 * @param approved - Screens in APPROVED.
 * @param total - All the screens of the application, App (OnStart) included.
 * @returns A number with at most one decimal, from 0 to 100.
 */
export function approvedPercent(approved: number, total: number): number {
  if (total <= 0) return 0;
  const tenths = Math.floor((2000 * approved + total) / (2 * total));
  return tenths / 10;
}
