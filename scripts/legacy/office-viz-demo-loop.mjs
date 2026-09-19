#!/usr/bin/env node
// scripts/legacy/office-viz-demo-loop.mjs — Live demo loop for the Sidekicks Agent Office viz.
// Spawns 3 temporary demo agents, updates their work progress/status over 1 minute,
// and then cleans them up. Demonstrates real-time SSE updates without restarting the service.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './run-notify-hook.mjs';

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

const STEPS = [
  {
    coder: { title: 'Writing React components for database state', status: 'running' },
    auditor: { title: 'Scanning dependencies for vulnerabilities', status: 'running' },
    architect: { title: 'Drafting visual constraints in DESIGN.md', status: 'running' }
  },
  {
    coder: { title: 'Optimizing state selectors and re-renders', status: 'running' },
    auditor: { title: 'Analyzing Snyk package vulnerability report', status: 'running' },
    architect: { title: 'Calibrating typography scale and color system', status: 'running' }
  },
  {
    coder: { title: 'Fixing stale closure warning in useEffect hook', status: 'running' },
    auditor: { title: 'Applying security patch upgrade for package-lock.json', status: 'running' },
    architect: { title: 'Refining layout spacing and margins', status: 'running' }
  },
  {
    coder: { title: 'Writing component test specs', status: 'running' },
    auditor: { title: 'Verifying lockfile integrity and checksums', status: 'running' },
    architect: { title: 'Extracting Tailwind-compatible design tokens', status: 'running' }
  },
  {
    coder: { title: 'Building production React bundle', status: 'running' },
    auditor: { title: 'Running regression tests for security patch', status: 'running' },
    architect: { title: 'Generating static design HTML mockups', status: 'running' }
  },
  {
    coder: { title: 'Preparing pull request request details', status: 'running' },
    auditor: { title: 'Awaiting container image scan results', status: 'blocked', goal: 'Wait for security verification build' },
    architect: { title: 'Adding design system guidelines to documentation', status: 'running' }
  },
  {
    coder: { title: 'React components successfully merged and deployed', status: 'done' },
    auditor: { title: 'Snyk security scan clean and complete', status: 'done' },
    architect: { title: 'Design system guidelines successfully committed', status: 'done' }
  }
];

async function main() {
  const root = resolveRoot(dirname(fileURLToPath(import.meta.url)));
  const baseDir = join(root, 'artifacts', 'runs', 'office-viz-demo');

  console.log(`[demo-loop] Starting real-time demo office simulation under ${baseDir}`);
  console.log(`[demo-loop] Keep your Agent Office viz page open (http://127.0.0.1:4680/ or agent-office.html)`);

  const agents = ['demo-loop-coder', 'demo-loop-auditor', 'demo-loop-architect'];
  const skillNames = {
    'demo-loop-coder': 'react-components',
    'demo-loop-auditor': 'sk-security-remediation',
    'demo-loop-architect': 'taste-design'
  };

  // Step duration: 8 seconds (total 56 seconds for 7 steps)
  const stepDurationMs = 8000;

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const now = new Date();
    const nowStr = bangkokIso(now);
    const createdStr = bangkokIso(new Date(now.getTime() - 10 * 60 * 1000));

    console.log(`\n--- Step ${i + 1}/${STEPS.length} (${i * 8}s elapsed) ---`);

    for (const key of ['coder', 'auditor', 'architect']) {
      const slug = `demo-loop-${key}`;
      const config = step[key];
      const runDir = join(baseDir, slug);
      mkdirSync(runDir, { recursive: true });

      const runJsonPath = join(runDir, 'run.json');
      const body = {
        schema_version: 1,
        skill: skillNames[slug],
        slug,
        status: config.status,
        title: config.title,
        goal: config.goal || `Simulating live agent role: ${key}`,
        created_at: createdStr,
        updated_at: nowStr,
        jira_card: `DEMO-${100 + i}`,
        demo: true,
        control: {
          lease: {
            holder: `office-viz-demo/${slug}`,
            heartbeat_at: nowStr,
          },
        },
      };

      writeFileSync(runJsonPath, JSON.stringify(body, null, 2) + '\n');
      console.log(`[${slug}] Status: ${config.status} | Title: "${config.title}"`);
    }

    if (i < STEPS.length - 1) {
      await new Promise((r) => setTimeout(r, stepDurationMs));
    }
  }

  // Hold the final 'done' state for a bit so the user can see them in the archive / celebrating.
  console.log(`\n[demo-loop] Holding final state for 10 seconds...`);
  await new Promise((r) => setTimeout(r, 10000));

  // Cleanup
  console.log(`\n[demo-loop] Cleaning up temporary demo runs...`);
  for (const slug of agents) {
    const runDir = join(baseDir, slug);
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
      console.log(`[demo-loop] Removed ${slug}`);
    }
  }

  try {
    if (existsSync(baseDir) && readdirSync(baseDir).length === 0) {
      rmSync(baseDir, { recursive: true, force: true });
    }
  } catch {
    // Best effort
  }

  console.log(`[demo-loop] Done! Demo runs cleaned up successfully.`);
}

main().catch((err) => {
  console.error('[demo-loop] Error:', err);
  process.exit(1);
});
