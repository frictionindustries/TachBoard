import { test, expect } from "./fixtures";
import fs from "fs";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Passphrase-protected profile exports.
//
// When "Include service connections" is checked, the export dialog offers an
// optional passphrase. With one set, the downloaded file is an AES-GCM
// encrypted envelope (format "tachboard-profile-encrypted") produced entirely
// client-side — credentials never appear in readable form. Importing such a
// file prompts for the passphrase: a wrong one shows a clear inline error,
// the right one unlocks the normal import dialog. All of this is browser-only
// Web Crypto work that a jsdom unit test cannot exercise end-to-end.
// ---------------------------------------------------------------------------

const PASSPHRASE = "correct horse battery";

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

test("passphrase-protected export downloads an encrypted file and import round-trips it", async ({
  page,
}) => {
  const reg = await page.request.post("/api/auth/register", {
    data: { username: `enc-${rand()}`, password: `pw-${rand()}` },
  });
  expect(reg.ok(), `register failed: ${reg.status()}`).toBeTruthy();
  const { token } = (await reg.json()) as { token: string };
  await page.addInitScript((t) => {
    window.localStorage.setItem("token", t as string);
  }, token);

  await page.goto("/settings");

  // --- Export with a passphrase -------------------------------------------
  await page.getByTestId("button-export-profile").click();
  // No passphrase field until credentials are opted in.
  await expect(page.getByTestId("input-export-passphrase")).toHaveCount(0);
  await page.getByTestId("checkbox-include-connections").click();
  await page.getByTestId("input-export-passphrase").fill(PASSPHRASE);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("button-confirm-export").click(),
  ]);
  const filePath = path.join(os.tmpdir(), `enc-profile-${rand()}.json`);
  await download.saveAs(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  expect(parsed["format"]).toBe("tachboard-profile-encrypted");
  expect(typeof parsed["ciphertext"]).toBe("string");
  // Nothing recognizable from the plain envelope leaks into the file.
  expect(content).not.toContain('"pages"');
  expect(content).not.toContain('"connections"');

  // --- Import: wrong passphrase gives a clear inline error -----------------
  await page.getByTestId("input-import-profile-file").setInputFiles(filePath);
  await expect(page.getByTestId("input-import-passphrase")).toBeVisible();
  await page.getByTestId("input-import-passphrase").fill("wrong-pass");
  await page.getByTestId("button-confirm-decrypt").click();
  await expect(page.getByTestId("text-decrypt-error")).toContainText(/wrong passphrase/i);

  // --- Right passphrase unlocks the normal import dialog -------------------
  await page.getByTestId("input-import-passphrase").fill(PASSPHRASE);
  await page.getByTestId("button-confirm-decrypt").click();
  await expect(page.getByTestId("button-mode-merge")).toBeVisible();
  await expect(page.getByTestId("input-import-passphrase")).toHaveCount(0);

  fs.unlinkSync(filePath);
});
