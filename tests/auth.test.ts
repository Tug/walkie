import { describe, expect, test } from "bun:test";
import { emailAllowed, loadAuthConfig, signSession, verifySession } from "../src/auth.js";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("session JWT", () => {
  test("roundtrip", () => {
    const token = signSession({ sub: "tug@juisci.com", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    expect(verifySession(token, SECRET)?.sub).toBe("tug@juisci.com");
  });

  test("rejects expired", () => {
    const token = signSession({ sub: "x", exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    expect(verifySession(token, SECRET)).toBeNull();
  });

  test("rejects tampered payload and wrong secret", () => {
    const token = signSession({ sub: "x", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "evil", exp: 9999999999 }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifySession(`${h}.${forged}.${s}`, SECRET)).toBeNull();
    expect(verifySession(token, "another-secret-another-secret-xx")).toBeNull();
    expect(verifySession("garbage", SECRET)).toBeNull();
  });
});

describe("emailAllowed", () => {
  test("allows domain members only", () => {
    expect(emailAllowed("tug@juisci.com", "juisci.com")).toBe(true);
    expect(emailAllowed("evil@notjuisci.com", "juisci.com")).toBe(false);
    expect(emailAllowed("evil@juisci.com.attacker.io", "juisci.com")).toBe(false);
    expect(emailAllowed("", "juisci.com")).toBe(false);
  });
});

describe("loadAuthConfig", () => {
  test("token mode requires FLEET_TOKEN", () => {
    expect(() => loadAuthConfig({} as NodeJS.ProcessEnv)).toThrow(/FLEET_TOKEN/);
    expect(loadAuthConfig({ FLEET_TOKEN: "x".repeat(24) } as NodeJS.ProcessEnv).mode).toBe("token");
  });

  test("google mode requires client credentials and secrets", () => {
    expect(() => loadAuthConfig({ AUTH_MODE: "google" } as NodeJS.ProcessEnv)).toThrow(/GOOGLE_CLIENT_ID/);
    const cfg = loadAuthConfig({
      AUTH_MODE: "google",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "sec",
      SESSION_SECRET: "s".repeat(32),
      PUBLIC_URL: "https://walkie.juisci.com/",
    } as NodeJS.ProcessEnv);
    expect(cfg.mode).toBe("google");
    expect(cfg.google?.allowedDomain).toBe("juisci.com");
    expect(cfg.google?.publicUrl).toBe("https://walkie.juisci.com");
  });
});
