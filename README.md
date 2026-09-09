# gcs-job-scheduler

gcs job scheduler implementation

## Features

- Production-ready code
- TypeScript with full type safety
- Comprehensive error handling
- Built by Retsumdk

## Installation

```bash
git clone https://github.com/Retsumdk/gcs-job-scheduler.git
cd gcs-job-scheduler
bun install
```

## Usage

```bash
bun run src/index.ts --help
```

## Architecture

A lightweight, dependency-injected command-line scheduler built with Bun and
TypeScript. The entrypoint (`src/index.ts`) parses CLI options with `commander`,
loads a JSON configuration file from the working directory (merging user values
over safe defaults), and drives the scheduling loop with configurable timeout
and retry settings. The module exports a single `main` function so the scheduler
can be invoked both as a CLI and programmatically from other services.

```
CLI (commander) → loadConfig(config.json) → scheduler loop → done
```

## Real-World Use Case

A service team needs to run recurring Google Cloud Storage maintenance jobs
(cleanup of expired objects, inventory snapshots, or transfer verification)
without a heavyweight orchestration layer. `gcs-job-scheduler` provides a
self-contained scheduler binary that reads a checked-in `config.json` (base URL,
timeout, retries), runs the job, and reports a clear success or failure exit
status — suitable for cron, CI pipelines, or a container entrypoint.

## Configuration

Create `config.json` for custom settings.

```json
{
  "baseUrl": "https://storage.googleapis.com",
  "timeout": 30000,
  "retries": 3
}
```

## License

MIT License

---

Built by [Retsumdk](https://github.com/Retsumdk)
