import { execFile, spawn } from "node:child_process";

import type { BinaryDependencyStatus, CliDependencyStatus } from "./types";

const COMMAND_TIMEOUT_MS = 15_000;

export async function detectCliDependencies(): Promise<CliDependencyStatus> {
  const [codex, tmux, sqlite3] = await Promise.all([
    detectBinary("codex", ["--version"]),
    detectBinary("tmux", ["-V"]),
    detectBinary("sqlite3", ["--version"]),
  ]);

  return {
    codex,
    tmux,
    sqlite3,
  };
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    allowNonZeroExit?: boolean;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const normalizedStdout = String(stdout);
        const normalizedStderr = String(stderr);
        const exitCode =
          error && typeof (error as { code?: number }).code === "number"
            ? (error as { code: number }).code
            : 0;

        if (error && !options.allowNonZeroExit) {
          reject(
            new Error(
              normalizedStderr.trim() ||
                normalizedStdout.trim() ||
                error.message,
            ),
          );
          return;
        }

        resolve({
          stdout: normalizedStdout,
          stderr: normalizedStderr,
          exitCode,
        });
      },
    );
  });
}

export async function runInteractiveCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      shell: false,
    });

    child.once("error", (error) => {
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(
          new Error(`${command} ${args.join(" ")} exited due to signal ${signal}.`),
        );
        return;
      }
      resolve(code ?? 0);
    });
  });
}

async function detectBinary(
  name: string,
  versionArgs: string[],
): Promise<BinaryDependencyStatus> {
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const located = await runCommand(locator, [name], {
      allowNonZeroExit: false,
    });
    const binaryPath = firstLine(located.stdout) ?? null;
    const versionInfo = await runCommand(name, versionArgs, {
      allowNonZeroExit: true,
    });
    const version =
      firstLine(versionInfo.stdout) ??
      firstLine(versionInfo.stderr) ??
      null;

    return {
      name,
      available: true,
      path: binaryPath,
      version,
      error: null,
    };
  } catch (error) {
    return {
      name,
      available: false,
      path: null,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function firstLine(value: string): string | null {
  const normalized = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return normalized ?? null;
}
