import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export async function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<CommandResult> {
  const started = Date.now();
  const env = { ...process.env, ...opts.env };
  const resolvedCommand = await resolveCommand(command, env);
  const isWindowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedCommand);
  const child = isWindowsScript
    ? spawn("cmd.exe", ["/d", "/s", "/c", resolvedCommand, ...args], {
        cwd: opts.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      })
    : spawn(resolvedCommand, args, {
        cwd: opts.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let timeout: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  }).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });

  return {
    command: [command, ...args].join(" "),
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - started,
    timedOut
  };
}

async function resolveCommand(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== "win32") {
    return command;
  }

  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }

  const pathValue = env.PATH || env.Path || "";
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const pathext = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.toLowerCase())
    .filter(Boolean);
  const commandExt = path.extname(command).toLowerCase();
  const candidates = commandExt ? [command] : pathext.map((ext) => `${command}${ext}`);

  for (const dir of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      try {
        await access(fullPath);
        return fullPath;
      } catch {
        // try next candidate
      }
    }
  }

  return command;
}
