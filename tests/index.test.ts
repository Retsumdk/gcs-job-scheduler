import { describe, test, expect } from "bun:test";
import * as pkg from "../src/index.js";

describe("gcs-job-scheduler package surface", () => {
  test("exports the public API", () => {
    expect(typeof pkg.Scheduler).toBe("function");
    expect(typeof pkg.runCli).toBe("function");
    expect(typeof pkg.startServer).toBe("function");
    expect(typeof pkg.parseCron).toBe("function");
    expect(typeof pkg.validateSchedule).toBe("function");
    expect(typeof pkg.saveState).toBe("function");
    expect(typeof pkg.loadState).toBe("function");
    expect(typeof pkg.runDemo).toBe("function");
    expect(pkg.SchedulerError).toBeDefined();
    expect(pkg.COMMANDS.length).toBeGreaterThan(0);
  });
});
