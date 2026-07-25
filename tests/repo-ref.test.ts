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
    expect(resolveRepo("https://github.com/Tug/walkie.git").name).toBe("walkie");
  });
});
