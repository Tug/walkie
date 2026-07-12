import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";

// Two modes:
// - "token" (default): a single shared FLEET_TOKEN bearer. Zero setup, good for personal use.
// - "google": Google Workspace OAuth (smoothie-admin style): server-side code flow restricted
//   to an allowed domain, then a signed stateless session (JWT, HS256) delivered as an
//   httpOnly cookie (web, same-origin) and shown once for copy (mobile).

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  allowedDomain: string;
  publicUrl: string; // e.g. https://walkie.juisci.com; redirect URI = publicUrl + /auth/callback
}

export interface AuthConfig {
  mode: "token" | "google";
  fleetToken?: string;
  google?: GoogleAuthConfig;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const mode = env.AUTH_MODE === "google" ? "google" : "token";
  if (mode === "token") {
    const fleetToken = env.FLEET_TOKEN;
    if (!fleetToken || fleetToken.length < 24) {
      throw new Error("AUTH_MODE=token requires FLEET_TOKEN (random secret, min 24 chars)");
    }
    return { mode, fleetToken };
  }
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "PUBLIC_URL"] as const;
  for (const key of required) {
    if (!env[key]) throw new Error(`AUTH_MODE=google requires ${key}`);
  }
  if ((env.SESSION_SECRET as string).length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 chars");
  }
  return {
    mode,
    fleetToken: env.FLEET_TOKEN, // optional: still accepted as a bearer for machine clients
    google: {
      clientId: env.GOOGLE_CLIENT_ID as string,
      clientSecret: env.GOOGLE_CLIENT_SECRET as string,
      sessionSecret: env.SESSION_SECRET as string,
      allowedDomain: env.GOOGLE_ALLOWED_DOMAIN ?? "juisci.com",
      publicUrl: (env.PUBLIC_URL as string).replace(/\/$/, ""),
    },
  };
}

// ---------- Minimal HS256 JWT ----------

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function signSession(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifySession(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = fromB64url(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[1]).toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function emailAllowed(email: string, domain: string): boolean {
  return typeof email === "string" && email.endsWith(`@${domain}`) && !email.includes(" ");
}

// ---------- Express wiring ----------

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const SESSION_DAYS = 7;

export function authMiddleware(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (config.fleetToken && bearer === config.fleetToken) return next();
    if (config.mode === "google" && config.google) {
      const token = bearer || readCookie(req, "walkie_session");
      if (token && verifySession(token, config.google.sessionSecret)) return next();
    }
    const hint = config.mode === "google" ? "sign in at /auth/login" : "missing or invalid bearer token";
    return res.status(401).json({ error: `unauthorized: ${hint}` });
  };
}

export function registerAuthRoutes(app: Express, config: AuthConfig): void {
  if (config.mode !== "google" || !config.google) return;
  const g = config.google;
  const redirectUri = `${g.publicUrl}/auth/callback`;

  app.get("/auth/login", (_req, res) => {
    const state = signSession(
      { n: b64url(randomBytes(12)), exp: Math.floor(Date.now() / 1000) + 600 },
      g.sessionSecret,
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", g.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("hd", g.allowedDomain);
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  app.get("/auth/callback", async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || !verifySession(state, g.sessionSecret)) {
      return res.status(400).send("Invalid OAuth state or missing code.");
    }
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: g.clientId,
        client_secret: g.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) return res.status(502).send(`Google token exchange failed (${tokenRes.status}).`);
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    if (!id_token) return res.status(502).send("No id_token in Google response.");
    // The id_token comes straight from Google over TLS; decode without re-verifying signature.
    let claims: { iss?: string; aud?: string; email?: string; email_verified?: boolean; hd?: string };
    try {
      claims = JSON.parse(fromB64url(id_token.split(".")[1]).toString("utf8"));
    } catch {
      return res.status(502).send("Malformed id_token.");
    }
    const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    if (
      !issOk ||
      claims.aud !== g.clientId ||
      !claims.email_verified ||
      claims.hd !== g.allowedDomain ||
      !emailAllowed(claims.email ?? "", g.allowedDomain)
    ) {
      return res.status(403).send(`Access restricted to ${g.allowedDomain} accounts.`);
    }
    const session = signSession(
      { sub: claims.email, exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 },
      g.sessionSecret,
    );
    const secure = g.publicUrl.startsWith("https://") ? " Secure;" : "";
    res.setHeader(
      "Set-Cookie",
      `walkie_session=${encodeURIComponent(session)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
    );
    res.send(`<!doctype html><meta charset="utf-8"><title>walkie: signed in</title>
<body style="font-family:system-ui;background:#101418;color:#e8ecef;padding:2rem;max-width:40rem;margin:auto">
<h2>Signed in as ${claims.email}</h2>
<p>This browser now has a session cookie: <a href="/app/" style="color:#3ba55c">open the app</a>.</p>
<p>For the mobile app, paste this session token (valid ${SESSION_DAYS} days) into the token field:</p>
<pre style="background:#181f26;padding:1rem;border-radius:8px;white-space:pre-wrap;word-break:break-all">${session}</pre>
</body>`);
  });

  app.get("/auth/me", (req, res) => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const token = bearer || readCookie(req, "walkie_session");
    const payload = token ? verifySession(token, g.sessionSecret) : null;
    if (!payload) return res.status(401).json({ error: "unauthorized" });
    res.json({ email: payload.sub, exp: payload.exp });
  });
}
