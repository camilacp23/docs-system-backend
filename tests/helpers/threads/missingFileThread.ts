/** A generator thread that imports a file of the repository that does not exist (what a missing generator looks like). */
// @ts-expect-error the file does not exist, on purpose
await import('../../../src/jobs/reports/no-such-generator.js');
