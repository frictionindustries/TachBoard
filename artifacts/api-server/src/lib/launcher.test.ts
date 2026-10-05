import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-test-"));
vi.stubEnv("DATA_DIR", dir);
const { db } = await import("./db.js");
const L = await import("./launcher.js");
const { default: router, trustedTransport } = await import("../routes/launcher.js");
const { signToken } = await import("./auth.js");
const { createImportedTile, formatTile } = await import("../routes/tiles.js");
const { default: profileRouter } = await import("../routes/profile.js");
const app = express();
let testPeer: string | undefined;
app.use((req, _res, next) => { testPeer = req.socket.remoteAddress; next(); });
app.use(express.json());
app.use("/api/launcher", router);
app.use("/api/profile", profileRouter);
let now = 2_000_000_000_000;
const catalog = [{ id: "editor", name: "Editor" }];
function paired() {
  const p = L.createPairing(1, now);
  const credentials = L.approvePairing({ code: p.code, instanceId: L.instanceId, approved: true, actions: catalog, name: "Desktop" }, now);
  const d = L.deviceAuth(credentials.token, L.instanceId);
  const { session } = L.hello(d, catalog, now);
  return { ...credentials, d, session };
}
const input = (deviceId: string, requestId = randomUUID()) => ({ instanceId: L.instanceId, deviceId, actionId: "editor", requestId });
const auth = (id = 1) => `Bearer ${signToken({ userId: id, username: `user${id}` })}`;
beforeEach(() => {
  now += 61_000;
  db.prepare("DELETE FROM launcher_commands").run();
  db.prepare("DELETE FROM launcher_devices").run();
  db.prepare("DELETE FROM users").run();
  db.prepare("INSERT INTO users(id,username,password) VALUES(1,'owner','unused'),(2,'other','unused')").run();
});
afterAll(() => { db.close(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("instance-scoped launcher protocol", () => {
  it("requires explicit local approval, expires invitations and consumes them once", () => {
    const p = L.createPairing(1, now);
    const body = { code: p.code, instanceId: L.instanceId, name: "PC", actions: catalog };
    expect(() => L.approvePairing(body, now)).toThrow("Explicit local approval");
    expect(() => L.approvePairing({ ...body, approved: true }, now + L.PAIR_TTL)).toThrow("expired");
    const p2 = L.createPairing(1, now);
    L.approvePairing({ ...body, code: p2.code, approved: true }, now);
    expect(() => L.approvePairing({ ...body, code: p2.code, approved: true }, now)).toThrow("expired");
  });
  it("denies other accounts on all dashboard routes, even with a pairing code", async () => {
    const { deviceId } = paired();
    const endpoints: [string, string, object][] = [
      ["get", "/devices", {}], ["post", "/pairings", {}],
      ["put", `/devices/${deviceId}`, { name: "stolen" }],
      ["delete", `/devices/${deviceId}`, {}], ["post", "/commands", input(deviceId)],
      ["get", "/commands/unknown", {}],
    ];
    for (const [method, route, body] of endpoints) {
      const client = request(app) as any;
      const response = await client[method]("/api/launcher" + route).set("Host", "localhost").set("Authorization", auth(2)).send(body);
      expect(response.status).toBe(403);
    }
  });
  it("denies cross-instance codes, credentials and tile bindings", () => {
    const p = L.createPairing(1, now);
    expect(() => L.inspectPairing(p.code, "another-instance", now)).toThrow("Wrong server");
    const c = paired();
    expect(() => L.deviceAuth(c.token, randomUUID())).toThrow("Wrong server");
    expect(() => L.queue(1, { ...input(c.deviceId), instanceId: randomUUID() }, now)).toThrow("Rebind");
    expect(() => L.deviceAuth(auth().slice(7), L.instanceId)).toThrow("unknown");
  });
  it("rate limits creation and anonymous guesses independently of source addresses", () => {
    for (let i = 0; i < 5; i++) L.createPairing(1, now);
    expect(() => L.createPairing(1, now)).toThrow("Too many");
    for (let i = 0; i < 20; i++) expect(() => L.inspectPairing("invalid", L.instanceId, now)).toThrow("expired");
    expect(() => L.inspectPairing("invalid", L.instanceId, now)).toThrow("Too many");
  });
  it("revocation blocks credentials and fails pending requests immediately", () => {
    const c = paired(), q = L.queue(1, input(c.deviceId), now);
    L.revokeDevice(1, c.deviceId);
    expect(() => L.deviceAuth(c.token, L.instanceId)).toThrow("revoked");
    expect(() => L.accept(c.d, c.session, q.id, now)).toThrow();
    expect(L.command(1, q.id, now).status).toBe("failed");
    expect(L.listDevices(1, now).devices[0]).toMatchObject({ revoked: true, online: false });
  });
  it("action removal cancels pending work and rejects new commands", () => {
    const c = paired(), q = L.queue(1, input(c.deviceId), now);
    expect(L.poll(c.d, c.session, [], now).commands).toEqual([]);
    expect(L.command(1, q.id, now).status).toBe("failed");
    expect(() => L.queue(1, input(c.deviceId), now)).toThrow("removed");
    expect(() => L.accept(c.d, c.session, q.id, now)).toThrow();
  });
  it("expires requests before delivery and rejects offline queues", () => {
    const c = paired(), q = L.queue(1, input(c.deviceId), now);
    expect(L.poll(c.d, c.session, catalog, now + L.COMMAND_TTL).commands).toEqual([]);
    expect(L.command(1, q.id, now + L.COMMAND_TTL).status).toBe("expired");
    expect(() => L.queue(1, input(c.deviceId), now + L.LIVE_TTL * 2)).toThrow("offline");
  });
  it("deduplicates retries and consumes the grant only once, including reconnects", () => {
    const c = paired(), payload = input(c.deviceId);
    const q = L.queue(1, payload, now);
    expect(L.queue(1, payload, now)).toMatchObject({ id: q.id });
    expect(L.poll(c.d, c.session, catalog, now).commands).toHaveLength(1);
    L.accept(c.d, c.session, q.id, now);
    expect(() => L.accept(c.d, c.session, q.id, now)).toThrow("consumed");
    expect(L.queue(1, payload, now).status).toBe("accepted");
    const pending = L.queue(1, input(c.deviceId), now);
    const next = L.hello(c.d, catalog, now);
    expect(L.poll(c.d, next.session, catalog, now).commands).toEqual([]);
    expect(L.command(1, pending.id, now).status).toBe("expired");
    expect(() => L.poll(c.d, c.session, catalog, now)).toThrow("Session expired");
  });
  it("bounds queue/action input, and never delivers executable/argument fields", () => {
    const c = paired();
    const q = L.queue(1, { ...input(c.deviceId), executable: "/bin/sh", args: ["-c", "bad"] }, now);
    expect(L.poll(c.d, c.session, catalog, now).commands).toEqual([{ id: q.id, actionId: "editor", expiresAt: q.expiresAt }]);
    expect(() => L.queue(1, input(c.deviceId), now)).toThrow("already pending");
    expect(() => L.actions([{ id: "a;evil", name: "bad" }])).toThrow();
    expect(() => L.actions(Array(51).fill(catalog[0]))).toThrow();
  });
  it("does not put credentials in profile exports and strips imported bindings, even colliding ones", async () => {
    const c = paired();
    const page = db.prepare("INSERT INTO pages(user_id,name,position) VALUES(1,'P',0) RETURNING id").get() as { id: number };
    createImportedTile(1, page.id, {
      integration: "desktoplauncher", tileSettings: {
        launcherInstanceId: L.instanceId, launcherDeviceId: c.deviceId, launcherActionId: "editor", token: c.token,
      },
    });
    const row = db.prepare("SELECT * FROM tiles WHERE user_id=1").get() as any;
    expect(formatTile(row).tileSettings).toEqual({});
    for (const suffix of ["", "?includeConnections=true"]) {
      const response = await request(app).get("/api/profile/export" + suffix).set("Authorization", auth());
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(c.token);
      expect(JSON.stringify(response.body)).not.toContain(c.deviceId);
    }
  });
});

describe("trusted encrypted transport boundaries", () => {
  function req(ip: string, host: string, headers: object = {}) {
    return { socket: { remoteAddress: ip }, headers: { host, ...headers }, secure: false } as any;
  }
  it("refuses unencrypted LAN and spoofed forwarding headers; permits local SSH endpoint", () => {
    expect(trustedTransport(req("192.168.1.42", "localhost:20028"))).toBe(false);
    expect(trustedTransport(req("192.168.1.42", "tachboard.example", { "x-forwarded-proto": "https" }))).toBe(false);
    expect(trustedTransport(req("127.0.0.1", "127.0.0.1:20029"))).toBe(true);
    expect(trustedTransport(req("127.0.0.1", "localhost", { origin: "http://evil.test" }))).toBe(false);
  });
  it.each(["pi", "truenas"])("pairs and authorizes through the same verified proxy protocol for a %s hostname", async (host) => {
    const hostname = `${host}.tachboard.example`;
    await request(app).get("/api/launcher/instance").set("Host", "localhost");
    vi.stubEnv("LAUNCHER_TRUSTED_PROXY_IP", testPeer!);
    vi.stubEnv("LAUNCHER_HTTPS_ORIGIN", `https://${hostname}`);
    const headers = { Host: hostname, "X-Forwarded-Proto": "https", Origin: `https://${hostname}` };
    const invitation = await request(app).post("/api/launcher/pairings").set(headers).set("Authorization", auth()).send({});
    expect(invitation.status).toBe(200);
    const approval = await request(app).post("/api/launcher/pairings/approve").set(headers).send({
      code: invitation.body.code, instanceId: invitation.body.instanceId,
      approved: true, name: `${host} desktop`, actions: catalog, owner: 2,
    });
    expect(approval.status).toBe(200);
    expect(L.listDevices(1).devices[0]?.name).toBe(`${host} desktop`);
    const companionHeaders = { ...headers, Authorization: `Bearer ${approval.body.token}`, "X-Launcher-Instance": L.instanceId };
    const hello = await request(app).post("/api/launcher/companion/hello").set(companionHeaders).send({ actions: catalog });
    expect(hello.status).toBe(200);
    const queued = await request(app).post("/api/launcher/commands").set(headers).set("Authorization", auth()).send(input(approval.body.deviceId));
    expect(queued.status).toBe(200);
    const accepted = await request(app).post("/api/launcher/companion/accept").set(companionHeaders).send({ session: hello.body.session, id: queued.body.id });
    expect(accepted.status).toBe(200);
    const replay = await request(app).post("/api/launcher/companion/accept").set(companionHeaders).send({ session: hello.body.session, id: queued.body.id });
    expect(replay.status).toBe(409);
  });
  it("does not trust other proxy peers, protocols, or origins", () => {
    vi.stubEnv("LAUNCHER_TRUSTED_PROXY_IP", "10.0.0.2");
    vi.stubEnv("LAUNCHER_HTTPS_ORIGIN", "https://tachboard.example");
    expect(trustedTransport(req("10.0.0.2", "tachboard.example", { "x-forwarded-proto": "https", origin: "https://tachboard.example" }))).toBe(true);
    expect(trustedTransport(req("10.0.0.3", "tachboard.example", { "x-forwarded-proto": "https" }))).toBe(false);
    expect(trustedTransport(req("10.0.0.2", "tachboard.example", { "x-forwarded-proto": "http" }))).toBe(false);
    expect(trustedTransport(req("10.0.0.2", "tachboard.example", { "x-forwarded-proto": "https", origin: "https://evil.test" }))).toBe(false);
  });
});
