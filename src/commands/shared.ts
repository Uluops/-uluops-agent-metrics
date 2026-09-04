/**
 * Shared CLI Command Helpers
 *
 * Filters and utilities used by more than one command module, so behavior
 * (e.g. what `-p`/`--project` means) cannot drift between commands that
 * expose the same flag.
 */

import type { BufferEntry } from '../buffer.js';

/**
 * Filter buffer entries to those whose `project_path` partially matches
 * (case-insensitive substring match). Used by `buffer list -p` and
 * `reconcile -p` — extracted so the two commands share one definition of
 * what `-p` means rather than each hand-copying the filter.
 *
 * @param entries - Buffer entries to filter
 * @param project - Partial project path to match (case-insensitive); no-op if omitted
 * @returns The entries whose `project_path` includes `project` (case-insensitive)
 */
export function filterByProjectPath<T extends { project_path?: string }>(
  entries: T[],
  project?: string
): T[] {
  if (!project) return entries;
  const projectFilter = project.toLowerCase();
  return entries.filter(e => e.project_path?.toLowerCase().includes(projectFilter));
}
