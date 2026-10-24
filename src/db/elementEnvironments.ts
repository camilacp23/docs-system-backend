/**
 * Presence of a variable or a collection in DEV / PROD (`element_environment`, D-04), shared by the modules that
 * document those elements so none of them repeats the difference logic.
 *
 * @module db/elementEnvironments
 */
import type { Environment, PrismaClient } from '../generated/prisma/client.js';

/** Presence to write for one environment. */
export type EnvironmentInput = { environment: Environment; notes: string | null };

/**
 * Makes the environments of an element equal to `wanted` by difference: delete, update notes, insert.
 *
 * @param client - Plain or transaction client.
 * @param elementId - Id of the variable or collection.
 * @param elementType - Which of the two it is.
 * @param current - Environments stored now.
 * @param wanted - Environments wanted.
 */
export async function replaceElementEnvironments(
  client: Pick<PrismaClient, 'elementEnvironment'>,
  elementId: number,
  elementType: 'VARIABLE' | 'COLLECTION',
  current: readonly EnvironmentInput[],
  wanted: readonly EnvironmentInput[],
): Promise<void> {
  const wantedNames = wanted.map((e) => e.environment);
  const gone = current.filter((e) => !wantedNames.includes(e.environment)).map((e) => e.environment);
  if (gone.length > 0) {
    await client.elementEnvironment.deleteMany({ where: { elementId, environment: { in: gone } } });
  }
  for (const e of wanted) {
    const existing = current.find((c) => c.environment === e.environment);
    if (existing === undefined) {
      await client.elementEnvironment.create({
        data: { elementId, elementType, environment: e.environment, notes: e.notes },
      });
    } else if (existing.notes !== e.notes) {
      await client.elementEnvironment.update({
        where: { elementId_environment: { elementId, environment: e.environment } },
        data: { notes: e.notes },
      });
    }
  }
}
