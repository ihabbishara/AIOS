import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import { isPrivateOrigin } from "../agents/direct.js";

export interface HandOffDeps {
  registry: LoadedRegistry;
  runSpecialist: SpecialistRunFn;
  bus: EventBus;
  /** The private primary chat — privateOnly agents are refused from any other origin. */
  primaryChat?: { channel: string; chatId: string };
  projectsRoot: string;
}

/**
 * Inline hand-off from the Chief of Staff to a named agent, running with the agent's FULL
 * tool set — the same capability as an @mention. The REAL per-turn origin is threaded through
 * so:
 *   - privateOnly agents (faris, jasmine) are refused from any non-private origin — a group
 *     member can never reach a private agent (and their private tools) via hand_off;
 *   - the route.decision trail records the true channel/chatId of the attempt;
 *   - resolveDeptFor + runSpecialist see the originating chat, so ledger writes land in that
 *     chat's ledger and gate actions are attributed to the right origin.
 */
export function makeHandOff(deps: HandOffDeps) {
  return async (
    agent: string,
    task: string,
    origin: { channel: string; chatId: string },
  ): Promise<{ text: string }> => {
    const canonical = deps.registry.agentOf.get(agent) ?? agent;
    const role = deps.registry.agents.get(canonical)?.role;

    if (role?.privateOnly && !isPrivateOrigin(deps.primaryChat, origin.channel, origin.chatId)) {
      // Record the refused attempt in the route trail — using the REAL origin, not system:handoff.
      deps.bus.emit({
        type: "route.decision", to: canonical, via: "handoff",
        reason: "refused: private agent from non-private origin",
        channel: origin.channel, chatId: origin.chatId,
      });
      return { text: `That's private — ${canonical} only answers in your private chat.` };
    }

    deps.bus.emit({
      type: "route.decision", to: canonical, via: "handoff",
      reason: "chief of staff hand_off", channel: origin.channel, chatId: origin.chatId,
    });
    // resolveAgent (inside runSpecialist) resolves the agent's capabilities/dept/model.
    const res = await deps.runSpecialist(agent, task, {
      cwd: deps.projectsRoot, origin,
      mailCtx: { origin, goalDepth: 0 },
    });
    return { text: res.text };
  };
}
