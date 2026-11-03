/**
 * Minimal unit test for v2 scrape (no mocking; sanity check payload path)
 */
import { describe, expect, test } from "@jest/globals";
import { FirecrawlClient } from "../../../v2/client";

describe("v2.scrape unit", () => {
  test("constructor accepts an empty apiKey for the keyless free tier", () => {
    expect(() => new FirecrawlClient({ apiKey: "", apiUrl: "https://api.firecrawl.dev" })).not.toThrow();
  });
});

