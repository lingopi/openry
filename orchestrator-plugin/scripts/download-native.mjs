/**
 * download-native.mjs — 下载原生模块预编译二进制
 *
 * 支持 better-sqlite3 和 sharp 两个 native 模块。
 * 作为 install.ps1 / install.sh 和 npm postinstall 的通用入口。
 *
 * 用法: node scripts/download-native.mjs
 * 退出码: 0=全部成功, 1=部分失败
 */

import {
  createWriteStream, existsSync, mkdirSync,
  readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginDir = join(__dirname, "..");

const PLATFORM = process.platform;
const ARCH = process.arch;
const NODE_ABI = process.versions.modules;

const MIRRORS = [
  "",                              // direct GitHub first
  "https://ghfast.top/",          // fallback mirror
];

// ── 原生模块定义 ─────────────────────────────────────────────────

/**
 * 每个原生模块的描述。
 * hasLibvips: sharp 额外需要 libvips 完整 DLL 包
 */
const nativeModules = [
  {
    name: "better-sqlite3",
    repo: "WiseLibs/better-sqlite3",
    fileName: (ver) => `better-sqlite3-v${ver}-node-v${NODE_ABI}-${PLATFORM}-${ARCH}.tar.gz`,
    subDir: join("lib", "binding", `node-v${NODE_ABI}-${PLATFORM}-${ARCH}`),
  },
  {
    name: "sharp",
    repo: "lovell/sharp",
    fileName: (ver) => `sharp-v${ver}-napi-v7-${PLATFORM}-${ARCH}.tar.gz`,
    subDir: join("build", "Release"),
    // sharp also needs libvips DLLs from sharp-libvips repo
    libvips: {
      repo: "lovell/sharp-libvips",
      version: "8.14.5",
      fileName: `libvips-8.14.5-${PLATFORM}-${ARCH}.tar.br`,
      isBrotli: true,
    },
  },
];

// ── 获取版本 ─────────────────────────────────────────────────────

function getVersion(pkgName) {
  try {
    const p = join(pluginDir, "node_modules", pkgName, "package.json");
    return JSON.parse(readFileSync(p, "utf-8")).version;
  } catch {}
  return null;
}

// ── 下载 ─────────────────────────────────────────────────────────

function downloadFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const file = createWriteStream(destPath);
    const timer = setTimeout(() => {
      file.close(); try { rmSync(destPath, { force: true }); } catch {} reject(new Error("timeout"));
    }, 30_000);

    get(url, { headers: { "User-Agent": "node" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        clearTimeout(timer); file.close();
        const loc = res.headers.location;
        if (loc) return downloadFile(loc, destPath, redirects + 1).then(resolve, reject);
        return reject(new Error("redirect without location"));
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer); file.close();
        try { rmSync(destPath, { force: true }); } catch {} reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => { clearTimeout(timer); file.close(); resolve(); });
      file.on("error", (e) => { clearTimeout(timer); file.close(); try { rmSync(destPath, { force: true }); } catch {} reject(e); });
      res.on("error", (e) => { clearTimeout(timer); file.close(); try { rmSync(destPath, { force: true }); } catch {} reject(e); });
    }).on("error", (e) => {
      clearTimeout(timer); file.close();
      try { rmSync(destPath, { force: true }); } catch {} reject(e);
    });
  });
}

// ── 解压 ─────────────────────────────────────────────────────────

function extractTarGz(tarPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("tar", ["-xzf", tarPath, "-C", destDir], { stdio: "pipe", timeout: 15_000 });
  if (r.status !== 0) throw new Error(`tar: ${r.stderr?.toString().trim() || `exit ${r.status}`}`);
}

// ── 查找 .node ───────────────────────────────────────────────────

function findNodeFile(dir) {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isFile() && e.name.endsWith(".node")) return full;
      if (e.isDirectory()) { const f = findNodeFile(full); if (f) return f; }
    }
  } catch {}
  return null;
}

// ── 递归复制所有 DLL ────────────────────────────────────────────

function copyAllDlls(srcDir, destDir) {
  try {
    for (const e of readdirSync(srcDir, { withFileTypes: true })) {
      const full = join(srcDir, e.name);
      if (e.isFile() && (e.name.endsWith(".dll") || e.name.endsWith(".DLL"))) {
        copyFileSync(full, join(destDir, e.name));
      }
      if (e.isDirectory()) copyAllDlls(full, destDir);
    }
  } catch {}
}

function hasLibvipsDlls(dir) {
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // Match core libvips DLL (e.g. libvips-42.dll), not just cpp wrapper
      if (e.isFile() && /^libvips-\d+/.test(e.name)) return true;
    }
  } catch {}
  return false;
}

async function downloadLibvips(mod, targetDir, tmpDir) {
  const lv = mod.libvips;
  const lvBase = `https://github.com/${lv.repo}/releases/download/v${lv.version}/${lv.fileName}`;
  const lvTarPath = join(tmpDir, lv.fileName);

  for (const mirror of MIRRORS) {
    try {
      const lvUrl = mirror + lvBase;
      const label = mirror ? new URL(mirror).hostname : "github.com";
      console.log(`  libvips trying ${label} ...`);
      if (lv.isBrotli) {
        await downloadFile(lvUrl, lvTarPath);
        const { brotliDecompressSync } = await import("node:zlib");
        const tarData = brotliDecompressSync(readFileSync(lvTarPath));
        const rawTar = join(tmpDir, `lv-${mod.name}.tar`);
        writeFileSync(rawTar, tarData);
        const lvExtract = join(tmpDir, `lv-ext-${mod.name}`);
        extractTarGz(rawTar, lvExtract);
        copyAllDlls(lvExtract, targetDir);
      } else {
        await downloadFile(lvUrl, lvTarPath);
        const lvExtract = join(tmpDir, `lv-ext-${mod.name}`);
        extractTarGz(lvTarPath, lvExtract);
        copyAllDlls(lvExtract, targetDir);
      }
      console.log(`  ✓ libvips: installed`);
      return;
    } catch (err) {
      console.log(`  libvips ✗ ${err.message}`);
      try { rmSync(lvTarPath, { force: true }); } catch {}
    }
  }
}

// ── 单个模块处理 ─────────────────────────────────────────────────

async function handleModule(mod) {
  const version = getVersion(mod.name);
  if (!version) { console.log(`[download-native] ${mod.name}: not installed, skip`); return true; }

  const targetDir = join(pluginDir, "node_modules", mod.name, mod.subDir);
  const tmpDir = join(pluginDir, "node_modules", ".native-tmp");
  mkdirSync(tmpDir, { recursive: true });

  if (existsSync(targetDir) && findNodeFile(targetDir)) {
    console.log(`[download-native] ${mod.name}: binary OK`);

    // Check libvips separately (may have been nuked by npm install)
    if (mod.libvips && !hasLibvipsDlls(targetDir)) {
      console.log(`[download-native] ${mod.name}: libvips DLLs missing, downloading...`);
      await downloadLibvips(mod, targetDir, tmpDir);
    }

    return true;
  }

  console.log(`[download-native] ${mod.name}: downloading v${version} ...`);
  const fileName = mod.fileName(version);
  const base = `https://github.com/${mod.repo}/releases/download/v${version}/${fileName}`;
  const tarPath = join(tmpDir, fileName);

  for (const mirror of MIRRORS) {
    try {
      const url = mirror + base;
      const label = mirror ? new URL(mirror).hostname : "github.com";
      console.log(`  trying ${label} ...`);
      await downloadFile(url, tarPath);
      const extractDir = join(tmpDir, `ext-${mod.name}`);
      extractTarGz(tarPath, extractDir);
      const nodeFile = findNodeFile(extractDir);
      if (!nodeFile) throw new Error("no .node in archive");
      mkdirSync(targetDir, { recursive: true });

      // Copy ALL files from the extracted build/Release or lib/binding dir
      // (sharp includes libvips-cpp.dll alongside the .node file)
      const srcDir = nodeFile.split(/[/\\]/).slice(0, -1).join("/") || extractDir;
      try {
        for (const e of readdirSync(srcDir, { withFileTypes: true })) {
          if (e.isFile()) {
            copyFileSync(join(srcDir, e.name), join(targetDir, e.name));
          }
        }
      } catch {
        // fallback: just copy the .node file
        const destName = nodeFile.split(/[/\\]/).pop();
        copyFileSync(nodeFile, join(targetDir, destName));
      }
      console.log(`  ✓ ${mod.name}: installed`);

      // ── libvips extra download (sharp only) ──
      if (mod.libvips) {
        const lv = mod.libvips;
        const lvBase = `https://github.com/${lv.repo}/releases/download/v${lv.version}/${lv.fileName}`;
        const lvTarPath = join(tmpDir, lv.fileName);
        for (const mirror of MIRRORS) {
          try {
            const lvUrl = mirror + lvBase;
            const label = mirror ? new URL(mirror).hostname : "github.com";
            console.log(`  libvips trying ${label} ...`);
            if (lv.isBrotli) {
              // .tar.br → decompress brotli → untar
              await downloadFile(lvUrl, lvTarPath);
              const { brotliDecompressSync } = await import("node:zlib");
              const brData = readFileSync(lvTarPath);
              const tarData = brotliDecompressSync(brData);
              const rawTar = join(tmpDir, `libvips-${mod.name}.tar`);
              writeFileSync(rawTar, tarData);
              const lvExtract = join(tmpDir, `lv-ext-${mod.name}`);
              extractTarGz(rawTar, lvExtract);
              copyAllDlls(lvExtract, targetDir);
            } else {
              await downloadFile(lvUrl, lvTarPath);
              const lvExtract = join(tmpDir, `lv-ext-${mod.name}`);
              extractTarGz(lvTarPath, lvExtract);
              copyAllDlls(lvExtract, targetDir);
            }
            console.log(`  ✓ libvips: installed`);
            break;
          } catch (err) {
            console.log(`  libvips ✗ ${err.message}`);
            try { rmSync(lvTarPath, { force: true }); } catch {}
          }
        }
      }

      return true;
    } catch (err) {
      console.log(`  ✗ ${err.message}`);
      try { rmSync(tarPath, { force: true }); } catch {}
      try { rmSync(join(tmpDir, `ext-${mod.name}`), { recursive: true, force: true }); } catch {}
    }
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  return false;
}

// ── 主流程 ───────────────────────────────────────────────────────

async function main() {
  let failed = false;
  for (const mod of nativeModules) {
    if (!(await handleModule(mod))) failed = true;
  }
  if (failed) {
    console.error(`
╔══════════════════════════════════════════════════════╗
║  Some native modules could not be downloaded.       ║
║  Options:                                           ║
║    1. Use VPN to access GitHub                      ║
║    2. Install VS Build Tools, then:                 ║
║       npm rebuild better-sqlite3 sharp              ║
╚══════════════════════════════════════════════════════╝
`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
