/**
 * Log Commands
 *
 * Commands for viewing and managing metrics logs.
 */

import { Command } from 'commander';
import * as fs from 'node:fs';
import {
  getLoggerConfig,
  readRecentLogs,
  getLogStats,
} from '../logger.js';
import { formatLogStatus } from '../display/formatters.js';

/**
 * Mutable state carried across `pollLogOnce` calls for one `log tail --follow`
 * session. File-local to this command — not part of the logger's public
 * surface.
 */
export interface PollState {
  lastSize: number;
  lastErrorCode?: string;
}

/**
 * Read the bytes appended to `logPath` since `fromOffset`.
 *
 * @param logPath - Path to the log file
 * @param fromOffset - Byte offset to read from (the previously known size)
 * @returns The newly appended content and the file's current size. When the
 *   file has not grown past `fromOffset`, returns `{ content: '', newSize: fromOffset }`.
 */
export function readAppendedBytes(logPath: string, fromOffset: number): { content: string; newSize: number } {
  const currentSize = fs.statSync(logPath).size;
  if (currentSize <= fromOffset) {
    return { content: '', newSize: fromOffset };
  }
  const fd = fs.openSync(logPath, 'r');
  try {
    const newBytes = Buffer.alloc(currentSize - fromOffset);
    fs.readSync(fd, newBytes, 0, newBytes.length, fromOffset);
    return { content: newBytes.toString('utf-8'), newSize: currentSize };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Poll `logPath` once, emitting any newly appended lines via `emit` and
 * mutating `state.lastSize` in place.
 *
 * - ENOENT (file deleted or mid-rotation) resets `state.lastSize` to 0, so
 *   the next successful poll re-reads from the start of the new file.
 * - Any other error (EISDIR, EACCES, ...) leaves `state.lastSize` unchanged
 *   — we don't know how much of the file we've already seen — and writes
 *   one stderr diagnostic naming the errno, suppressing repeats via
 *   `state.lastErrorCode` so a persistent failure doesn't spam one line
 *   per 500ms tick.
 */
export function pollLogOnce(logPath: string, state: PollState, emit: (line: string) => void): void {
  try {
    const { content, newSize } = readAppendedBytes(logPath, state.lastSize);
    if (newSize > state.lastSize) {
      content.split('\n').forEach((line) => {
        if (line.trim()) emit(line);
      });
    }
    state.lastSize = newSize;
    state.lastErrorCode = undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      state.lastSize = 0; // Reset on file deletion/rotation
      state.lastErrorCode = undefined;
      return;
    }
    if (state.lastErrorCode !== code) {
      state.lastErrorCode = code ?? String(err);
      process.stderr.write(
        `agent-metrics: log tail poll failed for ${logPath}: ${state.lastErrorCode}\n`,
      );
    }
  }
}

/**
 * Register log commands on the program.
 */
export function registerLogCommands(program: Command): void {
  const logCmd = program
    .command('log')
    .description('View and manage metrics logs');

  // Log status
  logCmd
    .command('status')
    .description('Show log file statistics')
    .action(() => {
      const config = getLoggerConfig();
      const stats = getLogStats();

      console.log(formatLogStatus({
        logPath: config.logPath,
        enabled: config.enabled,
        minLevel: config.minLevel,
        maxFileSize: config.maxFileSize,
        maxFiles: config.maxFiles,
        exists: stats.exists,
        sizeBytes: stats.sizeBytes,
        lineCount: stats.lineCount,
        rotatedFiles: stats.rotatedFiles,
        oldestEntry: stats.oldestEntry,
        newestEntry: stats.newestEntry,
        readError: stats.readError,
      }));
    });

  // Log tail (view recent entries)
  logCmd
    .command('tail')
    .description('View recent log entries')
    .option('-n, --lines <count>', 'Number of lines to show', '20')
    .option('-f, --follow', 'Follow log file (like tail -f)')
    .action((options: { lines: string; follow?: boolean }) => {
      const lines = parseInt(options.lines, 10);
      if (isNaN(lines) || lines <= 0) {
        console.error(`Invalid --lines: '${options.lines}'. Expected a positive integer.`);
        process.exit(1);
      }
      const config = getLoggerConfig();

      if (options.follow) {
        // Follow mode - watch for changes
        console.log(`Following ${config.logPath} (Ctrl+C to stop)...`);
        console.log('');

        const state: PollState = { lastSize: 0 };
        try {
          state.lastSize = fs.statSync(config.logPath).size;
        } catch {
          // AUDIT-OK(no_empty_catch): initial statSync — file doesn't exist
          // yet is the common case (log tail --follow started before the
          // first entry is written). lastSize=0 self-corrects on the next
          // poll tick once the file appears.
        }

        // Show existing content first
        const existing = readRecentLogs(lines);
        existing.forEach((line) => console.log(line));

        // Watch for changes
        const interval = setInterval(() => {
          pollLogOnce(config.logPath, state, (line) => console.log(line));
        }, 500);

        process.on('SIGINT', () => {
          clearInterval(interval);
          console.log('\nStopped following log.');
          process.exit(0);
        });

        return;
      }

      // Normal mode - show recent lines
      const recentLines = readRecentLogs(lines);

      if (recentLines.length === 0) {
        console.log('No log entries found.');
        return;
      }

      recentLines.forEach((line) => console.log(line));
    });

  // Log clear
  logCmd
    .command('clear')
    .description('Clear the log file')
    .option('--all', 'Also remove rotated log files')
    .action((options: { all?: boolean }) => {
      const config = getLoggerConfig();

      try {
        if (fs.existsSync(config.logPath)) {
          fs.unlinkSync(config.logPath);
          console.log(`Cleared: ${config.logPath}`);
        }

        if (options.all) {
          for (let i = 1; i <= config.maxFiles; i++) {
            const rotatedPath = `${config.logPath}.${i}`;
            if (fs.existsSync(rotatedPath)) {
              fs.unlinkSync(rotatedPath);
              console.log(`Cleared: ${rotatedPath}`);
            }
          }
        }

        console.log('Log cleared.');
      } catch (err) {
        console.error(`Error clearing log: ${err instanceof Error ? err.message : 'unknown error'}`);
        process.exit(1);
      }
    });

  // Log path - just show the path (useful for scripting)
  logCmd
    .command('path')
    .description('Print the log file path')
    .action(() => {
      const config = getLoggerConfig();
      console.log(config.logPath);
    });
}
