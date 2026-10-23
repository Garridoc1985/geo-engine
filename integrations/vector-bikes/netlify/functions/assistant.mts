import { assistantResponse } from "../../src/server/assistant.ts";

export default assistantResponse;

export const config = {
  path: "/api/asistente",
  rateLimit: {
    action: "rate_limit",
    aggregateBy: ["ip", "domain"],
    windowSize: 60,
    windowLimit: 5,
  },
};
