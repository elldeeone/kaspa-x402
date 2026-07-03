import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_DIST } from "./site-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, SITE_DIST);
const preferredPort = Number(process.env.PORT ?? 4173);
const explicitPort = process.env.PORT !== undefined;

if (!fs.existsSync(outDir)) {
  console.error("site/dist is missing; run npm run site:build first");
  process.exit(1);
}

listen(preferredPort);

function listen(port) {
  const server = createServer();
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && !explicitPort && port < preferredPort + 20) {
      listen(port + 1);
      return;
    }
    throw error;
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`site preview: http://127.0.0.1:${port}`);
  });
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const redirect = matchRedirect(url.pathname);
    if (redirect) {
      response.writeHead(redirect.status, { Location: redirect.location });
      response.end();
      return;
    }
    const file = resolveFile(url.pathname);
    if (!file || !isInsideOutput(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const notFound = path.join(outDir, "404.html");
      if (fs.existsSync(notFound)) {
        response.writeHead(404, responseHeaders(new URL("/404.html", url), notFound));
        fs.createReadStream(notFound).pipe(response);
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    response.writeHead(200, responseHeaders(url, file));
    fs.createReadStream(file).pipe(response);
  });
}

function resolveFile(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, "");
  const candidate = path.join(outDir, clean);
  if (pathname.endsWith("/") || path.extname(candidate) === "") return path.join(candidate, "index.html");
  return candidate;
}

function isInsideOutput(file) {
  const relative = path.relative(outDir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function contentType(file) {
  switch (path.extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return file.endsWith(".schema.json") ? "application/schema+json; charset=utf-8" : "application/json; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function responseHeaders(url, file) {
  return {
    "Content-Type": contentType(file),
    ...localPreviewHeaders(headersForPath(url.pathname), url),
  };
}

function localPreviewHeaders(headers, url) {
  if (headers["Content-Security-Policy"] && url.pathname.startsWith("/demo/") && url.searchParams.get("allow-custom-endpoints") === "1") {
    const endpointSource = cspSourceForCustomEndpoint(url.searchParams.get("endpoint"));
    if (!endpointSource) return headers;
    headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace(
      /connect-src [^;]+;/,
      `connect-src 'self' ${endpointSource};`,
    );
  }
  return headers;
}

function cspSourceForCustomEndpoint(value) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return undefined;
    if (!isLocalEndpointHost(parsed.hostname)) return undefined;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

function isLocalEndpointHost(hostname) {
  const clean = hostname.replace(/^\[|\]$/g, "");
  return ["localhost", "127.0.0.1", "::1"].includes(clean) || /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(clean);
}

function matchRedirect(pathname) {
  for (const line of readConfigLines("_redirects")) {
    const [from, to, statusText] = line.split(/\s+/);
    const match = matchPattern(from, pathname);
    if (!match) continue;
    return {
      location: applySplat(to, match.splat),
      status: Number(statusText) || 302,
    };
  }
  return undefined;
}

function headersForPath(pathname) {
  const headers = {};
  let activePattern;
  for (const line of readRawConfigLines("_headers")) {
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      activePattern = line.trim();
      continue;
    }
    if (!activePattern || !matchPattern(activePattern, pathname)) continue;
    const [name, ...valueParts] = line.trim().split(":");
    if (!name || valueParts.length === 0) continue;
    headers[name] = valueParts.join(":").trim();
  }
  return headers;
}

function readConfigLines(file) {
  return readRawConfigLines(file).filter((line) => line && !line.startsWith("#"));
}

function readRawConfigLines(file) {
  const fullPath = path.join(outDir, file);
  if (!fs.existsSync(fullPath)) return [];
  return fs.readFileSync(fullPath, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
}

function matchPattern(pattern, pathname) {
  if (pattern === pathname) return { splat: "" };
  if (!pattern.includes("*")) return undefined;
  const [prefix, suffix = ""] = pattern.split("*");
  if (!pathname.startsWith(prefix) || (suffix && !pathname.endsWith(suffix))) return undefined;
  return { splat: pathname.slice(prefix.length, suffix ? -suffix.length : undefined) };
}

function applySplat(target, splat) {
  return target.replace(":splat", splat.replace(/^\/+/, ""));
}
