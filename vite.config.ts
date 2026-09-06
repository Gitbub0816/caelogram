import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import { createServer } from "./src/server";
import { Store } from "./src/store";
import { Service } from "./src/service";
import { GitHub } from "./src/github";
import { processJobs } from "./src/worker";
export default defineConfig({
  root: "web",
  plugins: [
    react(),
    {
      name: "caelogram-development-api",
      configureServer(server) {
        const store = new Store(
            ".data/development.db",
            process.env.CAELOGRAM_DATA_KEY,
          ),
          service = new Service(store, new GitHub());
        const token =
          process.env.CAELOGRAM_TOKEN ?? randomBytes(32).toString("hex");
        const api = createServer(service, token);
        if (!process.env.CAELOGRAM_TOKEN)
          server.config.logger.info(
            "Development-only Caelogram token: " + token,
          );
        server.middlewares.use((req, res, next) => {
          if (
            ["/api/", "/mcp", "/health", "/.well-known/", "/webhooks/"].some(
              (p) => req.url?.startsWith(p),
            )
          )
            api(req, res, next);
          else next();
        });
        let working = false;
        const worker = setInterval(() => {
          if (working) return;
          working = true;
          void processJobs(service).finally(() => (working = false));
        }, 5000);
        server.httpServer?.once("close", () => {
          clearInterval(worker);
          store.close();
        });
      },
    },
  ],
  build: { outDir: "../public", emptyOutDir: true },
  server: { host: "0.0.0.0", allowedHosts: ["terminal.local"], port: 5173 },
});
