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

        let lastSize = 0;
        try {
          lastSize = fs.statSync(config.logPath).size;
        } catch {
          // File doesn't exist yet
        }

        // Show existing content first
        const existing = readRecentLogs(lines);
        existing.forEach((line) => console.log(line));

        // Watch for changes
        const interval = setInterval(() => {
          try {
            const currentSize = fs.statSync(config.logPath).size;
            if (currentSize > lastSize) {
              const content = fs.readFileSync(config.logPath, 'utf-8');
              const allLines = content.split('\n');
              const newLines = allLines.slice(-Math.max(1, allLines.length - Math.floor(lastSize / 100)));
              newLines.forEach((line) => {
                if (line.trim()) console.log(line);
              });
              lastSize = currentSize;
            }
          } catch {
            // File might not exist
          }
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
