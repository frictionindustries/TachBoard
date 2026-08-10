import { Router, type IRouter } from "express";
import { HealthCheckResponse, GetVersionResponse } from "@workspace/api-zod";
import { getUpdateInfo } from "../lib/updateCheck.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Current build version + (cached, failure-tolerant) latest-release info.
// Unauthenticated: it exposes nothing beyond what the public GitHub releases
// page already shows.
router.get("/version", async (_req, res) => {
  const info = await getUpdateInfo();
  res.json(GetVersionResponse.parse(info));
});

export default router;
