import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function tmux(args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await exec("tmux", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function capturePane(target: string, lines = 200): Promise<string> {
  return tmux(["capture-pane", "-p", "-J", "-t", target, "-S", `-${lines}`]);
}

export async function windowExists(target: string): Promise<boolean> {
  try {
    await tmux(["display-message", "-p", "-t", target, "ok"]);
    return true;
  } catch {
    return false;
  }
}

/** Last activity timestamp (epoch seconds) of the window's session, per tmux. */
export async function sessionActivity(target: string): Promise<number> {
  const out = await tmux(["display-message", "-p", "-t", target, "#{session_activity}"]);
  return Number(out.trim()) || 0;
}

// Delivery protocol adapted from gastown (MIT, github.com/steveyegge/gastown):
// sanitize control chars, ESC + settle delay to leave any menu/partial state,
// literal text in 512-byte chunks, then Enter verified against pane content
// with backoff retries (readline can swallow a too-early Enter).
const CHUNK = 512;
const ESC_SETTLE_MS = 600;

function sanitize(text: string): string {
  // Strip control chars except \n and \t; strip ANSI escapes.
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export async function sendKeysRobust(target: string, text: string): Promise<void> {
  const clean = sanitize(text).trim();
  if (!clean) throw new Error("Refusing to send empty message");

  await tmux(["send-keys", "-t", target, "Escape"]);
  await sleep(ESC_SETTLE_MS);

  for (let i = 0; i < clean.length; i += CHUNK) {
    await tmux(["send-keys", "-t", target, "-l", clean.slice(i, i + CHUNK)]);
    await sleep(50);
  }
  await sleep(300);

  // Enter, verified: if the pane still ends with our text tail, the submit
  // didn't take (common with readline timing); retry with backoff.
  const tail = clean.slice(-40);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await tmux(["send-keys", "-t", target, "Enter"]);
    await sleep(500 * attempt);
    const pane = await capturePane(target, 20);
    const lastLines = pane.trimEnd().split("\n").slice(-3).join("\n");
    if (!lastLines.includes(tail)) return;
  }
  // Best effort: leave it rather than spam more Enters (could double-submit).
}
