# 双语 EPUB 合成器

这是一个本地 Next.js 应用，用于上传一本中文 EPUB 和一本英文 EPUB，并生成中英对照 EPUB。

## 运行

```bash
npm install
npm run dev
```

打开：

```text
http://localhost:3000
```

## 功能

- 上传中文 EPUB 和英文 EPUB
- 自动读取 OPF/NCX/EPUB3 nav 目录
- 按章节和段落做长度辅助对齐
- 支持“英文在上，中文在下”或“中文在上，英文在下”
- 下载合成后的 EPUB 和 TSV 对齐报告

目前只支持 EPUB。PDF、MOBI、AZW3 建议先用 Calibre 转成 EPUB。
