import { describe, expect, test } from "bun:test";
import { resolveRepo } from "../src/fleet-cli.js";

describe("resolveRepo", () => {
  test("owner/name → SSH URL", () => {
    expect(resolveRepo("JuisciAdmin/smoothie")).toEqual({
      name: "smoothie",
      url: "git@github.com:JuisciAdmin/smoothie.git",
    });
  });
  test("full URLs pass through", () => {
    expect(resolveRepo("git@github.com:Tug/walkie.git").url).toBe("git@github.com:Tug/walkie.git");
    expect(resolveRepo("git@github.com:Tug/walkie.git").name).toBe("walkie");
    expect(resolveRepo("https://github.com/Tug/walkie.git").name).toBe("walkie");
  });
  test("bare name uses the default owner", () => {
    expect(resolveRepo("walkie", "Tug")).toEqual({ name: "walkie", url: "git@github.com:Tug/walkie.git" });
  });
  test("bare name without a default owner is a clear error (the reported bug)", () => {
    expect(() => resolveRepo("walkie")).toThrow(/no owner/i);
  });
});
