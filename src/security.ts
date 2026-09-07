import { createHash, timingSafeEqual } from "node:crypto";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function safePath(path: string) {
  return (
    path.length < 400 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path
      .split("/")
      .some(
        (p) => p === ".." || p === "." || !p || p.toLowerCase() === ".git",
      ) &&
    !/[\x00-\x1f:]/.test(path)
  );
}
export function sensitivePath(path: string) {
  return /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(pem|key|p12|pfx)$/i.test(
    path,
  );
}
export function redact(source: string) {
  return source
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:live-|test-)?[A-Za-z0-9_-]{20,})\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(
      /((?:password|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[=:]\s*)(["'`])[^\r\n]*?\2/gi,
      '$1"[REDACTED]"',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}
export function constantEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class Fault extends Error {
  retryAfterSeconds?: number;
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new Fault(status, message);
}
