// Test-only subprocess boundary for exercising callable projection operations.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProjection } from '../forge.mjs';
// Fresh synthetic targets must not inherit a developer's protected default branch.
// Scope this Git configuration to this test subprocess and its children only.
const gitConfigIndex = Number(process.env.GIT_CONFIG_COUNT || 0);
process.env[`GIT_CONFIG_KEY_${gitConfigIndex}`] = 'init.defaultBranch';
process.env[`GIT_CONFIG_VALUE_${gitConfigIndex}`] = 'feature/projection-fixture';
process.env.GIT_CONFIG_COUNT = String(gitConfigIndex + 1);
const repoRoot = process.env.SIDEKICKS_TEST_PROJECTION_SOURCE || resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [verb, ...args] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith('--')) { positional.push(arg); continue; }
  const at = arg.indexOf('=');
  if (at !== -1) flags[arg.slice(2, at)] = arg.slice(at + 1);
  else flags[arg.slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
}
const result = await runProjection(repoRoot, verb, flags, positional);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
