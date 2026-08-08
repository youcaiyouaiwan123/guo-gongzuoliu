"use client";

import { useRef, useState } from "react";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|jpg|webp)$/i;

export interface SourcePasteZoneProps {
  /** 当前粘贴数据；受控，截图识别结果要回填到这里 */
  value: string;
  onChange: (value: string) => void;
  /** 数据来源类型，决定是"主入口"还是"可选补充" */
  kind: string;
  /** 采集任务名，仅用于审计标记 */
  taskName?: string;
  modelMode?: string;
  setNotice: (message: string) => void;
}

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

/**
 * 采集任务的数据粘贴区。
 *
 * 改版前这里只是长表单中间的一个普通 textarea：选了"图片/截图"或"文本/粘贴"，
 * 用户仍要往下翻才能找到它，而且截图只能自己先 OCR 再粘文字，图片无处可放。
 * 现在按数据来源把它提为主入口，并直接支持贴图 → 视觉模型识别 → 回填文字。
 */
export default function SourcePasteZone({ value, onChange, kind, taskName, modelMode, setNotice }: SourcePasteZoneProps) {
  const [images, setImages] = useState<Array<{ id: string; name: string; dataUrl: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const seed = useRef(0);

  const isScreenshot = kind === "图片/截图";
  const isPrimary = ["图片/截图", "文本/粘贴", "MCP"].includes(kind);
  const title = isScreenshot ? "把截图贴到这里" : kind === "MCP" ? "把 MCP 返回结果贴到这里" : "把数据贴到这里";

  async function addFiles(files: File[]) {
    const pictures = files.filter(file => IMAGE_TYPES.test(file.type));
    if (!pictures.length) return false;
    if (!isScreenshot) {
      setNotice("要识别截图，请先把“数据来源”改成“图片/截图”。");
      return true;
    }
    const room = MAX_IMAGES - images.length;
    if (room <= 0) return setNotice(`一次最多 ${MAX_IMAGES} 张截图，请先识别或移除已有截图。`), true;
    const accepted: Array<{ id: string; name: string; dataUrl: string }> = [];
    for (const file of pictures.slice(0, room)) {
      if (file.size > MAX_IMAGE_BYTES) {
        setNotice(`${file.name || "截图"} 超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，请裁剪后再试。`);
        continue;
      }
      try {
        seed.current += 1;
        accepted.push({ id: `img-${seed.current}`, name: file.name || `截图${seed.current}`, dataUrl: await readAsDataUrl(file) });
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "截图读取失败");
      }
    }
    if (accepted.length) {
      setImages(current => [...current, ...accepted]);
      setNotice(`已添加 ${accepted.length} 张截图，点击“识别为文字”提取内容。`);
    }
    if (pictures.length > room) setNotice(`一次最多 ${MAX_IMAGES} 张截图，多余的已忽略。`);
    return true;
  }

  async function handlePaste(event: React.ClipboardEvent) {
    const files = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === "file")
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file);
    // 只有确实粘的是图片时才拦截默认行为，粘文本仍然直接落进文本框。
    if (files.length && await addFiles(files)) event.preventDefault();
  }

  async function recognize() {
    if (!images.length) return setNotice("请先选择或粘贴截图。");
    setBusy(true);
    try {
      const response = await fetch("/api/modules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "screenshot-ocr",
          images: images.map(item => item.dataUrl),
          name: taskName,
          modelMode: modelMode || "auto",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "截图识别失败");
      // 追加而不是覆盖：多张截图可以分批识别累加，也不会冲掉用户手打的内容。
      onChange(value.trim() ? `${value.trim()}\n\n${data.text}` : data.text);
      setImages([]);
      setNotice("截图已识别为文字，请核对后再保存；系统只保存文字，不保存图片原件。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "截图识别失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`sourcePasteZone ${isPrimary ? "primary" : ""} ${dragging ? "dragging" : ""}`}>
      <div className="sourcePasteHead">
        <div>
          <b>{title}</b>
          <small>
            {isScreenshot
              ? "支持 Ctrl+V 贴图、拖入图片或选择文件；识别后只保存文字，不保存图片原件。"
              : "支持直接粘贴 CSV、JSON、Excel 复制的表格或平台导出文本。"}
          </small>
        </div>
        <div className="sourcePasteMeta">
          <span>{value.length} 字</span>
          {!!value && <button type="button" onClick={() => onChange("")}>清空</button>}
        </div>
      </div>

      {isScreenshot && (
        <div
          className="screenshotDrop"
          onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files || [])); }}
        >
          {images.length ? (
            <div className="screenshotThumbs">
              {images.map(item => (
                <figure key={item.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.dataUrl} alt={item.name} />
                  <button type="button" disabled={busy} onClick={() => setImages(current => current.filter(image => image.id !== item.id))}>移除</button>
                </figure>
              ))}
            </div>
          ) : (
            <p>把截图拖到这里，或在下面的输入框里按 Ctrl+V 粘贴</p>
          )}
          <div className="screenshotActions">
            <label className="screenshotPick">
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} onChange={event => { void addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
              选择截图
            </label>
            <button type="button" disabled={busy || !images.length} onClick={recognize}>
              {busy ? "识别中…" : `识别为文字（${images.length}）`}
            </button>
          </div>
        </div>
      )}

      <textarea
        name="sampleData"
        rows={isPrimary ? 12 : 5}
        value={value}
        onChange={event => onChange(event.target.value)}
        onPaste={handlePaste}
        placeholder={isScreenshot
          ? "截图识别后的文字会自动填到这里，也可以直接粘贴已有的表格文本。"
          : "CSV示例：\nname,amount,date\n客户A,12000,2026-07-24\n\nJSON、制表符分隔的 Excel 内容同样可以直接粘贴。"}
      />
      <small className="sourcePasteFoot">采集任务只保存这里的文字内容；遇到登录、403、验证码或反爬时，改用授权 API、MCP、平台导出或直接粘贴结果。</small>
      <small className="sourcePasteFoot">这里贴的内容<b>会由 AI 整理后再入库</b>，并留下一条运行记录。只是想原样存一段文字的话，用「企业知识 → 直接创建文本」或「我的知识库 → 新建个人知识」更直接，那两处默认原文保存、也可以勾选 AI 整理。</small>
    </div>
  );
}
