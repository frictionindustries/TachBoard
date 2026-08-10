import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// PORT and BASE_PATH are required in dev (set by Replit workflow) but optional
// during Docker build — fall back to sane defaults so `vite build` succeeds.
const port = Number(process.env.PORT ?? 20026);
const basePath = process.env.BASE_PATH ?? "/";

// Local-dev only: bridge `/api` to the local API Server.
// On Replit the platform's path-based router proxies `/api` to the API Server
// artifact before requests ever reach Vite, so this proxy is gated to run only
// when NOT on Replit (REPL_ID is undefined). It also has no effect on the
// production build — `server.proxy` applies solely to the `vite` dev server,
// so the Docker single-container setup (Express serving the frontend and
// `/api`) is untouched. Keep frontend requests relative (`/api/...`).
// VITE_FORCE_API_PROXY=1 overrides the gate so the e2e suite (Playwright's
// embedded `pnpm run dev:local` web server) can run against localhost even
// inside a Replit workspace, where REPL_ID is always present.
const isReplit =
  process.env.REPL_ID !== undefined &&
  process.env.VITE_FORCE_API_PROXY !== "1";
const apiProxyTarget =
  process.env.VITE_API_PROXY_TARGET ?? "http://localhost:20027";
const devProxy = isReplit
  ? undefined
  : {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    };

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: devProxy,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
  // react-grid-layout (CJS) references process.env.NODE_ENV at runtime in the browser.
  // Shim it so the bundle doesn't crash with "process is not defined".
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
});
