/**
 * Minimal registry-ready tool definition.
 *
 * Mirrors the shape `ctx.tools` consumes (raw JSON-Schema parameters plus an
 * output renderer). Kept dependency-free on purpose: importing an
 * `@deepseek-ai/*` package from a profile bundle can shadow the CLI-internal
 * build for the whole composition.
 *
 * Author-facing parameter specs use `{ type, description, enum, required }`;
 * `required: true` is lifted into the parent schema's `required` array.
 *
 * @module dsh-selftest/tool
 */

/**
 * @typedef {object} ToolSpec
 * @property {string} name
 * @property {string} description
 * @property {Record<string, Record<string, unknown>>} [parameters]
 * @property {(args: any, value: any) => Array<{ type: 'text', text: string }>} render
 * @property {(args: any, exec: unknown) => Promise<any>} execute
 */

/**
 * @param {ToolSpec} spec
 */
export function defineTool(spec) {
  /** @type {Record<string, Record<string, unknown>>} */
  const properties = {}
  /** @type {string[]} */
  const required = []
  for (const [name, raw] of Object.entries(spec.parameters ?? {})) {
    const { required: isRequired, ...schema } = raw
    properties[name] = schema
    if (isRequired === true) required.push(name)
  }
  /** @type {Record<string, unknown>} */
  const parameters = { type: 'object', properties }
  if (required.length > 0) parameters.required = required

  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: { schema: {}, render: spec.render },
    /**
     * @param {any} args
     * @param {unknown} exec
     */
    async execute(args, exec) {
      return spec.execute(args ?? {}, exec)
    },
  }
}
