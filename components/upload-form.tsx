"use client";

import { FormEvent, useRef, useState, useTransition } from "react";

type PairSummary = {
  number: number;
  zhTitle: string;
  enTitle: string;
  zhParagraphs: number;
  enParagraphs: number;
};

type BuildResponse = {
  jobId: string;
  bookUrl: string;
  reportUrl: string;
  totalSections: number;
  pairs: PairSummary[];
};

type TextAppearance = {
  fontSize: string;
  lineHeight: string;
  color: string;
};

type PreviewTheme = {
  zh: TextAppearance;
  en: TextAppearance;
};

type FieldLabelProps = {
  text: string;
  tooltip?: string;
};

const defaultTheme: PreviewTheme = {
  zh: {
    fontSize: "1.06",
    lineHeight: "1.82",
    color: "#1f2937"
  },
  en: {
    fontSize: "0.98",
    lineHeight: "1.70",
    color: "#0f172a"
  }
};

const previewCopy = {
  title: "Chapter One / 第一章",
  en: "He paused at the edge of the harbor, listening to the ropes knock softly against the mast while the city woke behind him.",
  zh: "他停在港口边缘，听着缆绳轻轻敲打桅杆的声音，身后的城市也正慢慢醒来。"
};

function previewTextStyle(appearance: TextAppearance) {
  return {
    color: appearance.color,
    fontSize: `${appearance.fontSize}rem`,
    lineHeight: appearance.lineHeight
  };
}

function FieldLabel({ text, tooltip }: FieldLabelProps) {
  return (
    <span className="field-label">
      <span>{text}</span>
      {tooltip ? (
        <span className="tooltip">
          <button type="button" className="tooltip-trigger" aria-label={`${text}说明`}>
            ?
          </button>
          <span className="tooltip-bubble" role="tooltip">
            {tooltip}
          </span>
        </span>
      ) : null}
    </span>
  );
}

type StyleRowProps = {
  label: string;
  name: string;
  value: string;
  min: string;
  max: string;
  step: string;
  suffix: string;
  onChange: (value: string) => void;
};

function StyleRow({ label, name, value, min, max, step, suffix, onChange }: StyleRowProps) {
  return (
    <label className="style-row">
      <FieldLabel text={label} />
      <div className="range-row">
        <input
          name={name}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <span className="range-value">
          {value}
          {suffix}
        </span>
      </div>
    </label>
  );
}

export default function UploadForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<BuildResponse | null>(null);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const [order, setOrder] = useState<"en-first" | "zh-first">("en-first");
  const [theme, setTheme] = useState<PreviewTheme>(defaultTheme);

  function updateTheme(section: "zh" | "en", key: string, value: string) {
    setTheme((current) => {
      return {
        ...current,
        [section]: {
          ...current[section],
          [key]: value
        }
      };
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setError("");
    setResult(null);

    startTransition(async () => {
      try {
        const response = await fetch("/api/build", {
          method: "POST",
          body: formData
        });
        const data = (await response.json()) as BuildResponse | { error?: string };
        if (!response.ok) {
          throw new Error("error" in data && data.error ? data.error : "合成失败");
        }
        setResult(data as BuildResponse);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "合成失败");
      }
    });
  }

  function resetForm() {
    formRef.current?.reset();
    setResult(null);
    setError("");
    setOrder("en-first");
    setTheme(defaultTheme);
  }

  return (
    <div className="tool-grid">
      <form ref={formRef} className="upload-panel" onSubmit={handleSubmit}>
        <div className="field-grid">
          <label>
            <FieldLabel text="中文 EPUB" />
            <input name="zhFile" type="file" accept=".epub,application/epub+zip" required />
          </label>
          <label>
            <FieldLabel text="英文 EPUB" />
            <input name="enFile" type="file" accept=".epub,application/epub+zip" required />
          </label>
        </div>

        <label>
          <FieldLabel text="书名" tooltip="用于 EPUB 内部的封面、标题页和书籍元数据，不直接决定下载文件名。" />
          <input name="title" placeholder="中英对照电子书" />
        </label>

        <label>
          <FieldLabel text="作者" />
          <input name="author" placeholder="可留空" />
        </label>

        <div className="field-grid">
          <label>
            <FieldLabel text="对照顺序" />
            <select
              name="order"
              value={order}
              onChange={(event) => setOrder(event.currentTarget.value === "zh-first" ? "zh-first" : "en-first")}
            >
              <option value="en-first">英文在上，中文在下</option>
              <option value="zh-first">中文在上，英文在下</option>
            </select>
          </label>
          <label>
            <FieldLabel text="正文识别阈值" />
            <input name="minParagraphs" type="number" min="1" max="50" defaultValue="3" />
          </label>
        </div>

        <label>
          <FieldLabel text="输出文件名" tooltip="只影响导出的文件名；留空时会自动使用书名.epub。" />
          <input name="outputName" placeholder="bilingual.epub" />
        </label>

        <section className="style-panel" aria-labelledby="style-panel-title">
          <div className="style-panel-header">
            <div>
              <p className="eyebrow">Style Lab</p>
              <h2 id="style-panel-title">样式配置</h2>
            </div>
            <p className="hint">支持先调中英文的字号、颜色、行高，再预览一段效果后导出。</p>
          </div>

          <div className="style-workbench">
            <div className="style-columns">
              <div className="style-card">
                <h3>英文样式</h3>
                <StyleRow
                  label="字号"
                  name="enFontSize"
                  value={theme.en.fontSize}
                  min="0.8"
                  max="1.6"
                  step="0.02"
                  suffix="rem"
                  onChange={(value) => updateTheme("en", "fontSize", value)}
                />
                <StyleRow
                  label="行高"
                  name="enLineHeight"
                  value={theme.en.lineHeight}
                  min="1.2"
                  max="2.4"
                  step="0.02"
                  suffix=""
                  onChange={(value) => updateTheme("en", "lineHeight", value)}
                />
                <label className="style-row">
                  <FieldLabel text="颜色" />
                  <div className="color-row">
                    <input
                      name="enColor"
                      type="color"
                      value={theme.en.color}
                      onChange={(event) => updateTheme("en", "color", event.currentTarget.value)}
                    />
                    <span className="color-code">{theme.en.color}</span>
                  </div>
                </label>
              </div>

              <div className="style-card">
                <h3>中文样式</h3>
                <StyleRow
                  label="字号"
                  name="zhFontSize"
                  value={theme.zh.fontSize}
                  min="0.8"
                  max="1.6"
                  step="0.02"
                  suffix="rem"
                  onChange={(value) => updateTheme("zh", "fontSize", value)}
                />
                <StyleRow
                  label="行高"
                  name="zhLineHeight"
                  value={theme.zh.lineHeight}
                  min="1.2"
                  max="2.4"
                  step="0.02"
                  suffix=""
                  onChange={(value) => updateTheme("zh", "lineHeight", value)}
                />
                <label className="style-row">
                  <FieldLabel text="颜色" />
                  <div className="color-row">
                    <input
                      name="zhColor"
                      type="color"
                      value={theme.zh.color}
                      onChange={(event) => updateTheme("zh", "color", event.currentTarget.value)}
                    />
                    <span className="color-code">{theme.zh.color}</span>
                  </div>
                </label>
              </div>
            </div>

            <div className="preview-card">
              <div>
                <p className="eyebrow">Live Preview</p>
                <h2>样式预览</h2>
              </div>

              <article
                className="preview-book"
              >
                <h3>{previewCopy.title}</h3>
                <div className="preview-pair">
                  {order === "zh-first" ? (
                    <>
                      <p className="preview-zh" style={previewTextStyle(theme.zh)}>
                        {previewCopy.zh}
                      </p>
                      <p className="preview-en" style={previewTextStyle(theme.en)}>
                        {previewCopy.en}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="preview-en" style={previewTextStyle(theme.en)}>
                        {previewCopy.en}
                      </p>
                      <p className="preview-zh" style={previewTextStyle(theme.zh)}>
                        {previewCopy.zh}
                      </p>
                    </>
                  )}
                </div>
              </article>
            </div>
          </div>
        </section>

        <p className="hint">优先使用 EPUB 目录识别章节；没有目录时，按 spine 中的正文段落自动识别。</p>

        {error ? <p className="message error-message">{error}</p> : null}

        <div className="actions">
          <button type="submit" disabled={isPending}>
            {isPending ? "正在合成..." : "开始合成"}
          </button>
          <button type="button" className="secondary-button" onClick={resetForm} disabled={isPending}>
            清空
          </button>
        </div>
      </form>

      <section className="result-panel" aria-live="polite">
        {result ? (
          <>
            <div>
              <p className="eyebrow">Build Complete</p>
              <h2>合成完成</h2>
              <p className="hint">共合成 {result.totalSections} 个章节单元。</p>
            </div>
            <div className="actions">
              <a className="button-link" href={result.bookUrl}>
                下载 EPUB
              </a>
              <a className="button-link secondary-link" href={result.reportUrl}>
                下载对齐报告
              </a>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>中文</th>
                    <th>英文</th>
                    <th>中文段落</th>
                    <th>英文段落</th>
                  </tr>
                </thead>
                <tbody>
                  {result.pairs.map((pair) => (
                    <tr key={pair.number}>
                      <td>{pair.number}</td>
                      <td>{pair.zhTitle}</td>
                      <td>{pair.enTitle}</td>
                      <td>{pair.zhParagraphs}</td>
                      <td>{pair.enParagraphs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div>
            <p className="eyebrow">Ready</p>
            <h2>等待上传</h2>
            <p className="hint">合成后会在这里显示下载链接和章节对齐预览。</p>
          </div>
        )}
      </section>
    </div>
  );
}
