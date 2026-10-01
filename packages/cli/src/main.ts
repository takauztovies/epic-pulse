import { main } from './cli.js';

// The bundle's entry point. The exit code is set rather than forced, so
// everything written to stdout is flushed before the process ends.
process.exitCode = await main(process.argv.slice(2), process.env);
