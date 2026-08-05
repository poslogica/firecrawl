import { createHash, createHmac, randomBytes } from "crypto";
import type http from "http";

// Test helper for a minimal, real Altcha (https://altcha.org) proof-of-work
// gate -- shared by the altcha snips test, which points a real scrape at a
// local instance of this server. Not used in production code.

const ALTCHA_TEST_SECRET = "firecrawl-test-altcha-secret";
export const ALTCHA_GATED_MARKER = "ALTCHA-GATED-CONTENT-MARKER";
const COOKIE_NAME = "altcha_verified";

function challengePage(challengeUrl: string, returnTo: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>Verify Humanity</title></head>
<body>
<h1>Verify Humanity</h1>
<form method="POST" action="/verify">
  <input type="hidden" name="return" value="${returnTo}">
  <altcha-widget challengeurl="${challengeUrl}"></altcha-widget>
  <button type="submit">Submit</button>
</form>
</body>
</html>`;
}

function gatedPage(): string {
  return `<!DOCTYPE html><html><body><p>${ALTCHA_GATED_MARKER}</p></body></html>`;
}

function hasVerifiedCookie(req: http.IncomingMessage): boolean {
  const cookieHeader = req.headers.cookie ?? "";
  return cookieHeader
    .split(";")
    .map(p => p.trim())
    .includes(`${COOKIE_NAME}=1`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export interface AltchaMockCounters {
  challengeRequests: number;
  verifyRequests: number;
  gatedContentServed: number;
}

export function createAltchaMockCounters(): AltchaMockCounters {
  return { challengeRequests: 0, verifyRequests: 0, gatedContentServed: 0 };
}

/**
 * Request handler implementing a minimal, real Altcha SHA-256
 * proof-of-work gate:
 *  - `GET /`               serves the challenge form until a verified
 *                           cookie is present, then the gated content.
 *  - `GET /get-challenge`  issues a signed, solvable challenge.
 *  - `POST /verify`        checks a solved payload and sets the cookie.
 *  - `GET /broken`         same gate, but its challenge endpoint 500s --
 *                           for exercising the "can't solve it" fallback.
 */
export function createAltchaMockHandler(counters: AltchaMockCounters) {
  return async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/get-challenge") {
      counters.challengeRequests++;
      const number = Math.floor(Math.random() * 5000);
      const salt = randomBytes(12).toString("hex");
      const challenge = createHash("sha256")
        .update(salt + number)
        .digest("hex");
      const signature = createHmac("sha256", ALTCHA_TEST_SECRET)
        .update(challenge)
        .digest("hex");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          algorithm: "SHA-256",
          challenge,
          salt,
          signature,
          maxnumber: 50000,
        }),
      );
      return;
    }

    if (url.pathname === "/broken-challenge") {
      counters.challengeRequests++;
      res.statusCode = 500;
      res.end("mock challenge provider is down");
      return;
    }

    if (url.pathname === "/verify" && req.method === "POST") {
      counters.verifyRequests++;
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const payloadB64 = params.get("altcha") ?? "";
      const returnTo = params.get("return") || "/";

      let valid = false;
      try {
        const solved = JSON.parse(
          Buffer.from(payloadB64, "base64").toString("utf8"),
        );
        const expectedHash = createHash("sha256")
          .update(solved.salt + solved.number)
          .digest("hex");
        const expectedSignature = createHmac("sha256", ALTCHA_TEST_SECRET)
          .update(solved.challenge)
          .digest("hex");
        valid =
          expectedHash === solved.challenge &&
          expectedSignature === solved.signature;
      } catch {
        valid = false;
      }

      if (valid) {
        res.statusCode = 302;
        res.setHeader("Set-Cookie", `${COOKIE_NAME}=1; Path=/`);
        res.setHeader("Location", returnTo);
        res.end();
      } else {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(challengePage("/get-challenge", returnTo));
      }
      return;
    }

    if (url.pathname === "/broken") {
      res.setHeader("Content-Type", "text/html");
      res.end(challengePage("/broken-challenge", "/broken"));
      return;
    }

    if (url.pathname === "/") {
      if (hasVerifiedCookie(req)) {
        counters.gatedContentServed++;
        res.setHeader("Content-Type", "text/html");
        res.end(gatedPage());
      } else {
        res.setHeader("Content-Type", "text/html");
        res.end(challengePage("/get-challenge", "/"));
      }
      return;
    }

    res.statusCode = 404;
    res.end();
  };
}
