import http from "http";
import { z } from "zod";
import { describeIf, TEST_SELF_HOST, idmux, Identity } from "../lib";
import { scrape, scrapeTimeout } from "./lib";
import {
  createAltchaMockCounters,
  createAltchaMockHandler,
  ALTCHA_GATED_MARKER,
  type AltchaMockCounters,
} from "../../../lib/altcha/testing";

// =========================================
// Altcha (https://altcha.org) proof-of-work gate bypass
//
// Scrapes local-network targets, so it needs the same opt-in as the other
// local-target tests -- self-skips unless the harness is started with:
//
//   ALLOW_LOCAL_WEBHOOKS=true pnpm harness pnpm exec vitest run src/__tests__/snips/v2/altcha.test.ts
// =========================================

const stringbool = z.stringbool().catch(false);
const allowsLocalTargets = stringbool.parse(process.env.ALLOW_LOCAL_WEBHOOKS);

describeIf(TEST_SELF_HOST && allowsLocalTargets)("Altcha bypass", () => {
  let identity: Identity;
  let mockServer: http.Server;
  let counters: AltchaMockCounters;
  let baseUrl: string;

  beforeAll(async () => {
    identity = await idmux({ name: "altcha", concurrency: 100, credits: 1000000 });

    counters = createAltchaMockCounters();
    mockServer = http.createServer((req, res) => {
      createAltchaMockHandler(counters)(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      mockServer.once("error", reject);
      mockServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = mockServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to determine mock server port");
    }
    // The scrape URL schema requires a resolvable domain (rejects bare IPs)
    // -- localtest.me is a public DNS entry that resolves to 127.0.0.1, so it
    // satisfies that check while still reaching our local mock server.
    baseUrl = `http://localtest.me:${address.port}`;
  }, 10000 + scrapeTimeout);

  afterAll(async () => {
    await new Promise<void>(resolve => mockServer.close(() => resolve()));
  });

  it(
    "solves the proof-of-work challenge and returns the gated content",
    async () => {
      const verifyRequestsBefore = counters.verifyRequests;

      const doc = await scrape({ url: `${baseUrl}/` }, identity);

      expect(doc.markdown).toContain(ALTCHA_GATED_MARKER);
      expect(doc.markdown).not.toContain("Verify Humanity");
      expect(counters.verifyRequests).toBeGreaterThan(verifyRequestsBefore);
    },
    scrapeTimeout,
  );

  it(
    "falls back to the challenge page when the challenge provider is unreachable",
    async () => {
      const verifyRequestsBefore = counters.verifyRequests;

      const doc = await scrape({ url: `${baseUrl}/broken` }, identity);

      expect(doc.markdown).toContain("Verify Humanity");
      expect(doc.markdown).not.toContain(ALTCHA_GATED_MARKER);
      // The challenge endpoint 500s, so we should never even attempt /verify.
      expect(counters.verifyRequests).toBe(verifyRequestsBefore);
    },
    scrapeTimeout,
  );
});
