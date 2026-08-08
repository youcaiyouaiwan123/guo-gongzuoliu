// 共享 CSV/TSV 解析：数据采集与监控报表两处都要读平台导出文件，
// 各自维护一份解析器会出现"同一个文件在采集里能解析、在监控里解析不出"的怪现象。
//
// 覆盖真实导出文件里的常见形态：
// - 分隔符可能是逗号、制表符、分号（Excel 在部分区域设置下默认导出分号）
// - 首列可能带 UTF-8 BOM
// - 单元格内可能有转义引号（""）和引号包裹的换行
// - 行尾可能是 \r\n

export const CSV_SEPARATORS = [",", "\t", ";"] as const;

export function stripBom(value: string) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** 按首行里出现次数最多的候选分隔符判定，全都没有时回退逗号 */
export function detectSeparator(headerLine: string) {
  let best: string = ",";
  let bestCount = 0;
  for (const separator of CSV_SEPARATORS) {
    const count = headerLine.split(separator).length - 1;
    if (count > bestCount) {
      best = separator;
      bestCount = count;
    }
  }
  return best;
}

/** 拆分单行；引号内的分隔符不生效，"" 表示一个字面量引号 */
export function splitCsvLine(line: string, separator = ",") {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === separator && !quoted) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * 按物理行切分，但把引号内的换行并回同一条记录。
 * 导出文件里的备注、地址字段经常带换行，逐行 split 会把一条记录拆成几条脏数据。
 */
export function splitCsvRecords(text: string) {
  const records: string[] = [];
  let current = "";
  let quoted = false;
  const normalized = stripBom(text).replace(/\r\n?/g, "\n");
  for (const char of normalized) {
    if (char === '"') quoted = !quoted;
    if (char === "\n" && !quoted) {
      records.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  records.push(current);
  return records.filter(record => record.trim().length > 0);
}

/** 解析为对象数组；表头缺失的列用列序号占位，避免整列数据丢失 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const records = splitCsvRecords(text);
  if (!records.length) return [];
  const separator = detectSeparator(records[0]);
  const headers = splitCsvLine(records[0], separator).map((header, index) => header || `列${index + 1}`);
  return records.slice(1).map(record => {
    const values = splitCsvLine(record, separator);
    return Object.fromEntries(headers.map((key, index) => [key, values[index] ?? ""]));
  });
}

/**
 * 内容嗅探：没有可信 content-type 时判断这段文本是不是表格。
 * 要求首行有分隔符，且后续多数行的列数与首行一致——只看首行会把普通含逗号的句子误判成 CSV。
 */
export function looksLikeCsv(text: string) {
  const records = splitCsvRecords(text).slice(0, 20);
  if (records.length < 2) return false;
  const separator = detectSeparator(records[0]);
  const columns = splitCsvLine(records[0], separator).length;
  if (columns < 2) return false;
  const matched = records.slice(1).filter(record => splitCsvLine(record, separator).length === columns).length;
  return matched >= Math.ceil((records.length - 1) * 0.6);
}
