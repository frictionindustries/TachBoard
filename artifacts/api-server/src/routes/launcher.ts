import { Router, type Request } from "express";
import { requireAuth, type AuthRequest } from "../lib/auth.js";
import * as launcher from "../lib/launcher.js";

const router = Router();
const loopback = (ip: string | undefined) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip ?? "");
export function trustedTransport(req: Request) {
  // Do not change global Express trust-proxy/auth behavior. A dedicated HTTPS
  // proxy must overwrite forwarding headers and its backend must be firewalled.
  if (req.secure) return true;
  const host = req.headers.host ?? "";
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const origin = req.headers.origin;
  if (loopback(req.socket.remoteAddress) && localHost && (!origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin))) return true;
  const proxy = process.env["LAUNCHER_TRUSTED_PROXY_IP"];
  const publicOrigin = process.env["LAUNCHER_HTTPS_ORIGIN"];
  if (!proxy || !publicOrigin || req.socket.remoteAddress !== proxy || req.headers["x-forwarded-proto"] !== "https") return false;
  try {
    const url = new URL(publicOrigin);
    return url.protocol === "https:" && host === url.host && (!origin || origin === url.origin);
  } catch { return false; }
}
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!trustedTransport(req)) { res.status(426).json({ error: "Desktop control requires trusted HTTPS or a loopback SSH tunnel. See packaging/desktop/README.md." }); return; }
  if (["POST", "PUT"].includes(req.method) && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) {
    res.status(400).json({ error: "JSON object required" }); return;
  }
  next();
});
// Companion-facing routes do not accept a dashboard JWT.
router.get("/instance", (_req, res) => res.json({ instanceId: launcher.instanceId }));
router.post("/pairings/inspect", (req, res) => res.json(launcher.inspectPairing(req.body.code, req.body.instanceId)));
router.post("/pairings/approve", (req, res) => res.json(launcher.approvePairing(req.body)));
router.post("/companion/:operation", (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const d = launcher.deviceAuth(token, req.headers["x-launcher-instance"]);
  const b = req.body;
  switch (req.params.operation) {
    case "hello": res.json(launcher.hello(d, b.actions)); break;
    case "poll": res.json(launcher.poll(d, b.session, b.actions)); break;
    case "accept": res.json(launcher.accept(d, b.session, launcher.text(b.id, 36))); break;
    case "failed": launcher.reportFailure(d, b.session, launcher.text(b.id, 36)); res.json({ ok: true }); break;
    default: res.status(404).json({ error: "Unknown operation" });
  }
});
router.use(requireAuth);
router.use((req: AuthRequest, _res, next) => { launcher.owner(req.user?.userId); next(); });
router.get("/devices", (req: AuthRequest, res) => res.json(launcher.listDevices(req.user!.userId)));
router.post("/pairings", (req: AuthRequest, res) => res.json(launcher.createPairing(req.user!.userId)));
router.put("/devices/:id", (req: AuthRequest, res) => {
  launcher.renameDevice(req.user!.userId, String(req.params.id), req.body.name); res.json({ ok: true });
});
router.delete("/devices/:id", (req: AuthRequest, res) => {
  launcher.revokeDevice(req.user!.userId, String(req.params.id)); res.json({ ok: true });
});
router.post("/commands", (req: AuthRequest, res) => res.json(launcher.queue(req.user!.userId, req.body)));
router.get("/commands/:id", (req: AuthRequest, res) => res.json(launcher.command(req.user!.userId, String(req.params.id))));
router.use((err: unknown, _req: Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (err instanceof launcher.LauncherError) { res.status(err.status).json({ error: err.message }); return; }
  next(err);
});
export default router;
