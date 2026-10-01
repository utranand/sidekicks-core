// lib/cli-executor-lifecycle/register.mjs
// `sidekicks cli-executor register <name> [flags]` — register (or update) an external agent CLI
// in the scope-resolved registry so sk-cli-executor / sk-cli-orchestrator can
// delegate to it WITHOUT guessing. A generic CLI needs no bespoke Python adapter — it is driven
// entirely by the declared binary + invoke template.
//
// Examples:
//   sidekicks cli-executor register my-cli --binary mycli --invoke '-p,{brief}' --probe '--version'
//   sidekicks cli-executor register my-cli --binary mycli --invoke 'run' --brief-stdin
//   sidekicks cli-executor register codex --disabled          # re-annotate/disable a built-in
//   sidekicks cli-executor register codex --model-high gpt-5-codex --model-mid gpt-5 --model-low gpt-5-mini
//                                                             # set the tier→model map the orchestrator
//                                                             # resolves by task complexity (empty value clears a tier)
//   sidekicks cli-executor register codex --specialties 'code implementation,refactoring,debugging'
//                                                             # capability hints the orchestrator routes
//                                                             # tasks against (empty value clears the list)
//   sidekicks cli-executor register codex --default-model gpt-5.6-terra --default-effort medium
//                                                             # the selection `sidekicks codex task` uses when
//                                                             # no --model/--tier is given (empty value clears)
//   sidekicks cli-executor register codex --model-specialties-high 'complex implementation,deep debugging' \
//                                         --model-specialties-low 'boilerplate,bulk mechanical edits'
//                                                             # pair each model tier with the jobs it is
//                                                             # best at — the orchestrator picks the item's
//                                                             # model_tier by fit (empty value clears a tier)
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { read } from '../settings-store/settings.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import {
  resolveRegistryPath,
  readRegistry,
  writeRegistry,
  validateSpec,
  parseFlags,
  splitListFlag,
  BUILTIN_NAMES,
  MODEL_TIERS,
} from './_shared.mjs';

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const name = args.name;
  if (!name) {
    throw new SidekicksError('cli-executor register: a <name> is required', EXIT_VALIDATION);
  }

  const flags = parseFlags(ctx.argv, ['brief-stdin', 'usage-exposed', 'enabled', 'disabled', 'force', 'root', 'inherit', 'auth-interactive', 'reads-files', 'no-reads-files']);

  if (flags.enabled && flags.disabled) {
    throw new SidekicksError('cli-executor register: pass at most one of --enabled / --disabled', EXIT_VALIDATION);
  }
  if (flags['reads-files'] && flags['no-reads-files']) {
    throw new SidekicksError('cli-executor register: pass at most one of --reads-files / --no-reads-files', EXIT_VALIDATION);
  }

  // A bare `register <builtin> [--enabled|--disabled]` re-annotates a native adapter; otherwise
  // the presence of --binary/--invoke means a generic registration.
  const isBuiltinName = BUILTIN_NAMES.includes(name);
  const looksGeneric = flags.binary !== undefined || flags.invoke !== undefined;
  const kind = flags.kind || (isBuiltinName && !looksGeneric ? 'builtin' : 'generic');

  const settings = read(repoRoot);
  const { path, pathRel, scopeLabel } = resolveRegistryPath(repoRoot, settings, { root: flags.root === true });
  const registry = readRegistry(path);
  if (flags.inherit) {
    if (flags.root === true || scopeLabel === 'sidekicks (root)') throw new SidekicksError('cli-executor register --inherit is available only for an active user project', EXIT_VALIDATION);
    delete registry.executors[name];
    writeRegistry(path, registry, repoRoot);
    return { stdout: `removed project override for executor '${name}' from ${pathRel}; inherited value is now effective\n`, exitCode: EXIT_OK };
  }
  const existed = Object.prototype.hasOwnProperty.call(registry.executors, name);
  const prior = existed ? registry.executors[name] : {};

  const spec = { kind, enabled: flags.disabled ? false : true };
  if (prior.model_bindings && typeof prior.model_bindings === 'object') spec.model_bindings = prior.model_bindings;
  // Canonical family: `--family ''` clears it, an absent flag carries the prior value forward (same
  // merge rule as description/models/specialties, so a partial re-register never silently drops the
  // field that decides whether two seats count as independent).
  if (flags.family !== undefined) {
    if (flags.family !== '') spec.family = String(flags.family);
  } else if (prior.family) {
    spec.family = String(prior.family);
  }

  // A generic executor's role invocation profile arrives as a JSON file — it is a nested object with
  // argument arrays, which no comma-separated flag can express honestly. Same carry-forward rule.
  if (flags['profile-file'] !== undefined && flags['profile-file'] !== '') {
    const profilePath = isAbsolute(String(flags['profile-file']))
      ? String(flags['profile-file'])
      : resolvePath(repoRoot, String(flags['profile-file']));
    if (!existsSync(profilePath)) {
      throw new SidekicksError(
        `cli-executor register: --profile-file not found: ${flags['profile-file']}`,
        EXIT_VALIDATION,
      );
    }
    try {
      spec.profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    } catch (err) {
      throw new SidekicksError(
        `cli-executor register: --profile-file is not valid JSON: ${err.message}`,
        EXIT_VALIDATION,
      );
    }
  } else if (flags['profile-file'] === '') {
    // An explicitly empty value clears the profile, making the executor undispatchable for goal
    // roles again — deliberate, and the same "empty clears" convention as every other flag here.
  } else if (prior.profile) {
    spec.profile = prior.profile;
  }

  // Carry forward the existing description when --description isn't given (like models/specialties
  // below), so a partial re-register — e.g. setting only a model tier — never silently wipes it.
  if (flags.description) spec.description = String(flags.description);
  else if (prior.description) spec.description = String(prior.description);

  if (kind === 'generic') {
    // Like description/models/specialties: every generic field carries forward from the prior
    // entry when its flag is absent, so a partial re-register (e.g. setting only a model-tier
    // specialty on 'claude') never wipes the binary/invoke template it did not mention.
    if (flags.binary !== undefined) spec.binary = String(flags.binary);
    else if (prior.binary) spec.binary = String(prior.binary);
    const invoke = splitListFlag(flags.invoke);
    if (invoke) spec.invoke = invoke;
    else if (Array.isArray(prior.invoke) && prior.invoke.length) spec.invoke = prior.invoke.slice();
    const probe = splitListFlag(flags.probe);
    if (probe) spec.probe = probe;
    else if (Array.isArray(prior.probe) && prior.probe.length) spec.probe = prior.probe.slice();
    if (flags.transport) spec.transport = String(flags.transport);
    else if (prior.transport) spec.transport = String(prior.transport);
    if (flags.sandbox) spec.sandbox = String(flags.sandbox);
    else if (prior.sandbox) spec.sandbox = String(prior.sandbox);
    spec.brief_stdin = flags['brief-stdin'] === true || (flags['brief-stdin'] === undefined && prior.brief_stdin === true);
    spec.usage_exposed = flags['usage-exposed'] === true || (flags['usage-exposed'] === undefined && prior.usage_exposed === true);
    // Only the false case is ever persisted (see validateSpec), so this carries a prior `false`
    // forward and lets --reads-files clear it again.
    if (flags['no-reads-files'] === true) spec.reads_files = false;
    else if (flags['reads-files'] === true) spec.reads_files = true;
    else if (prior.reads_files === false) spec.reads_files = false;
    const capabilitiesCommand = splitListFlag(flags['capabilities-command']);
    if (capabilitiesCommand) spec.capabilities_command = capabilitiesCommand;
    else if (Array.isArray(prior.capabilities_command)) spec.capabilities_command = prior.capabilities_command.slice();
    const authStatus = splitListFlag(flags['auth-status-command']);
    const authRenew = splitListFlag(flags['auth-renew-command']);
    if (authStatus || authRenew || flags['auth-interactive'] !== undefined || prior.auth) {
      spec.auth = {
        ...(prior.auth && typeof prior.auth === 'object' ? prior.auth : {}),
        ...(authStatus ? { status_command: authStatus } : {}),
        ...(authRenew ? { renew_command: authRenew } : {}),
        ...(flags['auth-interactive'] === true ? { interactive: true } : {}),
      };
    }
  }

  // Model tiers: carry forward any existing map, then apply `--model-<tier>` overrides. A flag with
  // an EMPTY value (`--model-high ''`) clears that tier — so a re-annotation neither silently wipes
  // configured models nor forces re-supplying every tier just to change one.
  const models = { ...(prior.models && typeof prior.models === 'object' ? prior.models : {}) };
  for (const tier of MODEL_TIERS) {
    const flagVal = flags[`model-${tier}`];
    if (flagVal === undefined) continue;
    if (flagVal === '') delete models[tier];
    else models[tier] = String(flagVal);
  }
  if (Object.keys(models).length) spec.models = models;

  const efforts = { ...(prior.efforts && typeof prior.efforts === 'object' ? prior.efforts : {}) };
  for (const tier of MODEL_TIERS) {
    const value = flags[`effort-${tier}`];
    if (value === undefined) continue;
    if (value === '') delete efforts[tier]; else efforts[tier] = String(value);
  }
  if (Object.keys(efforts).length) spec.efforts = efforts;

  // Single default selection (`sidekicks <cli> task` with no --model/--tier). Same carry-forward
  // rule: an absent flag keeps the prior value, an empty value clears it.
  for (const key of ['default-model', 'default-effort']) {
    const field = key.replace('-', '_');
    if (flags[key] === undefined) { if (prior[field]) spec[field] = String(prior[field]); }
    else if (flags[key] !== '') spec[field] = String(flags[key]);
  }

  // The discovered capability catalog is written by `cli-executor models --refresh`, never by a
  // register flag — so a re-register must carry it forward, or it silently erases what `list` and
  // `models` grade selections against.
  if (prior.capabilities && typeof prior.capabilities === 'object') spec.capabilities = prior.capabilities;

  // Specialties: `--specialties 'a,b,c'` sets the whole list (the orchestrator routes tasks against
  // it); carry forward the existing list when the flag is absent, clear it with an empty value.
  if (flags.specialties === undefined) {
    if (Array.isArray(prior.specialties) && prior.specialties.length) spec.specialties = prior.specialties.slice();
  } else if (flags.specialties !== '') {
    spec.specialties = splitListFlag(flags.specialties) || [];
  }

  // Per-tier model specialties: `--model-specialties-<tier> 'a,b'` pairs THAT tier's model with the
  // jobs it is best at. Same merge semantics as `models`: carry the existing map forward, apply the
  // given tiers, an EMPTY value clears just that tier.
  const modelSpecialties = {
    ...(prior.model_specialties && typeof prior.model_specialties === 'object' ? prior.model_specialties : {}),
  };
  for (const tier of MODEL_TIERS) {
    const flagVal = flags[`model-specialties-${tier}`];
    if (flagVal === undefined) continue;
    if (flagVal === '') delete modelSpecialties[tier];
    else modelSpecialties[tier] = splitListFlag(String(flagVal)) || [];
  }
  if (Object.keys(modelSpecialties).length) spec.model_specialties = modelSpecialties;

  const normalized = validateSpec(name, spec);

  registry.executors[name] = normalized;
  writeRegistry(path, registry, repoRoot);

  const verb = existed ? 'updated' : 'registered';
  const state = normalized.enabled ? 'enabled' : 'disabled';
  const detail = normalized.kind === 'generic'
    ? ` (${normalized.binary} ${normalized.invoke.join(' ')})`
    : ' (built-in)';
  const modelDetail = normalized.models
    ? ` models[${MODEL_TIERS.filter((t) => normalized.models[t]).map((t) => `${t}=${normalized.models[t]}`).join(' ')}]`
    : '';
  const familyDetail = normalized.family ? ` family=${normalized.family}` : '';
  const defaultDetail = normalized.default_model || normalized.default_effort
    ? ` default[${[normalized.default_model && `model=${normalized.default_model}`, normalized.default_effort && `effort=${normalized.default_effort}`].filter(Boolean).join(' ')}]`
    : '';
  const profileDetail = normalized.profile ? ' profile[declared]' : '';
  const specialtyDetail = normalized.specialties ? ` specialties[${normalized.specialties.join(', ')}]` : '';
  const tierSpecialtyDetail = normalized.model_specialties
    ? ` model-specialties[${MODEL_TIERS.filter((t) => normalized.model_specialties[t])
        .map((t) => `${t}: ${normalized.model_specialties[t].join(', ')}`).join(' | ')}]`
    : '';
  return {
    stdout: `${verb} ${normalized.kind} executor '${name}' [${state}]${detail}${familyDetail}${profileDetail}${modelDetail}${defaultDetail}${specialtyDetail}${tierSpecialtyDetail} in ${pathRel}\n`,
    exitCode: EXIT_OK,
  };
}
