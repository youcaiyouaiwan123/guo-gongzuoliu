// 按大小轮转的日志写入器。无外部依赖（Windows 上没有 logrotate）。
// 每个服务两路：<name>.log（stdout）与 <name>.err（stderr）。单文件超过 maxBytes
// 就滚动为 <name>.log.1 … .<keep>，最旧的丢弃。
import fs from "node:fs";
import path from "node:path";

export class RotatingLog {
  constructor(file, { maxBytes = 10 * 1024 * 1024, keep = 5 } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this._open();
  }

  _open() {
    this.stream = fs.createWriteStream(this.file, { flags: "a" });
    try {
      this.size = fs.statSync(this.file).size;
    } catch {
      this.size = 0;
    }
  }

  _rotate() {
    try {
      this.stream.close();
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // 轮转失败不该拖垮进程，继续追加即可。
    }
    this._open();
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (this.size + buf.length > this.maxBytes) this._rotate();
    this.size += buf.length;
    this.stream.write(buf);
  }

  // 供守护自身写带时间戳的运行日志。
  line(text) {
    const stamp = new Date().toISOString();
    this.write(`[${stamp}] ${text}\n`);
  }
}
