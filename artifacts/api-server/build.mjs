import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build as esbuild, context as esbuildContext } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Local-dev hot reload: after each successful rebuild, (re)spawn the server.
// Only used when this script is invoked with `--watch` (the `dev:watch` script);
// the normal one-shot build path is unaffected.
function makeRestartPlugin(entryFile) {
  let child = null;
  const stop = () => {
    if (child && !child.killed) child.kill("SIGTERM");
    child = null;
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  return {
    name: "restart-server",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) {
          console.error("[dev:watch] build failed — server not restarted");
          return;
        }
        stop();
        child = spawn("node", ["--enable-source-maps", entryFile], {
          stdio: "inherit",
          env: process.env,
        });
      });
    },
  };
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  const esbuildOptions = {
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Release builds stamp the version + GitHub repo slug from the git tag
    // (release workflow sets APP_VERSION / APP_REPO). Dev builds leave them
    // empty and the server falls back to env vars / "dev".
    define: {
      __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? ""),
      __APP_REPO__: JSON.stringify(process.env.APP_REPO ?? ""),
    },
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      // jsdom (pulled in by isomorphic-dompurify) reads asset files such as
      // browser/default-stylesheet.css via __dirname-relative path traversal,
      // which breaks once bundled. Externalize isomorphic-dompurify so it (and
      // its nested jsdom) load from node_modules at runtime instead.
      "isomorphic-dompurify",
      // gamedig ships a large game/protocol registry it resolves at runtime;
      // load it from node_modules instead of bundling it.
      "gamedig",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  };

  if (!watch) {
    await esbuild(esbuildOptions);
    return;
  }

  // Watch mode (local dev): rebuild on change and restart the server via the
  // restart plugin's onEnd hook (which fires after the initial build too).
  const entryFile = path.resolve(distDir, "index.mjs");
  const ctx = await esbuildContext({
    ...esbuildOptions,
    logLevel: "silent",
    plugins: [...esbuildOptions.plugins, makeRestartPlugin(entryFile)],
  });
  await ctx.watch();
  console.log("[dev:watch] watching for changes — press Ctrl+C to stop");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
