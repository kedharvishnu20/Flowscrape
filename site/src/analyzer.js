export const SEVERITY = { INFO: "info", NOTICE: "notice", DANGER: "danger" };
export const VERDICT = { ALLOW: "allow", REVIEW: "review", BLOCKED: "blocked" };

const AUTH_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
  "authentication",
  "proxy-authorization",
];
const TEMPLATED = /\{\{|\$\{/;

function originOf(url) {
  if (typeof url !== "string" || !url.trim()) return { unknown: true };
  const t = url.trim();
  if (TEMPLATED.test(t.split("/").slice(0, 3).join("/")))
    return { unknown: true };
  try {
    const u = new URL(t);
    if (!/^https?:$/.test(u.protocol)) return { unknown: true };
    return { origin: u.origin };
  } catch {
    return { unknown: true };
  }
}

export function walkSteps(steps, out = []) {
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== "object") continue;
    out.push(s);
    walkSteps(s.children, out);
    walkSteps(s.ifBranch, out);
    walkSteps(s.elseBranch, out);
  }
  return out;
}

function headerNames(step) {
  const raw = step?.config?.headers;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object") return Object.keys(p);
  } catch {
    // line form
  }
  return raw
    .split("\n")
    .map((l) => l.split(":")[0]?.trim())
    .filter(Boolean);
}

export function analyzePipeline(pipeline) {
  const steps = walkSteps(pipeline?.steps);
  const caps = [];
  const add = (c) => {
    const e = caps.find((x) => x.id === c.id);
    if (e) {
      e.steps.push(...c.steps);
      return;
    }
    caps.push(c);
  };

  const declared = new Set();
  const t = originOf(pipeline?.targetOrigin);
  if (t.origin) declared.add(t.origin);
  for (const s of steps) {
    if (s.type === "WEBSITE" || s.type === "NAVIGATE") {
      const o = originOf(s.config?.url);
      if (o.origin) declared.add(o.origin);
    }
  }

  const thirdParty = new Set();
  let creds = false;
  let authHeaders = false;

  for (const s of steps) {
    const id = s.id || s.type;
    if (s.type === "SESSION") {
      const ck = s.config?.includeCookies !== false;
      if (ck || s.config?.includeStorage !== false) creds = true;
      add({
        id: "credentials",
        severity: SEVERITY.DANGER,
        title: ck
          ? "Reads and restores your logged-in session"
          : "Reads the page's stored data",
        detail: "Handles the cookies that keep you signed in. Legitimate for a pipeline that scrapes behind a login — and the exact thing a malicious one wants.",
        steps: [id],
      });
    } else if (s.type === "SET_HEADERS") {
      const names = headerNames(s);
      const auth = names.filter((n) =>
        AUTH_HEADERS.includes(n.toLowerCase()),
      );
      if (auth.length) authHeaders = true;
      add({
        id: "headers",
        severity: auth.length ? SEVERITY.DANGER : SEVERITY.NOTICE,
        title: auth.length
          ? "Attaches credentials to requests (" + auth.join(", ") + ")"
          : "Sets custom request headers",
        detail: names.length
          ? "Headers set: " + names.join(", ") + "."
          : "No headers configured.",
        steps: [id],
      });
    } else if (s.type === "API" || s.type === "DOWNLOAD_FILE") {
      const url = s.config?.url;
      if (s.type === "DOWNLOAD_FILE" && !url) continue;
      const { origin, unknown } = originOf(url);
      const off = unknown || !declared.has(origin);
      if (off) thirdParty.add(unknown ? "(decided at run time)" : origin);
      add({
        id: "network",
        severity: off ? SEVERITY.DANGER : SEVERITY.NOTICE,
        title: off
          ? "Sends requests to a site outside the one it scrapes"
          : "Calls an API on the site it scrapes",
        detail: "Destination: " + (unknown ? "chosen at run time from page data" : origin) + ".",
        steps: [id],
      });
    } else if (s.type === "UPLOAD_ACTIVITY") {
      add({
        id: "upload",
        severity: SEVERITY.DANGER,
        title: "Uploads files from your storage library",
        detail: "Sends files you added to the extension's library into a page's upload control.",
        steps: [id],
      });
    } else if (s.type === "AUTO_EXTRACT") {
      add({
        id: "ai",
        severity: SEVERITY.NOTICE,
        title: "Sends page text to whichever model you configured",
        detail: "Only if you configured a provider. A local model sends nothing off your machine.",
        steps: [id],
      });
    } else if (s.type === "SOLVE_CAPTCHA") {
      add({
        id: "captcha",
        severity: SEVERITY.DANGER,
        title: "Attempts to answer a captcha",
        detail: "Still needs your per-run authorisation and a per-domain attestation. Installing this grants neither.",
        steps: [id],
      });
    } else if (s.type === "EXPORT") {
      add({
        id: "export",
        severity: SEVERITY.INFO,
        title: "Writes the collected rows to a file",
        detail: "Through Chrome's normal download flow.",
        steps: [id],
      });
    }
  }

  let verdict = caps.length ? VERDICT.REVIEW : VERDICT.ALLOW;
  let blockedReason = null;
  if ((creds || authHeaders) && thirdParty.size) {
    verdict = VERDICT.BLOCKED;
    blockedReason =
      "This pipeline reads " +
      (creds ? "your logged-in session" : "credentials") +
      " and also sends requests to " +
      [...thirdParty].join(", ") +
      ", which is not a site it says it scrapes. That combination is how a shared pipeline steals an account, and no legitimate scraper needs it.";
  }
  if (
    verdict === VERDICT.REVIEW &&
    caps.every((c) => c.severity === SEVERITY.INFO)
  )
    verdict = VERDICT.ALLOW;

  return {
    verdict,
    capabilities: caps,
    declaredOrigins: [...declared],
    thirdPartyOrigins: [...thirdParty],
    blockedReason,
  };
}
