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
    gateway: "YEScale AI Gateway",
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
      { id: "claude-fable-5-1", name: "Claude Fable 5.1 (Commander)" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (Supervisor/Sales)" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol (Treasurer)" },
      { id: "gpt-6-astra", name: "GPT-6 Astra (Coach)" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
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
