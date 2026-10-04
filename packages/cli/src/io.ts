export interface StdinText {
  readonly text: string;
  // More than the limit arrived: the text is empty, never a cut-off payload.
  readonly truncated: boolean;
}

export const NOT_A_REPO = 'not inside a git repository';

// Reads all of stdin but keeps at most `limit` bytes. The rest is drained, not
// kept, so the writer (Claude Code) never meets a closed pipe. A terminal is
// not a payload: waiting on one would hang a command someone ran by hand.
export async function readStdin(limit: number): Promise<StdinText> {
  if (process.stdin.isTTY) return { text: '', truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  return size > limit ? { text: '', truncated: true } : { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

export function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function printError(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function usageError(usage: string): number {
  printError(`usage: epic-pulse ${usage}`);
  return 2;
}

export function failWith(message: string): number {
  printError(`epic-pulse: ${message}`);
  return 1;
}
