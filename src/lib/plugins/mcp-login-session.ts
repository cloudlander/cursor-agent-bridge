import { randomUUID } from "node:crypto";

export type McpLoginPhase = "pending" | "succeeded" | "failed" | "timed_out";

export type McpLoginSessionView = {
  id: string;
  mcpKey: string;
  phase: McpLoginPhase;
  message: string;
  timeoutMs: number;
  startedAt: string;
  finishedAt?: string;
};

/** Process handle the login watcher needs. Matches the subset of ChildProcess we use. */
export type McpLoginProcess = {
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const RETAIN_MS = 30 * 60 * 1000;

type Session = {
  id: string;
  mcpKey: string;
  phase: McpLoginPhase;
  message: string;
  timeoutMs: number;
  startedAt: number;
  finishedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  kill?: () => void;
};

const sessions = new Map<string, Session>();

export function mcpOAuthTimeoutMs(): number {
  const raw = process.env.CURSOR_BRIDGE_MCP_OAUTH_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export function formatMcpOAuthTimeout(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

export function mcpOAuthTimeoutMessage(ms: number): string {
  return `Authentication timed out after ${formatMcpOAuthTimeout(ms)}.`;
}

export function mcpLoginFailureMessage(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last || /https:\/\//i.test(last) || /listening on/i.test(last)) {
    return "Authentication failed.";
  }
  const clipped = last.length > 180 ? `${last.slice(0, 177)}…` : last;
  return `Authentication failed. ${clipped}`;
}

function view(session: Session): McpLoginSessionView {
  return {
    id: session.id,
    mcpKey: session.mcpKey,
    phase: session.phase,
    message: session.message,
    timeoutMs: session.timeoutMs,
    startedAt: new Date(session.startedAt).toISOString(),
    finishedAt:
      session.finishedAt === undefined
        ? undefined
        : new Date(session.finishedAt).toISOString(),
  };
}

function finishSession(
  id: string,
  phase: Exclude<McpLoginPhase, "pending">,
  message: string,
): boolean {
  const session = sessions.get(id);
  if (!session || session.phase !== "pending") return false;
  session.phase = phase;
  session.message = message;
  session.finishedAt = Date.now();
  if (session.timer) clearTimeout(session.timer);
  session.timer = undefined;
  return true;
}

function prune(now: number): void {
  for (const [id, session] of sessions) {
    if (
      session.phase !== "pending" &&
      session.finishedAt !== undefined &&
      now - session.finishedAt > RETAIN_MS
    ) {
      sessions.delete(id);
    }
  }
}

/** Stop an in-flight login for this MCP key so a new attempt can take the callback port. */
export function cancelPendingMcpLogin(mcpKey: string): void {
  for (const session of sessions.values()) {
    if (session.mcpKey !== mcpKey || session.phase !== "pending") continue;
    if (
      finishSession(
        session.id,
        "failed",
        "Authentication failed. Replaced by a new login.",
      )
    ) {
      session.kill?.();
    }
  }
}

export function openMcpLoginSession(
  mcpKey: string,
  timeoutMs: number = mcpOAuthTimeoutMs(),
): McpLoginSessionView {
  const now = Date.now();
  prune(now);
  cancelPendingMcpLogin(mcpKey);
  const session: Session = {
    id: randomUUID(),
    mcpKey,
    phase: "pending",
    message: "Waiting for authentication.",
    timeoutMs,
    startedAt: now,
  };
  sessions.set(session.id, session);
  return view(session);
}

export function getMcpLoginSession(id: string): McpLoginSessionView | undefined {
  const session = sessions.get(id);
  return session ? view(session) : undefined;
}

export function watchMcpLoginProcess(id: string, child: McpLoginProcess): void {
  const session = sessions.get(id);
  if (!session || session.phase !== "pending") return;
  session.kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  };
  const settleExit = (code: number | null) => {
    if (code === 0) {
      finishSession(id, "succeeded", "Authentication succeeded.");
      return;
    }
    finishSession(id, "failed", "Authentication failed.");
  };
  child.on("exit", settleExit);
  child.on("error", (err) => {
    finishSession(id, "failed", `Authentication failed. ${err.message}`);
  });
  session.timer = setTimeout(() => {
    if (finishSession(id, "timed_out", mcpOAuthTimeoutMessage(session.timeoutMs))) {
      session.kill?.();
    }
  }, session.timeoutMs);
  session.timer.unref?.();
}

export function applyMcpLoginExit(
  id: string,
  code: number | null,
  output = "",
): void {
  if (code === 0) {
    finishSession(id, "succeeded", "Authentication succeeded.");
    return;
  }
  finishSession(id, "failed", mcpLoginFailureMessage(output));
}

export function resetMcpLoginSessions(): void {
  for (const session of sessions.values()) {
    if (session.timer) clearTimeout(session.timer);
  }
  sessions.clear();
}
