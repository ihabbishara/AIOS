/** halalo's client project dir is env-only since de-personalization — there is no built-in
 *  default any more. Suites that exercise the LIVE agents/ tree still need one: without it
 *  buildExtras drops halalo's extras and the halalo-readonly guard refuses to build.
 *  `??=` so a machine that really has AIOS_HALALO_DIR keeps its own value. */
export function useHalaloFixtureDir(): void {
  process.env.AIOS_HALALO_DIR ??= "/tmp/halalo-fixture";
}
