/** Never serialize SDK error objects: they can contain authorization headers. */
export function errorDetails(error: unknown, env: object) {
  const scrub = (text: string) => {
    for (const [key, value] of Object.entries(env)) {
      if (/KEY|SECRET|TOKEN/i.test(key) && typeof value === "string" && value)
        text = text.split(value).join("[REDACTED]");
    }
    return text
      .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, "[REDACTED PEM]")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[REDACTED]")
      .slice(0, 2000);
  };
  const chain: { name: string; message: string; stack: string[] }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current) && chain.length < 4) {
    seen.add(current);
    chain.push({
      name: scrub(current.name),
      message: scrub(current.message),
      stack: (current.stack || "").split("\n").filter(line => /^\s+at /.test(line)).slice(0, 8).map(scrub),
    });
    current = current.cause;
  }
  return chain;
}
