import { execFileSync } from "node:child_process";

export default function globalSetup() {
  execFileSync("pnpm", ["--filter", "@workspace/api-server", "run", "build"], {
    stdio: "inherit",
  });
}