// 智能助手·主动制「持续任务」把选中的知识库文件接入的契约测试。
// 需求：在「数据源（可选）」处可勾选企业/个人知识库具体文件，创建时编译成一个
// knowledgePick="files" 的 knowledge 节点（复用已上线的后端 files 检索与权限校验），
// 编辑回填时能从 loop-knowledge 节点反解回 continuous.knowledgeDocs。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const console_ = await readFile(new URL("../app/Console.tsx", import.meta.url), "utf8");

test("continuous state 带 knowledgeDocs: string[]", () => {
  assert.match(console_, /knowledgeDocs: \[\] as string\[\]/, "continuous 初始 state 必须含 knowledgeDocs。");
});

test("数据源（可选）处渲染企业/个人知识库分组勾选清单（前缀 id + 全选/清空）", () => {
  assert.match(console_, /continuousKnowledgePick/, "缺持续任务知识选择器容器。");
  assert.match(console_, /知识库文件（可选）/, "缺“知识库文件（可选）”标题。");
  assert.match(console_, /continuous\.knowledgeDocs\.includes\(`e:\$\{d\.id\}`\)/, "企业文件复选框必须用 e: 前缀 id 且绑 continuous.knowledgeDocs。");
  assert.match(console_, /continuous\.knowledgeDocs\.includes\(`p:\$\{p\.id\}`\)/, "个人文件复选框必须用 p: 前缀 id 且绑 continuous.knowledgeDocs。");
});

test("创建持续任务时按 knowledgeDocs 编译出 files 模式的 knowledge 节点", () => {
  assert.match(
    console_,
    /continuous\.knowledgeDocs\.length[\s\S]{0,160}id: "loop-knowledge", type: "knowledge"[\s\S]{0,80}knowledgePick: "files", knowledgeDocs: continuous\.knowledgeDocs/,
    "选了知识文件时必须插入 knowledgePick=files 的 loop-knowledge 节点（复用后端 files 检索/权限）。",
  );
});

test("编辑持续任务时从 loop-knowledge 节点反解回 knowledgeDocs", () => {
  assert.match(console_, /find\(n => n\.id === "loop-knowledge"\)/, "编辑回填必须定位 loop-knowledge 节点。");
  assert.match(console_, /knowledgeDocs = Array\.isArray\(knowledgeNode\?\.knowledgeDocs\) \? knowledgeNode!\.knowledgeDocs : \[\]/, "必须把 loop-knowledge.knowledgeDocs 反解回 continuous。");
});
