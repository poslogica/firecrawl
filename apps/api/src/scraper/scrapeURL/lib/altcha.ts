import crypto from "crypto";
import { load } from "cheerio";
import * as undici from "undici";
import { CookieJar } from "tough-cookie";
import { cookie } from "http-cookie-agent/undici";
import { Logger } from "winston";
import { config } from "../../../config";
import { attachSecurityCheck } from "../engines/utils/safeFetch";

// https://altcha.org -- an open, algorithmic proof-of-work challenge (not a
// visual/human CAPTCHA). Any client, human or automated, is expected to be
// able to solve it by brute-forcing a hash preimage; there's nothing to
// evade here beyond doing the arithmetic the widget's own JS would do.

type AltchaChallengeInfo = {
  challengeUrl: string;
  verifyUrl: string;
  method: string;
  fieldName: string;
  formFields: Record<string, string>;
};

type AltchaChallenge = {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber?: number;
};

const HASH_ALGORITHMS: Record<string, string> = {
  "SHA-256": "sha256",
  "SHA-384": "sha384",
  "SHA-512": "sha512",
};

// Bounds how much CPU a single (attacker-supplied) challenge can burn on the
// Node event loop -- a hostile site could otherwise set an enormous
// maxnumber to stall the scraper.
const MAX_ITERATIONS = 2_000_000;

function isOnionHost(hostname: string): boolean {
  return hostname.toLowerCase().replace(/\.$/, "").endsWith(".onion");
}

function detectAltchaChallenge(
  html: string,
  pageUrl: string,
): AltchaChallengeInfo | null {
  let $: ReturnType<typeof load>;
  try {
    $ = load(html);
  } catch {
    return null;
  }

  const widget = $("altcha-widget").first();
  if (widget.length === 0) {
    return null;
  }

  const challengeUrlAttr = widget.attr("challengeurl");
  if (!challengeUrlAttr) {
    return null;
  }

  const form = widget.closest("form");
  if (form.length === 0) {
    return null;
  }

  const fieldName = widget.attr("name")?.trim() || "altcha";
  const method = (form.attr("method") || "GET").trim().toUpperCase();
  const actionAttr = form.attr("action") || "";

  const formFields: Record<string, string> = {};
  form.find("input, select, textarea").each((_, el) => {
    const field = $(el);
    const name = field.attr("name");
    if (!name || name === fieldName) return;

    const tag = el.tagName?.toLowerCase();
    const type = (field.attr("type") || "").toLowerCase();

    if (
      tag === "input" &&
      (type === "checkbox" || type === "radio") &&
      field.attr("checked") === undefined
    ) {
      return;
    }
    if (tag === "input" && (type === "submit" || type === "button")) {
      return;
    }

    formFields[name] = field.attr("value") || field.text() || "";
  });

  try {
    return {
      challengeUrl: new URL(challengeUrlAttr, pageUrl).toString(),
      verifyUrl: new URL(actionAttr || pageUrl, pageUrl).toString(),
      method: method === "GET" ? "GET" : "POST",
      fieldName,
      formFields,
    };
  } catch {
    return null;
  }
}

function solveAltchaChallenge(challenge: AltchaChallenge): number {
  const algorithm = HASH_ALGORITHMS[challenge.algorithm?.toUpperCase()];
  if (!algorithm) {
    throw new Error(`Unsupported Altcha algorithm: ${challenge.algorithm}`);
  }

  const max = Math.min(challenge.maxnumber ?? 100_000, MAX_ITERATIONS);
  for (let n = 0; n <= max; n++) {
    const hash = crypto
      .createHash(algorithm)
      .update(challenge.salt + n)
      .digest("hex");
    if (hash === challenge.challenge) {
      return n;
    }
  }

  throw new Error(
    `Failed to solve Altcha challenge within bound (maxnumber=${challenge.maxnumber ?? "unset"})`,
  );
}

function buildDispatcher(
  targetUrl: string,
  skipTlsVerification: boolean,
): undici.Dispatcher {
  const hostname = new URL(targetUrl).hostname;

  const isOnion = isOnionHost(hostname) && !!config.TOR_PROXY_URL;

  const base = isOnion
    ? new undici.ProxyAgent({ uri: config.TOR_PROXY_URL! })
    : config.PROXY_SERVER
      ? new undici.ProxyAgent({
          uri: config.PROXY_SERVER.includes("://")
            ? config.PROXY_SERVER
            : "http://" + config.PROXY_SERVER,
          token: config.PROXY_USERNAME
            ? `Basic ${Buffer.from(
                config.PROXY_USERNAME + ":" + (config.PROXY_PASSWORD ?? ""),
              ).toString("base64")}`
            : undefined,
          requestTls: { rejectUnauthorized: !skipTlsVerification },
        })
      : new undici.Agent({
          connect: { rejectUnauthorized: !skipTlsVerification },
        });

  // The challenge/verify URLs come straight from attacker-controlled page
  // markup (challengeurl / form action), unlike the rest of robustFetch's
  // callers whose targets are our own config. Block requests that resolve to
  // private/internal addresses -- same policy as the rest of the scraper --
  // except over Tor, where routing to an .onion address is the whole point.
  if (!isOnion) {
    attachSecurityCheck(base);
  }

  const jar = new CookieJar();
  return base
    .compose(undici.interceptors.redirect({ maxRedirections: 5 }))
    .compose(cookie({ jar }));
}

type AltchaBypassResult = {
  url: string;
  html: string;
  statusCode: number;
  contentType?: string;
};

/**
 * Detects an Altcha proof-of-work gate in `html` and, if present, solves it
 * and resubmits the form it belongs to, returning the content unlocked by
 * verification. Returns null if no Altcha challenge is present, or if the
 * bypass could not be completed (caller should fall back to the original
 * content in that case).
 */
export async function bypassAltchaChallenge(
  html: string,
  pageUrl: string,
  options: {
    skipTlsVerification: boolean;
    signal?: AbortSignal;
    logger: Logger;
  },
): Promise<AltchaBypassResult | null> {
  const info = detectAltchaChallenge(html, pageUrl);
  if (!info) {
    return null;
  }

  const log = options.logger.child({ method: "bypassAltchaChallenge" });

  try {
    const dispatcher = buildDispatcher(
      info.challengeUrl,
      options.skipTlsVerification,
    );

    const challengeRes = await undici.fetch(info.challengeUrl, {
      dispatcher,
      signal: options.signal,
    });
    if (!challengeRes.ok) {
      log.debug("Altcha challenge fetch failed", {
        status: challengeRes.status,
      });
      return null;
    }

    const challenge = (await challengeRes.json()) as AltchaChallenge;
    if (
      typeof challenge?.challenge !== "string" ||
      typeof challenge?.salt !== "string" ||
      typeof challenge?.signature !== "string" ||
      typeof challenge?.algorithm !== "string"
    ) {
      log.debug("Altcha challenge response missing expected fields");
      return null;
    }

    const number = solveAltchaChallenge(challenge);

    const payload = Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        number,
        salt: challenge.salt,
        signature: challenge.signature,
      }),
    ).toString("base64");

    const formData = new URLSearchParams({
      ...info.formFields,
      [info.fieldName]: payload,
    });

    const verifyUrl =
      info.method === "GET"
        ? (() => {
            const u = new URL(info.verifyUrl);
            for (const [k, v] of formData) u.searchParams.set(k, v);
            return u.toString();
          })()
        : info.verifyUrl;

    const verifyRes = await undici.fetch(verifyUrl, {
      method: info.method,
      dispatcher,
      signal: options.signal,
      ...(info.method === "POST"
        ? {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formData.toString(),
          }
        : {}),
    });

    const resultHtml = await verifyRes.text();

    // If we're still looking at an (unsolved) Altcha gate, verification
    // didn't actually unlock anything -- don't report false success.
    if (detectAltchaChallenge(resultHtml, verifyRes.url)) {
      log.debug("Altcha verification did not unlock the underlying content");
      return null;
    }

    return {
      url: verifyRes.url,
      html: resultHtml,
      statusCode: verifyRes.status,
      contentType: verifyRes.headers.get("content-type") ?? undefined,
    };
  } catch (error) {
    log.warn("Altcha bypass attempt failed", { error });
    return null;
  }
}
