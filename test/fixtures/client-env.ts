/** A client project is env-only since de-personalization — there is no built-in default any
 *  more, and since the de-clienting refactor the agent's NAME is env too (product source must not
 *  name one operator's client). Suites that exercise the LIVE agents/ tree still need both:
 *  without them buildExtras drops the client extras and the aws-readonly guard refuses to build.
 *  `??=` so a machine that really has these keeps its own values. */
export function useClientFixtureDir(): void {
  process.env.AIOS_CLIENT_AGENT ??= "halalo";
  process.env.AIOS_CLIENT_DIR ??= "/tmp/client-fixture";
}
