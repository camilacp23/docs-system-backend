/** A generator thread stuck in a synchronous block: only `terminate()` can stop it. */
for (;;) {
  // never yields to the event loop of the thread
}
