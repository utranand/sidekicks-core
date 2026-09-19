/**
 * OpenAI strict structured-output normalisation.
 *
 * The Responses API refuses a `response_format` schema unless EVERY object's `required` lists every
 * key in its `properties`. Optionality is expressed there by a nullable type, never by omission from
 * `required`. The engine's own schemas are ordinary JSON Schema and use the omission form, so a
 * codex-family planning session died at the wire before the model ever ran:
 *
 *   invalid_json_schema: In context=('properties','decisions','items'), 'required' is required to be
 *   supplied and to be an array including every key in properties. Missing 'rejected'.
 *
 * The fix belongs HERE, at the transport boundary, and not in the schema definitions: the omission
 * form is correct for every other family, and the engine validates returned documents against the
 * original schema, where a genuinely optional field must stay optional. What this normaliser
 * produces is the same contract restated in the only dialect the OpenAI wire accepts — each formerly
 * optional field becomes required but nullable, so a model that has nothing to say emits `null`
 * rather than being forced to invent a value.
 */

/** Keys whose values are themselves schemas keyed by name. */
const SCHEMA_MAPS = ['properties', '$defs', 'definitions', 'patternProperties'];
/** Keys whose values are a schema, or a list of schemas. */
const SCHEMA_NODES = ['items', 'additionalItems', 'contains', 'not', 'if', 'then', 'else'];
const SCHEMA_LISTS = ['anyOf', 'allOf', 'oneOf', 'prefixItems'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Make a type nullable without disturbing an enum or a `$ref`.
 *
 * A `$ref` or a combinator carries no `type` of its own, so it is wrapped in `anyOf` with a null
 * branch instead; an enum gains an explicit `null` member, because a strict validator checks the
 * enum before the type.
 */
function nullable(schema) {
  if (!isObject(schema)) return schema;
  const out = { ...schema };
  if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  if (typeof out.type === 'string') {
    if (out.type !== 'null') out.type = [out.type, 'null'];
    return out;
  }
  if (Array.isArray(out.type)) {
    if (!out.type.includes('null')) out.type = [...out.type, 'null'];
    return out;
  }
  // No `type` to widen — `$ref`, a bare combinator, or an untyped node.
  if (Array.isArray(out.anyOf)) {
    const hasNull = out.anyOf.some((branch) => isObject(branch) && branch.type === 'null');
    if (!hasNull) out.anyOf = [...out.anyOf, { type: 'null' }];
    return out;
  }
  const { ...rest } = out;
  return { anyOf: [rest, { type: 'null' }] };
}

/**
 * Restate one JSON Schema in OpenAI strict form.
 *
 * Pure: the input is never mutated, so a frozen module-level constant can be passed directly.
 *
 * @param {object} schema
 * @returns {object}
 */
export function toOpenAiStrictSchema(schema) {
  if (!isObject(schema)) return schema;
  const out = { ...schema };

  for (const key of SCHEMA_MAPS) {
    if (!isObject(out[key])) continue;
    const mapped = {};
    for (const [name, child] of Object.entries(out[key])) mapped[name] = toOpenAiStrictSchema(child);
    out[key] = mapped;
  }
  for (const key of SCHEMA_NODES) {
    if (isObject(out[key])) out[key] = toOpenAiStrictSchema(out[key]);
  }
  for (const key of SCHEMA_LISTS) {
    if (Array.isArray(out[key])) out[key] = out[key].map((child) => toOpenAiStrictSchema(child));
  }

  if (isObject(out.properties)) {
    const names = Object.keys(out.properties);
    const required = Array.isArray(out.required) ? out.required : [];
    const optional = names.filter((name) => !required.includes(name));
    if (optional.length > 0) {
      const widened = { ...out.properties };
      for (const name of optional) widened[name] = nullable(widened[name]);
      out.properties = widened;
    }
    out.required = names;
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  return out;
}

/**
 * Whether an executor's structured output goes over the OpenAI wire.
 *
 * Keyed on the FAMILY, not the executor name: `codex` and any generic executor registered against an
 * OpenAI-compatible endpoint share the same restriction, and a future OpenAI-family CLI inherits the
 * fix without another edit here.
 *
 * @param {string|null|undefined} family
 * @returns {boolean}
 */
export function familyNeedsStrictSchema(family) {
  return family === 'openai';
}
