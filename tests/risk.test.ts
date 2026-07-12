import { describe, expect, test } from "bun:test";
import { consentValid, riskOf } from "../src/risk.js";

describe("riskOf", () => {
  test("classifies tools", () => {
    expect(riskOf("kill_worker")).toBe("dangerous");
    expect(riskOf("spawn_worker")).toBe("normal");
    expect(riskOf("fleet_status")).toBe("normal");
  });
});

describe("consentValid", () => {
  test("accepts the exact phrase, case/space/punctuation tolerant", () => {
    expect(consentValid("I give explicit consent to remove this")).toBe(true);
    expect(consentValid("  i give explicit consent to remove this.  ")).toBe(true);
    expect(consentValid("Je donne mon consentement explicite pour supprimer ceci")).toBe(true);
  });

  test("rejects a plain yes or anything short of the phrase", () => {
    expect(consentValid("yes")).toBe(false);
    expect(consentValid("oui vas-y")).toBe(false);
    expect(consentValid("I consent")).toBe(false);
    expect(consentValid("")).toBe(false);
    expect(consentValid(undefined)).toBe(false);
  });
});
