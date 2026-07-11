import { describe, expect, test } from "bun:test";
import { sanitize } from "../src/tmux.js";

describe("sanitize", () => {
  test("strips ANSI escape sequences", () => {
    expect(sanitize("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  test("strips control characters", () => {
    expect(sanitize("bell\x07 and null\x00 and cr\x0d")).toBe("bell and null and cr");
  });

  test("keeps newlines and tabs", () => {
    expect(sanitize("line1\nline2\tend")).toBe("line1\nline2\tend");
  });

  test("keeps plain unicode intact", () => {
    expect(sanitize("déjà vu 🎙️ ok")).toBe("déjà vu 🎙️ ok");
  });
});
