import { Hono } from "hono";

interface Env {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>;
  };
}

const app = new Hono<{ Bindings: Env }>();

// API status
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    system: "HYDRA Edge Node",
    version: "0.1.0",
    network: "Cloudflare Edge",
    timestamp: Date.now(),
  });
});

// Session endpoint for dashboard UI
app.get("/api/session", (c) => {
  return c.json({
    authenticated: false,
    role: "viewer",
    simulation: true,
    message: "Connected to HYDRA Cloudflare Edge Showcase. Simulation active.",
  });
});

// Models list endpoint
app.get("/api/models", (c) => {
  return c.json({
    data: [
      { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "deepseek/deepseek-chat", name: "DeepSeek V3" },
      { id: "deepseek/deepseek-r1", name: "DeepSeek R1" },
    ],
  });
});

// Fallback for WebSocket ticket request in static edge mode
app.post("/api/ws-ticket", (c) => {
  return c.json(
    {
      error: "Edge demonstration mode",
      message: "Direct WebSocket telemetry requires a running local HYDRA node.",
      simulation: true,
    },
    200
  );
});

// Fallback to static assets
app.all("*", async (c) => {
  return await c.env.ASSETS.fetch(c.req.raw);
});

export default app;
