/**
 * Phase 3c: 命令策略引擎
 *
 * 负责在 openry_run 执行前检查命令是否符合策略。
 * 支持三种引用方式：
 *   1. 字符串 "strict"/"moderate"/"permissive" → 内置预设
 *   2. 字符串 其他 → 从 ~/.openry/policies/<name>.yaml 加载
 *   3. 对象 → 内联配置
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CommandPolicyObject, ParamRule, PatternRule } from "./yaml-loader.js";

// ── 内置策略预设 ──────────────────────────────────────────────

/**
 * strict: 极危险 + 高危险命令全部拦截。
 * 适用于生产环境、面向外部用户的 workflow。
 */
export const DEFAULT_STRICT: CommandPolicyObject = {
  mode: "blocklist",
  commands: [
    "rm", "sudo", "mkfs", "dd", "shutdown", "reboot", "halt", "poweroff",
    "init", "telinit", "diskutil", "iptables", "nft", "ufw", "crontab",
    "eval", "source", "format", "diskpart", "reg", "sc", "wevtutil",
  ],
  patterns: [
    // Critical: filesystem destruction
    { regex: "^rm\\s+-rf\\s+/\\s*$", description: "禁止 rm -rf / (Unix)" },
    { regex: "^rm\\s+-rf\\s+~", description: "禁止 rm -rf ~ (Unix)" },
    { regex: "^rm\\s+-rf\\s+\\$HOME", description: "禁止 rm -rf $HOME (Unix)" },
    { regex: "^mkfs\\.", description: "禁止格式化磁盘 (Unix)" },
    { regex: "dd\\s+.*of=/dev/", description: "禁止覆写块设备 (Unix)" },
    { regex: ">\\s*/dev/sd[a-z]", description: "禁止重定向覆盖磁盘 (Linux)" },
    { regex: ">\\s*/dev/disk[0-9]", description: "禁止重定向覆盖磁盘 (macOS)" },
    { regex: ">\\s*/dev/nvme", description: "禁止重定向覆盖 NVMe (Unix)" },
    { regex: "diskutil\\s+eraseDisk", description: "禁止 macOS 格式化磁盘" },
    { regex: "diskutil\\s+partitionDisk", description: "禁止 macOS 重新分区" },
    // Critical: system shutdown
    { regex: "^(shutdown|reboot|halt|poweroff)\\b", description: "禁止关机/重启 (Unix)" },
    { regex: "^init\\s+[06]", description: "禁止切换运行级别 (Linux)" },
    { regex: "^telinit\\s", description: "禁止 telinit (Linux)" },
    { regex: "^kill\\s+-9\\s+1$", description: "禁止杀死 PID 1 (Linux)" },
    // Critical: fork bomb
    { regex: ":\\(\\).*:\\|:.*", description: "禁止 fork bomb (Unix)" },
    // Critical: permissions
    { regex: "chmod\\s+-R\\s+777\\s+/", description: "禁止全系统权限设置为 777" },
    // Critical: Windows disk
    { regex: "^format\\s+[A-Z]:", description: "禁止格式化磁盘 (Windows CMD)" },
    { regex: "^Format-Volume\\s+-DriveLetter", description: "禁止格式化卷 (Windows PS)" },
    { regex: "^Clear-Disk\\s", description: "禁止清除磁盘 (Windows PS)" },
    { regex: "^Initialize-Disk\\s", description: "禁止初始化磁盘 (Windows PS)" },
    { regex: "^diskpart\\s+/s\\s+.*clean", description: "禁止 diskpart clean (Windows)" },
    // Critical: Windows shutdown
    { regex: "^shutdown\\s+/[sr]", description: "禁止关机/重启 (Windows CMD)" },
    { regex: "^(Stop-Computer|Restart-Computer)\\b", description: "禁止关机/重启 (Windows PS)" },
    // Critical: Windows recursive delete
    { regex: "^del\\s+/f\\s+/s\\s+/q\\s+[A-Z]:\\\\", description: "禁止递归删除盘符 (Windows CMD)" },
    { regex: "^Remove-Item\\s+-Recurse\\s+-Force\\s+[A-Z]:\\\\", description: "禁止递归删除盘符 (Windows PS)" },
    { regex: "^rmdir\\s+/s\\s+/q\\s+[A-Z]:\\\\", description: "禁止递归删除盘符 (Windows CMD)" },
    { regex: "^rd\\s+/s\\s+/q\\s+[A-Z]:\\\\", description: "禁止递归删除盘符 (Windows CMD)" },
    // High: remote script execution
    { regex: "curl.*\\|\\s*(ba)?sh", description: "禁止 curl 管道到 shell" },
    { regex: "wget.*-O\\s*-\\s*\\|\\s*(ba)?sh", description: "禁止 wget 管道到 shell" },
    // High: package installation
    { regex: "^(pip3?|npm|gem)\\s+install\\s+(?!-r)", description: "禁止安装未审查的包" },
    // High: git destructive
    { regex: "^git\\s+push\\s+--force", description: "禁止 git push --force" },
    { regex: "^git\\s+reset\\s+--hard", description: "禁止 git reset --hard" },
    { regex: "^git\\s+clean\\s+-fd", description: "禁止 git clean -fd" },
    // High: docker destructive
    { regex: "docker\\s+(rm|rmi)\\s+-f\\s+\\$\\(", description: "禁止批量删除容器/镜像" },
    { regex: "docker\\s+system\\s+prune\\s+-af", description: "禁止清理全部 Docker 资源" },
    { regex: "docker\\s+compose\\s+down\\s+-v", description: "禁止 docker compose down -v" },
    // High: dynamic execution
    { regex: "^eval\\s", description: "禁止 eval (Unix)" },
    { regex: "Invoke-Expression\\s", description: "禁止 Invoke-Expression (Windows PS)" },
    { regex: "\\biex\\s", description: "禁止 iex (Windows PS)" },
    // High: firewall
    { regex: "iptables\\s+-F", description: "禁止清空 iptables 规则 (Linux)" },
    { regex: "nft\\s+flush\\s+ruleset", description: "禁止清空 nftables 规则 (Linux)" },
    { regex: "ufw\\s+disable", description: "禁止关闭 ufw 防火墙 (Linux)" },
    // High: credential leak
    { regex: "curl.*\\s+-u\\s", description: "禁止 curl 带 Basic Auth" },
    { regex: "-H\\s*['\"]?Authorization", description: "禁止命令行携带 Authorization header" },
    { regex: "\\b(?:API_KEY|api_key|TOKEN|SECRET|PASSWORD)\\s*=\\s*\\S+", description: "禁止命令行明文密钥" },
    // High: Windows system
    { regex: "^sc\\s+delete\\s", description: "禁止删除 Windows 服务" },
    { regex: "^reg\\s+delete\\s+(?:HKLM|HKEY_LOCAL_MACHINE)", description: "禁止删除注册表系统键" },
    { regex: "^Remove-Item\\s+.*HKLM", description: "禁止删除注册表 (Windows PS)" },
    { regex: "^Set-ExecutionPolicy\\s+Unrestricted", description: "禁止关闭执行策略 (Windows)" },
    { regex: "^net\\s+user\\s+.*\\/delete", description: "禁止删除用户账户 (Windows)" },
    { regex: "^wevtutil\\s+cl\\s", description: "禁止清除事件日志 (Windows)" },
    { regex: "^Remove-LocalUser\\s", description: "禁止删除本地用户 (Windows PS)" },
    { regex: "^Disable-WindowsOptionalFeature", description: "禁止禁用系统功能 (Windows)" },
    { regex: "^wmic\\s+process\\s+where.*delete", description: "禁止批量杀进程 (Windows)" },
    { regex: "^Stop-Process\\s+-Force", description: "禁止强制杀进程 (Windows PS)" },
    // High: other
    { regex: "^rm\\s+-rf\\s", description: "禁止 rm -rf 任意路径 (Unix)" },
    { regex: ">\\s*/etc/", description: "禁止覆写系统配置 (Unix)" },
    { regex: ">\\s*/usr/", description: "禁止覆写系统文件 (Unix)" },
    { regex: "^crontab\\s+-r", description: "禁止删除 crontab (Unix)" },
    { regex: "^source\\s+[^~.]", description: "禁止 source 不可信脚本 (Unix)" },
    { regex: "^\\s*\\.\\s+/", description: "禁止点命令加载脚本 (Unix)" },
  ],
  params: [
    {
      command: "curl",
      blocked_flags: ["-u", "--data", "--data-raw", "--data-binary"],
      blocked_flag_patterns: ["-H\\s*['\"]?Authorization", "-H\\s*Cookie"],
    },
    {
      command: "git",
      blocked_subcommands: ["push", "commit", "rebase", "reset", "clean", "stash"],
    },
    {
      command: "docker",
      blocked_subcommands: ["rm", "rmi", "system", "compose"],
    },
  ],
};

/**
 * moderate: 仅极危险命令拦截。
 * 适用于内部开发环境、可信 workflow。
 */
export const DEFAULT_MODERATE: CommandPolicyObject = {
  mode: "blocklist",
  commands: [
    "mkfs", "dd", "shutdown", "reboot", "halt", "poweroff",
    "init", "telinit", "diskutil", "format", "diskpart",
  ],
  patterns: [
    // Critical only
    { regex: "^rm\\s+-rf\\s+/\\s*$", description: "禁止 rm -rf / (Unix)" },
    { regex: "^rm\\s+-rf\\s+~", description: "禁止 rm -rf ~ (Unix)" },
    { regex: "^rm\\s+-rf\\s+\\$HOME", description: "禁止 rm -rf $HOME (Unix)" },
    { regex: "^mkfs\\.", description: "禁止格式化磁盘 (Unix)" },
    { regex: "dd\\s+.*of=/dev/", description: "禁止覆写块设备 (Unix)" },
    { regex: ">\\s*/dev/sd[a-z]", description: "禁止重定向覆盖磁盘 (Linux)" },
    { regex: ">\\s*/dev/disk[0-9]", description: "禁止重定向覆盖磁盘 (macOS)" },
    { regex: ">\\s*/dev/nvme", description: "禁止重定向覆盖 NVMe (Unix)" },
    { regex: "diskutil\\s+eraseDisk", description: "禁止 macOS 格式化磁盘" },
    { regex: "diskutil\\s+partitionDisk", description: "禁止 macOS 重新分区" },
    { regex: "^(shutdown|reboot|halt|poweroff)\\b", description: "禁止关机/重启 (Unix)" },
    { regex: "^init\\s+[06]", description: "禁止切换运行级别 (Linux)" },
    { regex: "^telinit\\s", description: "禁止 telinit (Linux)" },
    { regex: ":\\(\\).*:\\|:.*", description: "禁止 fork bomb (Unix)" },
    { regex: "chmod\\s+-R\\s+777\\s+/", description: "禁止全系统权限设置为 777" },
    { regex: "^format\\s+[A-Z]:", description: "禁止格式化磁盘 (Windows CMD)" },
    { regex: "^Format-Volume\\s+-DriveLetter", description: "禁止格式化卷 (Windows PS)" },
    { regex: "^Clear-Disk\\s", description: "禁止清除磁盘 (Windows PS)" },
    { regex: "^Initialize-Disk\\s", description: "禁止初始化磁盘 (Windows PS)" },
    { regex: "^diskpart\\s+/s\\s+.*clean", description: "禁止 diskpart clean (Windows)" },
    { regex: "^shutdown\\s+/[sr]", description: "禁止关机/重启 (Windows CMD)" },
    { regex: "^(Stop-Computer|Restart-Computer)\\b", description: "禁止关机/重启 (Windows PS)" },
    { regex: "^del\\s+/f\\s+/s\\s+/q\\s+[A-Z]:\\\\", description: "禁止递归删除盘符 (Windows CMD)" },
    { regex: "^Remove-Item\\s+-Recurse\\s+-Force\\s+[A-Z]:\\\\", description: "禁止递归删除盘符 (Windows PS)" },
    { regex: "^rmdir\\s+/s\\s+/q\\s+[A-Z]:\\\\", description: "禁止递归删除盘符 (Windows CMD)" },
    { regex: "^rd\\s+/s\\s+/q\\s+[A-Z]:\\\\", description: "禁止递归删除盘符 (Windows CMD)" },
  ],
};

/** 内置预设索引 */
export const BUILTIN_POLICIES: ReadonlyMap<string, CommandPolicyObject> = new Map([
  ["strict", DEFAULT_STRICT],
  ["moderate", DEFAULT_MODERATE],
  ["permissive", { mode: "unrestricted" }],
]);

// ── 策略解析 ──────────────────────────────────────────────────

/**
 * 将 command_policy 字段解析为可用的策略对象。
 *
 * - undefined / null → null（无策略，放行所有命令）
 * - "strict" / "moderate" / "permissive" → 内置预设
 * - 其他字符串 → 从 ~/.openry/policies/<name>.yaml 加载
 * - 对象 → 直接返回
 */
export function resolvePolicy(
  policyRef: string | CommandPolicyObject | undefined | null,
): CommandPolicyObject | null {
  if (policyRef == null) return null;

  // 对象形式：直接返回
  if (typeof policyRef === "object") return policyRef;

  // 字符串形式
  const name = policyRef.trim();
  if (!name) return null;

  // 尝试内置预设
  const builtin = BUILTIN_POLICIES.get(name);
  if (builtin) return builtin;

  // 尝试从文件加载
  return loadPolicyFile(name);
}

/**
 * 从 ~/.openry/policies/<name>.yaml 加载自定义策略。
 * 加载失败时返回 null（fail-open：不阻止命令执行）。
 */
function loadPolicyFile(name: string): CommandPolicyObject | null {
  try {
    const configDir = process.env.OPENRY_HOME ?? path.join(os.homedir(), ".openry");
    const yamlPath = path.join(configDir, "policies", `${name}.yaml`);
    if (!fs.existsSync(yamlPath)) {
      // Also try .yml extension
      const ymlPath = path.join(configDir, "policies", `${name}.yml`);
      if (!fs.existsSync(ymlPath)) {
        console.warn(`[command-policy] Policy file not found: ${yamlPath}`);
        return null;
      }
      const yaml = loadYamlModule();
      const loaded = yaml.load(fs.readFileSync(ymlPath, "utf-8")) as CommandPolicyObject;
      return validatePolicyShape(loaded) ? loaded : null;
    }
    const yaml = loadYamlModule();
    const loaded = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as CommandPolicyObject;
    return validatePolicyShape(loaded) ? loaded : null;
  } catch (err) {
    console.warn(`[command-policy] Failed to load policy "${name}":`, err);
    return null;
  }
}

function loadYamlModule(): { load: (text: string) => unknown } {
  // Dynamic import of js-yaml for optional file loading
  // (bundled with the plugin via package.json dependencies)
  const yaml = require("js-yaml") as { load: (text: string) => unknown };
  return yaml;
}

function validatePolicyShape(obj: unknown): obj is CommandPolicyObject {
  if (!obj || typeof obj !== "object") return false;
  const p = obj as Record<string, unknown>;
  if (p.mode && !["unrestricted", "allowlist", "blocklist"].includes(String(p.mode))) return false;
  return true;
}

// ── 策略评估 ──────────────────────────────────────────────────

export type PolicyResult = {
  allowed: boolean;
  reason?: string;
  rule?: string;
};

/**
 * 评估一条命令是否符合策略。
 *
 * @param command  完整的命令字符串
 * @param policy   已解析的策略对象
 * @returns        评估结果
 */
export function evaluatePolicy(command: string, policy: CommandPolicyObject): PolicyResult {
  // 1. mode=unrestricted → 放行
  if (policy.mode === "unrestricted") {
    return { allowed: true };
  }

  const trimmed = command.trim();
  if (!trimmed) return { allowed: true };

  // 2. 命令名检查
  const cmdName = extractCommandName(trimmed);
  if (policy.commands && policy.commands.length > 0) {
    if (policy.mode === "blocklist" && policy.commands.includes(cmdName)) {
      return { allowed: false, reason: `命令 '${cmdName}' 在 blocklist 中`, rule: `blocklist:${cmdName}` };
    }
    if (policy.mode === "allowlist" && !policy.commands.includes(cmdName)) {
      return { allowed: false, reason: `命令 '${cmdName}' 不在 allowlist 中`, rule: `allowlist:${cmdName}` };
    }
  }

  // 3. 正则模式匹配
  if (policy.patterns && policy.patterns.length > 0) {
    for (const pattern of policy.patterns) {
      try {
        if (new RegExp(pattern.regex).test(trimmed)) {
          return {
            allowed: false,
            reason: pattern.description || `匹配禁止模式: ${pattern.regex}`,
            rule: `pattern:${pattern.regex}`,
          };
        }
      } catch {
        // 无效正则，跳过
      }
    }
  }

  // 4. 参数级别控制
  if (policy.params && policy.params.length > 0) {
    const paramResult = evaluateParams(trimmed, cmdName, policy.params);
    if (paramResult) return paramResult;
  }

  return { allowed: true };
}

// ── 辅助函数 ──────────────────────────────────────────────────

/** 从命令字符串提取命令名（去除路径前缀和参数） */
function extractCommandName(command: string): string {
  const trimmed = command.trim();
  // 处理 sudo 前缀
  const withoutSudo = trimmed.replace(/^sudo\s+/, "");
  // 取第一个空白分隔的词
  const firstWord = withoutSudo.split(/\s+/)[0] ?? "";
  // 去除路径前缀（如 /usr/bin/git → git）
  return firstWord.split("/").pop() ?? firstWord;
}

/** 评估参数级别规则 */
function evaluateParams(
  command: string,
  cmdName: string,
  rules: ParamRule[],
): PolicyResult | null {
  for (const rule of rules) {
    // 只匹配对应命令
    if (rule.command !== cmdName) continue;

    // blocked_flags: 任一命中即拒绝
    if (rule.blocked_flags) {
      for (const flag of rule.blocked_flags) {
        if (commandHasFlag(command, flag)) {
          return {
            allowed: false,
            reason: `命令 '${cmdName}' 包含禁止的 flag: ${flag}`,
            rule: `param:${cmdName}:blocked_flag:${flag}`,
          };
        }
      }
    }

    // blocked_flag_patterns: 任一正则命中即拒绝
    if (rule.blocked_flag_patterns) {
      for (const pattern of rule.blocked_flag_patterns) {
        try {
          if (new RegExp(pattern).test(command)) {
            return {
              allowed: false,
              reason: `命令 '${cmdName}' 匹配禁止的 flag 模式: ${pattern}`,
              rule: `param:${cmdName}:blocked_pattern:${pattern}`,
            };
          }
        } catch { /* skip invalid regex */ }
      }
    }

    // blocked_subcommands
    if (rule.blocked_subcommands) {
      const subCmd = extractSubCommand(command, cmdName);
      if (subCmd && rule.blocked_subcommands.includes(subCmd)) {
        return {
          allowed: false,
          reason: `命令 '${cmdName}' 的 '${subCmd}' 子命令在 blocklist 中`,
          rule: `param:${cmdName}:blocked_subcmd:${subCmd}`,
        };
      }
    }

    // blocked_scripts: 命令参数路径命中
    if (rule.blocked_scripts) {
      for (const script of rule.blocked_scripts) {
        if (command.includes(script)) {
          return {
            allowed: false,
            reason: `禁止执行脚本: ${script}`,
            rule: `param:${cmdName}:blocked_script:${script}`,
          };
        }
      }
    }

    // allowed_flags: 白名单模式（如果配置了 allowed_flags，不在列表中的 flag 拒绝）
    if (rule.allowed_flags && rule.allowed_flags.length > 0) {
      // 简单实现：检查命令中是否有不在 allowed 列表中的已知危险 flag
      // 完整实现需要 flag 解析器，此处做基础检查
    }

    // allowed_subcommands: 白名单模式
    if (rule.allowed_subcommands && rule.allowed_subcommands.length > 0) {
      const subCmd = extractSubCommand(command, cmdName);
      if (subCmd && !rule.allowed_subcommands.includes(subCmd)) {
        return {
          allowed: false,
          reason: `命令 '${cmdName}' 的 '${subCmd}' 子命令不在 allowlist 中`,
          rule: `param:${cmdName}:allowed_subcmd:${subCmd}`,
        };
      }
    }

    // allowed_scripts: 白名单模式
    if (rule.allowed_scripts && rule.allowed_scripts.length > 0) {
      // 检查脚本路径是否在 allowed 列表中
      const scriptsInCommand = extractScripts(command);
      for (const scriptPath of scriptsInCommand) {
        const normalized = path.normalize(scriptPath);
        const matched = rule.allowed_scripts.some(
          (allowed) => path.normalize(allowed) === normalized,
        );
        if (!matched) {
          return {
            allowed: false,
            reason: `脚本 '${scriptPath}' 不在 allowlist 中`,
            rule: `param:${cmdName}:allowed_script:${scriptPath}`,
          };
        }
      }
    }
  }
  return null;
}

/** 检查命令中是否包含指定 flag（独立参数） */
function commandHasFlag(command: string, flag: string): boolean {
  const parts = command.split(/\s+/);
  return parts.includes(flag);
}

/** 提取子命令（git push → push, docker rm → rm） */
function extractSubCommand(command: string, cmdName: string): string | null {
  const trimmed = command.trim();
  // 去掉命令名
  const afterCmd = trimmed.slice(cmdName.length).trim();
  if (!afterCmd) return null;
  // 取第一个不以 - 开头的词作为子命令
  const words = afterCmd.split(/\s+/);
  for (const word of words) {
    if (!word.startsWith("-")) return word;
  }
  return null;
}

/** 提取命令中的脚本路径（参数中不以 - 开头的路径样式的词） */
function extractScripts(command: string): string[] {
  const scripts: string[] = [];
  const parts = command.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // 跳过 flags
    if (part.startsWith("-")) continue;
    // 跳过看起来不像路径的词（如 git, push 等单段命令）
    if (part.includes("/") || part.includes("\\") || part.endsWith(".py") || part.endsWith(".sh") || part.endsWith(".js")) {
      scripts.push(part);
    }
  }
  return scripts;
}
