/**
 * spawn-helper.ts — 跨平台子进程 spawn 工具
 *
 * 处理 Windows 与 Unix 在 PATH 分隔符（; vs :）和 shell 选择
 *（Windows 用 pwsh，Unix 用 shebang）上的差异。
 *
 * 所有 spawn 调用都应通过本模块，以保证跨平台兼容。
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// ── 平台检测 ─────────────────────────────────────────────────────

const isWindows = process.platform === "win32";

// ── PATH 构建 ─────────────────────────────────────────────────────

/**
 * 构建跨平台的 PATH 环境变量。
 * 在 Unix 上使用 ":" 分隔，Windows 上使用 ";"。
 *
 * extraDirs 会被追加到当前进程的 PATH 之后。
 * 内置了常见 Unix 路径（/usr/local/bin 等），在 Windows 上会被自动跳过。
 */
export function buildPath(extraDirs: string[] = []): string {
  const separator = isWindows ? ";" : ":";

  const unixDirs = [
    "/usr/local/bin",
    path.join(os.homedir(), "bin"),
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
  ];

  const parts = [process.env.PATH || ""];

  for (const dir of [...unixDirs, ...extraDirs]) {
    // Windows 上跳过不存在的 Unix 路径
    if (isWindows && dir.startsWith("/")) continue;
    parts.push(dir);
  }

  return parts.filter(Boolean).join(separator);
}

// ── 命令 spawn — 平台适配 ──────────────────────────────────────

/**
 * 跨平台 spawn 一个命令。
 *
 * Windows：通过 pwsh（PowerShell 7）执行。pwsh 的单引号行为和 Unix sh 一致。
 * Unix：直接 spawn（依赖 shebang）。
 */
export function spawnCommand(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  if (isWindows) {
    // pwsh 单引号 = 字面量字符串（和 sh 一致），无需特殊转义
    const escaped = args.map((a) => {
      if (a.includes("'")) {
        // 含单引号：用双引号包裹，内部 " 转义为 `"
        return `"${a.replace(/"/g, '`"')}"`;
      }
      if (/[\s"$`(){}|&<>^]/.test(a)) {
        // 含特殊字符：单引号包裹（pwsh 字面量，原样传递）
        return `'${a}'`;
      }
      return a;
    });
    const cmdLine = [command, ...escaped].join(" ");
    return spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", cmdLine], {
      ...options,
      windowsHide: true,
    });
  }

  // Unix / macOS: 直接 spawn（依赖 shebang 或 ELF）
  return spawn(command, args, options);
}

// ── openclaw 专用 spawn ──────────────────────────────────────────

/**
 * spawn openclaw 命令（处理 Windows 上 openclaw 是 .cmd 文件的问题）。
 *
 * 等价于: spawnCommand("openclaw", args, options)
 */
export function spawnOpenclaw(
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  // 优先使用 OPENCLAW_BIN 环境变量
  const bin = process.env.OPENCLAW_BIN || "openclaw";
  return spawnCommand(bin, args, options);
}

// ── Shell 脚本 spawn ────────────────────────────────────────────

/**
 * 执行一段 shell 脚本（用户自定义命令，含管道/重定向等 shell 语法）。
 * Windows → pwsh, Unix → /bin/sh。
 */
export function spawnShellScript(
  script: string,
  options: SpawnOptions = {},
): ChildProcess {
  if (isWindows) {
    return spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      ...options,
      windowsHide: true,
    });
  }
  return spawn(script, [], {
    ...options,
    shell: true, // /bin/sh
  });
}
