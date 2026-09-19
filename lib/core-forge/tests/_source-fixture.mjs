// Hermetic optional-skill fixtures; no writes to the developer's canonical skill tree.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectRootStructure, copyRootStructure } from '../surfaces.mjs';
import { resolveFrameworkPreset } from '../../skill-package/framework-preset.mjs';

export function sourceFixture(repoRoot, extras = {}) {
  const root = mkdtempSync(join(tmpdir(), 'core-projection-source-'));
  const selected = resolveFrameworkPreset(repoRoot).selected;
  copyRootStructure(repoRoot, root, projectRootStructure(repoRoot, selected));
  copyFileSync(join(repoRoot, 'AGENTS.md'), join(root, 'AGENTS.md'));
  cpSync(join(repoRoot, '.sidekicks', 'agent-packs'), join(root, '.sidekicks', 'agent-packs'), { recursive: true });
  for (const [name, files] of Object.entries(extras)) {
    const contents = { 'SKILL.md': `---\nname: ${name}\ndescription: Portable regression fixture.\n---\n# ${name}\n`, ...files };
    for (const [rel, text] of Object.entries(contents)) {
      const target = join(root, '.agents', 'skills', name, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    const bundle = Object.entries(contents).map(([rel, text]) => `  ${rel}: sha256:${createHash('sha256').update(text).digest('hex')}`).join('\n');
    writeFileSync(join(root, '.agents', 'skills', name, 'skill.manifest.yaml'), `schema: 1\nskill: ${name}\nbundle:\n${bundle}\n`);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
