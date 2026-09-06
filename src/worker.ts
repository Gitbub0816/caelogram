import type { Service } from "./service.js";
import type { Repository } from "./types.js";
export async function processJobs(service: Service) {
  const jobs = service.store.db
    .prepare(
      "SELECT * FROM jobs WHERE status='pending' AND attempts<5 ORDER BY updated LIMIT 5",
    )
    .all();
  for (const job of jobs) {
    const event = JSON.parse(String(job.body));
    try {
      const repos = service.store.db
        .prepare("SELECT tenant,body FROM objects WHERE kind='repo'")
        .all();
      for (const row of repos) {
        const repo = service.store.decode<Repository>(String(row.body));
        if (
          repo.name === event.name &&
          repo.installationId === event.installationId &&
          event.ref === `refs/heads/${repo.branch}`
        ) {
          const p = {
            tenant: String(row.tenant),
            subject: "github-webhook",
            scopes: ["admin"],
            repositories: [repo.name],
          };
          await service.connect(p, repo.name, repo.branch, repo.installationId);
        }
      }
      service.store.db
        .prepare("UPDATE jobs SET status='complete',updated=? WHERE id=?")
        .run(new Date().toISOString(), String(job.id));
    } catch {
      service.store.db
        .prepare(
          "UPDATE jobs SET attempts=attempts+1,status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,updated=? WHERE id=?",
        )
        .run(new Date().toISOString(), String(job.id));
    }
  }
}
