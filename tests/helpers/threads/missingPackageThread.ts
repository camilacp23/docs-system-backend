/** A generator thread that imports a package that is not installed (a dependency that is not declared). */
// @ts-expect-error the package does not exist, on purpose
await import('no-such-package-for-the-test');
