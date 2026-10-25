/**
 * Book details Hardcover fills in that a user can also set by hand. A value set by hand sticks over the
 * lookup (`<flag>_manual = 1`); clearing it hands the field back to Hardcover. The names here are
 * trusted constants and the only ones ever put into SQL.
 */
export const MANUAL_DETAILS = [
  { flag: 'genres', columns: ['genres'] },
  { flag: 'moods', columns: ['moods'] },
  { flag: 'content_warnings', columns: ['content_warnings'] },
  { flag: 'description', columns: ['description'] },
  // A series named by hand also takes its number and drops Hardcover's series id, which would point at
  // the series Hardcover found.
  { flag: 'series', columns: ['series', 'series_position', 'hc_series_id'] },
  { flag: 'release_year', columns: ['release_year'] },
] as const;

export type ManualFlag = (typeof MANUAL_DETAILS)[number]['flag'];

const flagOf = new Map<string, string>(MANUAL_DETAILS.flatMap((d) => d.columns.map((c) => [c, d.flag] as const)));

/** `column = <the lookup's value unless set by hand>`, for an UPDATE that takes the lookup's value as `?`. */
export function keepManual(column: string): string {
  const flag = flagOf.get(column);
  if (!flag) throw new Error(`${column} is not a manual detail`);
  return `${column} = CASE WHEN ${flag}_manual THEN ${column} ELSE ? END`;
}

/** Every column and flag a merge carries over. */
export const MANUAL_COLUMNS = MANUAL_DETAILS.flatMap((d) => [...d.columns, `${d.flag}_manual`]);

/**
 * The merge's SET clauses: a detail set by hand beats the lookup's, the kept document's when both are; else
 * the kept document's when it has one. A group (series) moves together, so a series and the number from the
 * other copy never mix. Set by hand counts even when empty: a list cleared on purpose stays cleared.
 */
export function mergeManualSql(): string {
  return MANUAL_DETAILS.flatMap((d) => {
    const fromAlias = `excluded.${d.flag}_manual AND NOT documents.${d.flag}_manual`;
    const keepOwn = `documents.${d.flag}_manual OR documents.${d.columns[0]} IS NOT NULL`;
    return [
      ...d.columns.map((c) =>
        `${c} = CASE WHEN ${fromAlias} THEN excluded.${c} WHEN ${keepOwn} THEN documents.${c} ELSE excluded.${c} END`),
      `${d.flag}_manual = MAX(documents.${d.flag}_manual, excluded.${d.flag}_manual)`,
    ];
  }).join(',\n         ');
}
