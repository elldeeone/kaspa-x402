import fs from "node:fs";
import path from "node:path";

const OPERATIONAL_URL_PATTERN =
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gu;
const ENCODED_OPERATIONAL_URL_PATTERN =
  /\b[A-Za-z][A-Za-z0-9+.-]*%3A(?:%2F){2}[^\s"'<>]+/giu;
const TRAILING_PUNCTUATION = new Set([
  ")",
  "]",
  "}",
  ".",
  ",",
  ";",
  "!",
  "?",
]);

export function sanitizeProofOutputText(value, { secrets = [] } = {}) {
  let text = String(value);
  for (const secret of secretRepresentations(secrets)) {
    if (text === secret) return "<redacted>";
    if (secret.length >= 8) {
      text = text.replaceAll(secret, "<redacted>");
    } else if (secret.length >= 3) {
      text = text.replace(
        new RegExp(
          `(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`,
          "gu",
        ),
        "<redacted>",
      );
    } else {
      text = text
        .replaceAll(`"${secret}"`, '"<redacted>"')
        .replaceAll(`'${secret}'`, "'<redacted>'");
    }
  }
  return text
    .replace(OPERATIONAL_URL_PATTERN, sanitizeOperationalUrl)
    .replace(ENCODED_OPERATIONAL_URL_PATTERN, "<redacted-url>");
}

export function stringifySanitizedProofOutput(value, options = {}) {
  return `${sanitizeProofOutputText(JSON.stringify(value, null, 2), options)}\n`;
}

export function writePrivateProofJson(file, value, options = {}) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, stringifySanitizedProofOutput(value, options), {
    mode: 0o600,
  });
  fs.chmodSync(resolved, 0o600);
}

function sanitizeOperationalUrl(candidate) {
  let end = candidate.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(candidate[end - 1])) end -= 1;
  const urlText = candidate.slice(0, end);
  const suffix = candidate.slice(end);
  try {
    const url = new URL(urlText);
    if (
      !url.username &&
      !url.password &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search &&
      !url.hash
    ) {
      return candidate;
    }
    return url.host
      ? `${url.protocol}//${url.host}${suffix}`
      : `<redacted-url>${suffix}`;
  } catch {
    return candidate;
  }
}

function secretRepresentations(secrets) {
  const values = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    addSecretVariants(values, secret);
    try {
      const url = new URL(secret);
      for (const component of [
        url.username,
        url.password,
        url.hostname,
        url.pathname,
        url.hash.slice(1),
        ...url.pathname.split("/").filter(Boolean),
        ...url.searchParams.values(),
      ]) {
        addSecretVariants(values, decodeURIComponentSafely(component));
      }
    } catch {
      // Non-URL secrets still receive raw, encoded, and base64 variants.
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function addSecretVariants(values, value) {
  if (!value) return;
  values.add(value);
  values.add(encodeURIComponent(value));
  values.add(value.replaceAll("/", "\\/"));
  values.add(JSON.stringify(value).slice(1, -1));
  values.add(Buffer.from(value).toString("base64"));
  values.add(Buffer.from(value).toString("base64url"));
}

function decodeURIComponentSafely(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
