import { parseArgs, type ParseArgsOptionDescriptor, type ParseArgsOptionsConfig } from 'node:util';

export interface ArgSpec {
  readonly booleans?: readonly string[];
  readonly strings?: readonly string[];
  // How many plain words the command takes; any more is a usage error.
  readonly positionals?: number;
}

export interface ParsedArgs {
  readonly flags: ReadonlySet<string>;
  readonly strings: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
}

// node:util's parser, strict: an unknown option, a missing value or an extra
// word is a usage error, reported as undefined for the caller to print.
export function parseCommandArgs(args: readonly string[], spec: ArgSpec): ParsedArgs | undefined {
  const options: ParseArgsOptionsConfig = Object.fromEntries<ParseArgsOptionDescriptor>([
    ...(spec.booleans ?? []).map((name) => [name, { type: 'boolean' }] as const),
    ...(spec.strings ?? []).map((name) => [name, { type: 'string' }] as const),
  ]);
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
    if (positionals.length > (spec.positionals ?? 0)) return undefined;
    const entries = Object.entries(values);
    return {
      flags: new Set(entries.flatMap(([name, value]) => (value === true ? [name] : []))),
      strings: new Map(entries.flatMap(([name, value]) => (typeof value === 'string' ? [[name, value] as const] : []))),
      positionals,
    };
  } catch {
    return undefined;
  }
}
