import { pathToFileURL } from "node:url";
import { Scheduler } from "./scheduler.js";

const BASE = Date.UTC(2026, 0, 1, 9, 0, 0);

export async function runDemo(): Promise<string[]> {
  const lines: string[] = [];
  let now = BASE;
  const clock = (): number => now;

  const scheduler = new Scheduler({ clock });
  const callsByName = new Map<string, number>();
  scheduler.setHandler("demo-inventory", async ({ job }) => {
    const n = (callsByName.get(job.name) ?? 0) + 1;
    callsByName.set(job.name, n);
    if (job.name === "inventory-snapshot" && n === 1) {
      throw new Error("simulated GCS 503 (first attempt)");
    }
    return `inventory ok (${job.name} call ${n})`;
  });

  const cleanup = scheduler.add({
    name: "cleanup-expired-objects",
    cron: "*/2 * * * *",
    handler: { kind: "named", handler: "demo-inventory" },
  });
  const snapshot = scheduler.add({
    name: "inventory-snapshot",
    every: 120,
    handler: { kind: "named", handler: "demo-inventory" },
    maxRetries: 1,
    backoffMs: 30_000,
  });

  lines.push(`scheduler demo (fixed clock, starts ${new Date(BASE).toISOString()})`);
  lines.push(
    `jobs: ${cleanup.id} ${cleanup.name} cron(*/2 * * * *); ${snapshot.id} ${snapshot.name} every 120s (maxRetries 1)`,
  );

  for (const tickAt of [60, 120, 180]) {
    now = BASE + tickAt * 1_000;
    const result = await scheduler.tick();
    lines.push(
      `+${String(tickAt).padStart(3, "0")}s tick: started ${result.started}, succeeded ${result.succeeded}, failed ${result.failed}, retrying ${result.retrying}`,
    );
    for (const run of result.runs) {
      const jobName = scheduler.get(run.jobId)?.name ?? run.jobId;
      lines.push(
        `    run ${run.id} ${jobName} -> ${run.outcome} (${run.attempts.length} attempt${run.attempts.length === 1 ? "" : "s"})`,
      );
    }
  }

  const stats = scheduler.stats();
  const rate = (stats.successRate * 100).toFixed(1);
  lines.push(
    `stats: jobs ${stats.jobs} (${stats.enabledJobs} enabled), runs ${stats.runs} (${stats.succeeded} succeeded, ${stats.failed} failed), success rate ${rate}%`,
  );
  const totalCalls = [...callsByName.values()].reduce((a, b) => a + b, 0);
  lines.push(`inventory handler called ${totalCalls} time(s)`);
  return lines;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  for (const line of await runDemo()) console.log(line);
}
