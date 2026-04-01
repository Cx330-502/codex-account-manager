import * as fs from "node:fs/promises";
import * as path from "node:path";

import { quoteForShell } from "./auth";
import { runCommand } from "./cliSystem";
import type {
  ManagerWorkspaceRegistry,
  WorkspacePaneRecord,
  WorkspaceWindowRecord,
} from "./types";

const WORKSPACE_REGISTRY_VERSION = 1 as const;

export interface LiveTmuxPane {
  sessionName: string;
  sessionId: string;
  windowId: string;
  windowName: string;
  paneId: string;
  paneCurrentPath: string;
}

export interface CreatePaneResult {
  sessionName: string;
  windowId: string;
  windowName: string;
  paneId: string;
}

export class TmuxWorkspaceService {
  private readonly registryPath: string;

  public constructor(
    managerRoot: string,
    private readonly sessionName: string,
  ) {
    this.registryPath = path.join(managerRoot, "workspace-manager.json");
  }

  public async loadRegistry(): Promise<ManagerWorkspaceRegistry> {
    const current = await this.readRegistryFile();
    if (!current || current.version !== WORKSPACE_REGISTRY_VERSION) {
      return {
        version: WORKSPACE_REGISTRY_VERSION,
        sessionName: this.sessionName,
        sessionId: null,
        windows: [],
        panes: [],
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      ...current,
      sessionName: current.sessionName || this.sessionName,
      sessionId: current.sessionId ?? null,
      windows: Array.isArray(current.windows) ? current.windows : [],
      panes: Array.isArray(current.panes) ? current.panes : [],
    };
  }

  public async saveRegistry(registry: ManagerWorkspaceRegistry): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      this.registryPath,
      `${JSON.stringify(
        {
          ...registry,
          version: WORKSPACE_REGISTRY_VERSION,
          sessionName: this.sessionName,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  public async ensureWorkspaceSession(cwd: string): Promise<{
    sessionName: string;
    sessionId: string;
  }> {
    const hasSession = await this.hasSession();
    if (!hasSession) {
      await runCommand("tmux", [
        "new-session",
        "-d",
        "-s",
        this.sessionName,
        "-n",
        "workspace",
        "-c",
        cwd,
      ]);
    }

    const sessionId = await this.getSessionId();
    return {
      sessionName: this.sessionName,
      sessionId,
    };
  }

  public async hasSession(): Promise<boolean> {
    const result = await runCommand(
      "tmux",
      ["has-session", "-t", this.sessionName],
      {
        allowNonZeroExit: true,
      },
    );
    return result.exitCode === 0;
  }

  public async listLivePanes(): Promise<LiveTmuxPane[]> {
    if (!(await this.hasSession())) {
      return [];
    }

    const result = await runCommand("tmux", [
      "list-panes",
      "-s",
      "-t",
      this.sessionName,
      "-F",
      "#{session_name}\t#{session_id}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_current_path}",
    ]);

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split("\t");
        return {
          sessionName: parts[0] ?? "",
          sessionId: parts[1] ?? "",
          windowId: parts[2] ?? "",
          windowName: parts[3] ?? "",
          paneId: parts[4] ?? "",
          paneCurrentPath: parts[5] ?? "",
        };
      })
      .filter((entry) => entry.sessionName === this.sessionName);
  }

  public async ensureWindowForCwd(
    registry: ManagerWorkspaceRegistry,
    cwd: string,
  ): Promise<WorkspaceWindowRecord | null> {
    const livePanes = await this.listLivePanes();
    const liveWindowIds = new Set(livePanes.map((pane) => pane.windowId));
    const existing =
      registry.windows.find(
        (window) => window.cwd === cwd && liveWindowIds.has(window.windowId),
      ) ?? null;
    if (existing) {
      return existing;
    }

    return null;
  }

  public async createThreadPane(options: {
    registry: ManagerWorkspaceRegistry;
    cwd: string;
    command: string;
  }): Promise<CreatePaneResult> {
    const window = await this.ensureWindowForCwd(options.registry, options.cwd);
    const format = "#{window_id}\t#{window_name}\t#{pane_id}";
    const args = window
      ? [
          "split-window",
          "-d",
          "-t",
          window.windowId,
          "-c",
          options.cwd,
          "-P",
          "-F",
          format,
          options.command,
        ]
      : [
          "new-window",
          "-d",
          "-t",
          this.sessionName,
          "-n",
          buildWindowName(options.cwd),
          "-c",
          options.cwd,
          "-P",
          "-F",
          format,
          options.command,
        ];

    const result = await runCommand("tmux", args);
    const [windowId, windowName, paneId] = result.stdout.trim().split("\t");
    if (!windowId || !paneId) {
      throw new Error("Failed to create tmux pane for Codex thread.");
    }

    return {
      sessionName: this.sessionName,
      windowId,
      windowName: windowName ?? buildWindowName(options.cwd),
      paneId,
    };
  }

  public async focusPane(paneId: string): Promise<void> {
    await runCommand("tmux", ["select-pane", "-t", paneId]);
  }

  public async attach(): Promise<void> {
    await runCommand("tmux", ["attach-session", "-t", this.sessionName], {
      allowNonZeroExit: true,
    });
  }

  public async reconcileRegistry(
    registry: ManagerWorkspaceRegistry,
  ): Promise<ManagerWorkspaceRegistry> {
    const livePanes = await this.listLivePanes();
    const livePaneMap = new Map(livePanes.map((pane) => [pane.paneId, pane]));
    const now = new Date().toISOString();

    const nextPanes = registry.panes
      .filter((pane) => {
        return livePaneMap.has(pane.paneId) || pane.threadId !== null;
      })
      .map((pane) => {
        const live = livePaneMap.get(pane.paneId);
        if (!live) {
          return pane;
        }

        return {
          ...pane,
          windowId: live.windowId,
          cwd: live.paneCurrentPath || pane.cwd,
          lastSeenAt: now,
        };
      });

    const liveWindowMap = new Map(
      livePanes.map((pane) => [
        pane.windowId,
        {
          windowId: pane.windowId,
          windowName: pane.windowName,
        },
      ]),
    );

    const nextWindows = registry.windows
      .filter((window) => liveWindowMap.has(window.windowId))
      .map((window) => ({
        ...window,
        windowName: liveWindowMap.get(window.windowId)?.windowName ?? window.windowName,
        lastSeenAt: now,
      }));

    return {
      ...registry,
      sessionId: livePanes[0]?.sessionId ?? registry.sessionId,
      windows: nextWindows,
      panes: nextPanes,
      updatedAt: now,
    };
  }

  public updateWindowRecord(
    registry: ManagerWorkspaceRegistry,
    record: WorkspaceWindowRecord,
  ): ManagerWorkspaceRegistry {
    const windows = registry.windows.filter((entry) => entry.cwd !== record.cwd);
    windows.push(record);
    return {
      ...registry,
      windows,
    };
  }

  public upsertPaneRecord(
    registry: ManagerWorkspaceRegistry,
    record: WorkspacePaneRecord,
  ): ManagerWorkspaceRegistry {
    const panes = registry.panes.filter((entry) => entry.paneId !== record.paneId);
    if (record.threadId) {
      for (let index = panes.length - 1; index >= 0; index -= 1) {
        if (panes[index]?.threadId === record.threadId) {
          panes.splice(index, 1);
        }
      }
    }
    panes.push(record);
    return {
      ...registry,
      panes,
    };
  }

  public findPaneByThreadId(
    registry: ManagerWorkspaceRegistry,
    threadId: string,
  ): WorkspacePaneRecord | null {
    return registry.panes.find((pane) => pane.threadId === threadId) ?? null;
  }

  private async getSessionId(): Promise<string> {
    const result = await runCommand("tmux", [
      "display-message",
      "-p",
      "-t",
      this.sessionName,
      "#{session_id}",
    ]);
    const sessionId = result.stdout.trim();
    if (!sessionId) {
      throw new Error(`Unable to resolve tmux session id for ${this.sessionName}.`);
    }

    return sessionId;
  }

  private async readRegistryFile(): Promise<ManagerWorkspaceRegistry | null> {
    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      return JSON.parse(raw) as ManagerWorkspaceRegistry;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }
}

export function buildWindowName(cwd: string): string {
  const baseName = path.basename(cwd) || "workspace";
  return baseName.slice(0, 24);
}

export function buildCodexCommand(options: {
  prompt?: string | null;
  resumeThreadId?: string | null;
  cwd: string;
}): string {
  const command = ["codex", "-C", quoteForShell(options.cwd)];

  if (options.resumeThreadId) {
    command.push("resume", quoteForShell(options.resumeThreadId));
  }

  if (options.prompt && !options.resumeThreadId) {
    command.push(quoteForShell(options.prompt));
  }

  return command.join(" ");
}
