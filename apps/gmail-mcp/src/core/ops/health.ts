// health_check op — the canary tool. Never touches Gmail; answers
// instantly so health is reachable even when the network is down.

import { formatHealthText, snapshotHealth } from "../../robustness/index.js";
import { HealthCheckSchema } from "../../tools.js";
import { getRecentErrorCount, getToolCallCount } from "../session.js";
import { type Operation, registry } from "../registry.js";

const op: Operation<unknown> = {
  name: "health_check",
  schema: HealthCheckSchema,
  scopes: [],
  handler: async (_input, _ctx) => {
    const snap = snapshotHealth({
      toolCalls: getToolCallCount(),
      recentErrors: getRecentErrorCount(),
    });
    return {
      content: [{ type: "text", text: formatHealthText(snap) }],
    };
  },
};

registry.register(op);
