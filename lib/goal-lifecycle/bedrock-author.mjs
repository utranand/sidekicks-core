// Bounded, one-file direct Bedrock authoring path. It deliberately returns content to the engine;
// the engine, rather than the model process, is the only writer of the declared artifact.

import { spawn } from 'node:child_process';
import { writeAtomic } from '../fs-safety/fsx.mjs';

export async function runBedrockNoThink(input) {
  const timeoutMs = Math.max(1, Number(input.timeoutMs) || 60_000);
  const bin = process.env.SIDEKICKS_BEDROCK_LLM_BIN || 'bedrock-llm';
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = [...(input.commandArgs || []), '--no-think', '--timeout', String(timeoutSeconds), '--brief-file', input.briefPath];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: input.cwd, shell: false, windowsHide: true });
    } catch (error) {
      resolve(failure(bin, error));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve(failure(bin, error, stdout, stderr)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const content = stdout.trim();
      if (timedOut) return resolve({ ok: false, executor: bin, exit_code: code, timed_out: true, killed: true, stdout, stderr, error: 'direct Bedrock authoring timed out without usable content', result: null });
      if (code !== 0) return resolve({ ok: false, executor: bin, exit_code: code, timed_out: false, killed: false, stdout, stderr, error: `direct Bedrock authoring exited ${code}`, result: null });
      if (!content) return resolve({ ok: false, executor: bin, exit_code: code, timed_out: false, killed: false, stdout, stderr, error: 'direct Bedrock authoring returned no content', result: null });
      try {
        writeAtomic(input.artifactPath, `${content}\n`);
        resolve({ ok: true, executor: bin, exit_code: code, timed_out: false, killed: false, stdout, stderr, result: { result: 'completed', summary: 'direct no-think Bedrock authoring completed', changed_paths: [input.artifact] } });
      } catch (error) {
        resolve({ ok: false, executor: bin, exit_code: code, timed_out: false, killed: false, stdout, stderr, error: `could not write declared artifact: ${error.message}`, result: null });
      }
    });
  });
}

function failure(bin, error, stdout = '', stderr = '') {
  return { ok: false, executor: bin, exit_code: null, timed_out: false, killed: false, stdout, stderr, error: `could not launch direct Bedrock authoring: ${error.message || error}`, result: null };
}
