/**
 * Line reader for JSONL transcripts.
 *
 * Not `node:readline`. readline ends a line at `\n`, `\r\n`, a bare `\r`, U+2028
 * and U+2029 (`lineEnding` in Node's lib/internal/readline/interface.js). JSON
 * allows U+2028/U+2029 unescaped inside strings, and Claude Code writes them raw,
 * so readline cut such a record in two, both halves failed `JSON.parse`, and the
 * record's usage was dropped as a "malformed line": a silent token undercount.
 * Measured 2026-10-19: 4 of 642 transcripts from the previous 14 days carried a
 * raw U+2028/U+2029, 2 of them subagent transcripts. JSONL's only record
 * separator is `\n`, so that is the only character split on here; a trailing `\r`
 * is dropped so CRLF files still parse.
 */
import * as fs from 'node:fs';

const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/**
 * Yield each `\n`-terminated line of a file (and a final unterminated one).
 * Breaking out of the loop closes the file.
 */
export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  let pending = '';
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      pending += chunk;
      let start = 0;
      let nl: number;
      while ((nl = pending.indexOf('\n', start)) !== -1) {
        yield stripCr(pending.slice(start, nl));
        start = nl + 1;
      }
      pending = pending.slice(start);
    }
    if (pending.length > 0) yield stripCr(pending);
  } finally {
    stream.destroy();
  }
}
