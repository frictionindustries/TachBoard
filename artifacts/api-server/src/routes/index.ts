import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import tilesRouter from "./tiles.js";
import pagesRouter from "./pages.js";
import profileRouter from "./profile.js";
import layoutRouter from "./layout.js";
import deviceModesRouter from "./device-modes.js";
import uploadsRouter from "./uploads.js";
import widgetsRouter from "./widgets.js";
import connectionsRouter from "./connections.js";
import spotifyRouter from "./spotify.js";
import googleRouter from "./google.js";
import launcherRouter from "./launcher.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/launcher", launcherRouter);
router.use("/tiles/layout", layoutRouter);
router.use("/tiles", tilesRouter);
router.use("/pages", pagesRouter);
router.use("/profile", profileRouter);
router.use("/device-modes", deviceModesRouter);
router.use("/uploads", uploadsRouter);
router.use("/widgets", widgetsRouter);
// Spotify's dedicated OAuth + control endpoints. Mounted before the generic
// connections router so its specific paths win over /connections/:service.
router.use("/connections/spotify", spotifyRouter);
// Google link status/disconnect for the Settings card (the OAuth flow itself
// lives under /widgets/gmail). Mounted before the generic connections router.
router.use("/connections/google", googleRouter);
router.use("/connections", connectionsRouter);

export default router;
