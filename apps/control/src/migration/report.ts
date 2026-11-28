import { RECORD_FILES, type RecordKind } from "./records.ts";

/**
 * What an import says before and after it runs (spec 29.5, "Dry run first"): counts per record
 * kind, every record that can't be imported with the reason, names that collide, records that
 * were imported with a change, settings 1.0 dropped with what happens instead, and the install
 * settings. The same report comes from a dry run and from the real import, because a dry run is
 * the real import rolled back.
 *
 * Nothing in a report is secret: names, hostnames and reasons only.
 */

export interface KindCount {
  inBundle: number;
  imported: number;
  /** Found from an earlier import of the same install: nothing changed. */
  alreadyImported: number;
  notImported: number;
}

export interface ReportLine {
  kind: RecordKind | "install";
  /** The record's name for people (a service name, an email, a hostname). */
  name: string;
  message: string;
}

export interface ImportReport {
  sourceVersion: string;
  exportedAt: string | null;
  dryRun: boolean;
  counts: Record<RecordKind, KindCount>;
  notImported: ReportLine[];
  collisions: ReportLine[];
  changed: ReportLine[];
  dropped: ReportLine[];
  install: ReportLine[];
  /** Services the move redeploys, in order. */
  moves: { service: string; server: string }[];
}

export function emptyReport(
  sourceVersion: string,
  exportedAt: string | null,
  dryRun: boolean,
): ImportReport {
  const counts = {} as Record<RecordKind, KindCount>;
  for (const kind of Object.keys(RECORD_FILES) as RecordKind[]) {
    counts[kind] = { inBundle: 0, imported: 0, alreadyImported: 0, notImported: 0 };
  }
  return {
    sourceVersion,
    exportedAt,
    dryRun,
    counts,
    notImported: [],
    collisions: [],
    changed: [],
    dropped: [],
    install: [],
    moves: [],
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The report as lines for a terminal. */
export function reportText(report: ImportReport): string[] {
  const lines: string[] = [];
  lines.push(
    report.dryRun
      ? `Dry run of the import from Nearzero ${report.sourceVersion}. Nothing was changed.`
      : `Imported from Nearzero ${report.sourceVersion}.`,
  );
  lines.push("");
  const width = Math.max(...Object.values(RECORD_FILES).map((item) => item.label.length));
  for (const kind of Object.keys(RECORD_FILES) as RecordKind[]) {
    const count = report.counts[kind];
    if (count.inBundle === 0) continue;
    const label = RECORD_FILES[kind].label;
    const parts = [`${count.imported} ${report.dryRun ? "to import" : "imported"}`];
    if (count.alreadyImported > 0) parts.push(`${count.alreadyImported} already imported`);
    if (count.notImported > 0) parts.push(`${count.notImported} can't be imported`);
    lines.push(`  ${label.padEnd(width)}  ${parts.join(", ")}`);
  }
  const section = (title: string, items: ReportLine[]) => {
    if (items.length === 0) return;
    lines.push("", title);
    for (const item of items) lines.push(`  - ${item.message}`);
  };
  section("Can't be imported:", report.notImported);
  section("Names that collide:", report.collisions);
  section("Imported with a change:", report.changed);
  section("Not in Nearzero 1.0:", report.dropped);
  section("Install settings:", report.install);
  if (report.moves.length > 0) {
    lines.push(
      "",
      `${plural(report.moves.length, "service")} ${report.dryRun ? "will be" : "are"} redeployed on the 1.0 runner, oldest deployed first. Each restarts once, briefly; data, addresses and passwords are kept.`,
    );
  }
  return lines;
}
