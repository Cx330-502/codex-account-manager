import type {
  CodexThreadRecord,
} from "./types";
import { runCommand } from "./cliSystem";

export class CodexThreadService {
  public constructor(private readonly sqlitePath: string) {}

  public async listNonArchivedThreads(): Promise<CodexThreadRecord[]> {
    const query = [
      "SELECT",
      "id,",
      "replace(title, char(10), ' '),",
      "cwd,",
      "git_branch,",
      "model,",
      "updated_at,",
      "created_at,",
      "archived,",
      "replace(first_user_message, char(10), ' ')",
      "FROM threads",
      "WHERE archived = 0",
      "ORDER BY updated_at DESC",
    ].join(" ");

    const result = await runSqliteQuery(this.sqlitePath, query);
    return result
      .map(parseThreadRow)
      .filter((row): row is CodexThreadRecord => row !== null);
  }

  public async findThreadById(id: string): Promise<CodexThreadRecord | null> {
    const query = [
      "SELECT",
      "id,",
      "replace(title, char(10), ' '),",
      "cwd,",
      "git_branch,",
      "model,",
      "updated_at,",
      "created_at,",
      "archived,",
      "replace(first_user_message, char(10), ' ')",
      "FROM threads",
      `WHERE id = '${escapeSqlString(id)}'`,
      "LIMIT 1",
    ].join(" ");
    const rows = await runSqliteQuery(this.sqlitePath, query);
    return parseThreadRow(rows[0] ?? null);
  }

  public async findRecentThreadCandidate(options: {
    cwd: string;
    startedAt: number;
    prompt: string | null;
    excludeThreadIds: Set<string>;
  }): Promise<CodexThreadRecord | null> {
    const promptClause = options.prompt
      ? ` AND first_user_message = '${escapeSqlString(options.prompt)}'`
      : "";
    const query = [
      "SELECT",
      "id,",
      "replace(title, char(10), ' '),",
      "cwd,",
      "git_branch,",
      "model,",
      "updated_at,",
      "created_at,",
      "archived,",
      "replace(first_user_message, char(10), ' ')",
      "FROM threads",
      "WHERE archived = 0",
      ` AND cwd = '${escapeSqlString(options.cwd)}'`,
      ` AND updated_at >= ${Math.floor(options.startedAt / 1000)}`,
      promptClause,
      "ORDER BY updated_at DESC",
      "LIMIT 20",
    ].join(" ");

    const rows = await runSqliteQuery(this.sqlitePath, query);
    const candidates = rows
      .map(parseThreadRow)
      .filter((row): row is CodexThreadRecord => row !== null);
    return (
      candidates.find((entry) => !options.excludeThreadIds.has(entry.id)) ?? null
    );
  }
}

async function runSqliteQuery(
  sqlitePath: string,
  sql: string,
): Promise<string[]> {
  const result = await runCommand("sqlite3", ["-readonly", "-list", "-separator", "\t", sqlitePath, sql]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function parseThreadRow(row: string | null): CodexThreadRecord | null {
  if (!row) {
    return null;
  }

  const columns = row.split("\t");
  if (columns.length < 9) {
    return null;
  }

  const updatedAt = Number.parseInt(columns[5] ?? "", 10);
  const createdAt = Number.parseInt(columns[6] ?? "", 10);

  return {
    id: columns[0] ?? "",
    title: columns[1] ?? "",
    cwd: columns[2] ?? "",
    gitBranch: emptyToNull(columns[3]),
    model: emptyToNull(columns[4]),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    archived: columns[7] === "1",
    firstUserMessage: columns[8] ?? "",
  };
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function emptyToNull(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}
