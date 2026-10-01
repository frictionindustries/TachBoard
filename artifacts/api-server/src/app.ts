import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { createAuthIngress } from "./lib/authResources.js";

const dataDir = process.env["DATA_DIR"] || "./data";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Auth is deliberately parsed/throttled first; imports keep their larger limit.
app.use("/api/auth", createAuthIngress());
// Allow a generous JSON body so page-import uploads (which can contain many
// tiles and their settings) aren't rejected by the default 100kb limit.
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files.
//
// Defense in depth: uploads are validated/sanitized server-side (see
// routes/uploads.ts) so nothing script-bearing should ever land here, but we
// still serve them with headers that prevent this route from ever being
// usable as a same-origin script execution vector even if that validation is
// ever bypassed or weakened in the future:
//  - X-Content-Type-Options: nosniff stops browsers from MIME-sniffing a
//    file into something more dangerous than its declared Content-Type.
//  - A strict per-response CSP (script-src 'none'; sandbox) means that even
//    an SVG containing a <script> tag cannot execute if it's navigated to
//    directly, because the CSP applies to the response itself.
//  - Content-Disposition stays inline so normal image rendering (avatars,
//    tile backgrounds, etc.) is unaffected.
app.use(
  "/api/uploads/files",
  express.static(path.join(dataDir, "uploads"), {
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    },
  }),
);

// API routes
app.use("/api", router);

// Serve frontend static assets in production (Docker single-container mode)
// The Dockerfile copies the Vite build output to /frontend-dist
const frontendDistDir =
  process.env["FRONTEND_DIST"] ||
  path.resolve(import.meta.dirname, "../../../frontend-dist");

if (process.env["NODE_ENV"] === "production" && fs.existsSync(frontendDistDir)) {
  app.use(express.static(frontendDistDir));

  // SPA fallback — serve index.html for any non-API GET route.
  // Express 5 (path-to-regexp 8) rejects a bare "*" path, so use a final
  // middleware that filters method/path manually instead of a wildcard route.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }
    const indexHtml = path.join(frontendDistDir, "index.html");
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.status(404).send("Frontend build not found");
    }
  });
}

export default app;
