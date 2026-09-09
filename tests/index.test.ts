import { describe, test, expect } from "bun:test";
describe("gcs-job-scheduler", () => {
  test("module loads", async () => { const m = await import("../src/index"); expect(m).toBeDefined(); });
});
