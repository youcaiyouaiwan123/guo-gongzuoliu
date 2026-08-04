// 数据库结构工具。
// SQLite 的 ALTER TABLE ADD COLUMN 在列已存在时会报 "duplicate column name"，
// 这是补列操作的正常幂等结果，可以忽略；但表不存在、语法错误、磁盘故障等必须暴露出来。
// 此前各路由统一写作 .catch(() => undefined)，把所有错误一并吞掉，
// 导致补列失败后续查询引用该列时再次报错，又被上层的空 catch 变成“没有数据”。
export async function ensureColumn(db: D1Database, table: string, column: string, definition: string) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("duplicate column")) throw error;
  }
}
