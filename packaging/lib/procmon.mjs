// 跨平台进程采样：给定根 pid，找出其全部后代（含 wrangler 另起的 workerd 子进程）并累加 RSS。
// 用于守护对 app 层做「内存溢出」保护——workerd 是独立进程，Node 的 --max-old-space-size 管不到它。
import { execFileSync } from "node:child_process";

// 返回 [{ pid, ppid, rss }]，rss 单位统一为字节。
export function listProcesses() {
  if (process.platform === "win32") return listWindows();
  return listPosix();
}

function listPosix() {
  // ps 的 rss 单位是 KiB（Linux/macOS 一致）。
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], rss: +m[3] * 1024 });
  }
  return rows;
}

function listWindows() {
  // WorkingSetSize 单位是字节。避开已废弃的 wmic，用 CIM。
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)\" }";
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 15_000 },
  );
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], rss: +m[3] });
  }
  return rows;
}

// 累加 rootPid 及其所有后代的 RSS（字节）。找不到任何进程返回 0。
export function sampleTreeRss(rootPid, rows = listProcesses()) {
  return descendantsAndSelf(rootPid, rows).reduce((sum, r) => sum + r.rss, 0);
}

// 返回 rootPid 及其所有后代的进程记录（含自身）。用于跨平台整树杀进程。
export function descendantsAndSelf(rootPid, rows = listProcesses()) {
  const byParent = new Map();
  const byPid = new Map();
  for (const r of rows) {
    byPid.set(r.pid, r);
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r.pid);
  }
  const result = [];
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = byPid.get(pid);
    if (self) result.push(self);
    for (const child of byParent.get(pid) || []) stack.push(child);
  }
  return result;
}
