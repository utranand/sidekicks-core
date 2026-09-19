#!/usr/bin/env node
// Create deterministic sample run artifacts for the Sidekicks Agent Office.
// These are synthetic "subagent" runs used for demos; real run state is untouched.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './run-notify-hook.mjs';

const DEMOS = Object.freeze([
  {
    slug: 'demo-working-subagent',
    status: 'running',
    title: 'Implement dashboard filters',
    goal: 'Show an active demo subagent typing at a desk.',
    offsetMinutes: -9,
  },
  {
    slug: 'demo-blocked-subagent',
    status: 'blocked',
    title: 'Wait for API credentials',
    goal: 'Show a blocked demo subagent with a red attention state.',
    offsetMinutes: -18,
  },
  {
    slug: 'demo-failed-subagent',
    status: 'failed',
    title: 'Investigate failing import job',
    goal: 'Show a failed demo subagent state.',
    offsetMinutes: -31,
  },
  {
    slug: 'demo-paused-subagent',
    status: 'paused',
    title: 'Take a handoff break',
    goal: 'Show a paused demo subagent in coffee mode.',
    offsetMinutes: -44,
  },
  {
    slug: 'demo-stale-subagent',
    status: 'running',
    title: 'Review long-running migration notes',
    goal: 'Show a stale running demo subagent asleep at the desk in full-floor mode.',
    offsetMinutes: -190,
    stale: true,
  },
  {
    slug: 'demo-done-subagent',
    status: 'done',
    title: 'Ship release notes',
    goal: 'Show a completed demo subagent in the archive/off-shift room.',
    offsetMinutes: -65,
  },
  {
    slug: 'demo-database-tuning',
    status: 'running',
    title: 'Optimize database indexes',
    goal: 'Show another active demo subagent query tuning.',
    offsetMinutes: -5,
  },
  {
    slug: 'demo-review-block',
    status: 'blocked',
    title: 'Wait for product design approval',
    goal: 'Show a blocked agent awaiting review.',
    offsetMinutes: -12,
  },
  {
    slug: 'demo-peer-review',
    status: 'paused',
    title: 'Wait for peer review approval',
    goal: 'Show a paused agent waiting on pull request approvals.',
    offsetMinutes: -22,
  },
  {
    slug: 'demo-ship-migrations',
    status: 'done',
    title: 'Run database migrations',
    goal: 'Show another finished subagent in the archives.',
    offsetMinutes: -80,
  },
]);

function usage() {
  return [
    'Usage: node scripts/office-viz-demo-subagents.mjs [--clean] [--runs-root <path>] [--prefix <slug>] [--json]',
    '',
    'Creates synthetic office-visible run.json files under:',
    '  artifacts/runs/office-viz-demo/<prefix>-<status>/run.json',
    '',
    'Options:',
    '  --clean           Remove the generated office-viz-demo run artifacts for the selected prefix.',
    '  --runs-root PATH  Write under a different runs root. Defaults to artifacts/runs.',
    '  --prefix SLUG     Prefix generated slugs. Defaults to "sample".',
    '  --json            Print written run.json paths as JSON.',
  ].join('\n');
}

function bangkokIso(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+07:00`;
}

function parseArgs(argv) {
  const opts = { clean: false, json: false, prefix: 'sample', runsRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage() + '\n');
      process.exit(0);
    }
    if (arg === '--clean') {
      opts.clean = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--prefix' && argv[i + 1]) {
      opts.prefix = argv[++i];
    } else if (arg === '--runs-root' && argv[i + 1]) {
      opts.runsRoot = argv[++i];
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}\n\n${usage()}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.prefix)) {
    throw new Error('--prefix must be lowercase kebab-case: letters, digits, and hyphens');
  }
  return opts;
}

function demoDir(root, opts) {
  const runsRoot = opts.runsRoot ? resolve(root, opts.runsRoot) : join(root, 'artifacts', 'runs');
  return join(runsRoot, 'office-viz-demo');
}

function writeDemoRuns(root, opts) {
  const base = demoDir(root, opts);
  mkdirSync(base, { recursive: true });
  const now = Date.now();
  const written = [];
  for (const demo of DEMOS) {
    const updated = new Date(now + demo.offsetMinutes * 60 * 1000);
    const heartbeat = demo.stale ? new Date(now - 3 * 60 * 60 * 1000) : updated;
    const slug = `${opts.prefix}-${demo.slug}`;
    const runDir = join(base, slug);
    const runJson = join(runDir, 'run.json');
    mkdirSync(runDir, { recursive: true });
    const body = {
      schema_version: 1,
      skill: 'office-viz-demo',
      slug,
      status: demo.status,
      title: demo.title,
      goal: demo.goal,
      created_at: bangkokIso(new Date(now - 70 * 60 * 1000)),
      updated_at: bangkokIso(updated),
      jira_card: `DEMO-${written.length + 1}`,
      demo: true,
      control: {
        lease: {
          holder: `office-viz-demo/${slug}`,
          heartbeat_at: bangkokIso(heartbeat),
        },
      },
    };
    writeFileSync(runJson, JSON.stringify(body, null, 2) + '\n');
    written.push(runJson);
  }
  return written;
}

function cleanDemoRuns(root, opts) {
  const base = demoDir(root, opts);
  const removed = [];
  for (const demo of DEMOS) {
    const runDir = join(base, `${opts.prefix}-${demo.slug}`);
    if (!existsSync(runDir)) continue;
    rmSync(runDir, { recursive: true, force: true });
    removed.push(runDir);
  }
  try {
    if (existsSync(base) && readdirSync(base).length === 0) rmSync(base, { recursive: true, force: true });
  } catch {
    // Best effort cleanup; leaving an empty demo folder is harmless.
  }
  return removed;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const root = resolveRoot(dirname(fileURLToPath(import.meta.url)));
    const opts = parseArgs(process.argv.slice(2));
    if (opts.clean) {
      const removed = cleanDemoRuns(root, opts);
      if (opts.json) process.stdout.write(JSON.stringify({ removed }, null, 2) + '\n');
      else process.stderr.write(`[office-viz-demo] removed ${removed.length} sample subagent run artifacts from ${demoDir(root, opts)}\n`);
    } else {
      const written = writeDemoRuns(root, opts);
      if (opts.json) process.stdout.write(JSON.stringify({ written }, null, 2) + '\n');
      else process.stderr.write(`[office-viz-demo] spawned ${written.length} sample subagent run artifacts under ${demoDir(root, opts)}\n`);
    }
  } catch (e) {
    process.stderr.write(`[office-viz-demo] ${e.message}\n`);
    process.exit(1);
  }
}
