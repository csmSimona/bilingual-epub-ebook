import { Parser as HtmlParser } from "htmlparser2";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ParagraphOrder = "en-first" | "zh-first";

export type TextAppearance = {
  fontSizeRem: number;
  lineHeight: number;
  color: string;
};

export type ThemeOptions = {
  zh: TextAppearance;
  en: TextAppearance;
};

export type BuildOptions = {
  title: string;
  author: string;
  order: ParagraphOrder;
  minParagraphs: number;
  theme: ThemeOptions;
};

type ManifestItem = {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
};

type TocItem = {
  label: string;
  href: string;
};

type Section = {
  index: number;
  href: string;
  title: string;
  paragraphs: string[];
};

type EpubBook = {
  originalName: string;
  title: string;
  creator: string;
  language: string;
  sections: Section[];
  sectionsByHref: Map<string, Section>;
  tocItems: TocItem[];
  coverHref: string | null;
  coverMediaType: string | null;
  zip: JSZip;
};

type SectionPair = {
  number: number;
  zh: Section | null;
  en: Section | null;
};

type AlignmentGroup = {
  zh: string[];
  en: string[];
};

export type PairSummary = {
  number: number;
  zhTitle: string;
  enTitle: string;
  zhParagraphs: number;
  enParagraphs: number;
};

export type BuildResult = {
  book: Buffer;
  report: string;
  pairs: PairSummary[];
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  trimValues: false
});

const chapterPatterns = [
  /\bchapter\b/i,
  /\bchap\.?\b/i,
  /^\s*第.+[章节回卷部]\s*$/,
  /^\s*(chapter\s*)?[ivxlcdm\d]+\.?\s*$/i
];

const frontBackPattern =
  /cover|title page|copyright|contents|table of contents|toc|dedication|acknowledg|about the author|about author|other titles|also by|notes|appendix|封面|版权|目录|目錄|扉页|扉頁|献词|獻詞|致谢|致謝|关于作者|關於作者|其他作品|注释|註釋|附录|附錄/i;

export async function buildBilingualEpub(zhBuffer: Buffer, enBuffer: Buffer, options: BuildOptions): Promise<BuildResult> {
  const [zhBook, enBook] = await Promise.all([
    loadEpub(zhBuffer, "中文 EPUB"),
    loadEpub(enBuffer, "English EPUB")
  ]);

  const zhSections = selectSections(zhBook, options.minParagraphs);
  const enSections = selectSections(enBook, options.minParagraphs);
  if (zhSections.length === 0) {
    throw new Error("中文 EPUB 没有识别出可合成的正文段落");
  }
  if (enSections.length === 0) {
    throw new Error("英文 EPUB 没有识别出可合成的正文段落");
  }

  const sectionPairs = alignSections(zhSections, enSections);
  const aligned = sectionPairs.map((pair) => {
    const zhParagraphs = pair.zh?.paragraphs ?? [];
    const enParagraphs = pair.en?.paragraphs ?? [];
    return { pair, groups: alignParagraphs(zhParagraphs, enParagraphs) };
  });

  const report = renderReport(aligned);
  const cover = await readCover(zhBook);
  const fallbackCover = cover.bytes ? cover : await readCover(enBook);
  const coverPath = fallbackCover.mediaType ? `Images/cover.${coverExtension(fallbackCover.mediaType)}` : null;

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", renderContainer());
  zip.file("OEBPS/Styles/style.css", renderStyle(options.theme));
  if (fallbackCover.bytes && coverPath) {
    zip.file(`OEBPS/${coverPath}`, fallbackCover.bytes);
  }
  zip.file("OEBPS/Text/cover.xhtml", renderCover(options.title, coverPath));
  zip.file("OEBPS/Text/title.xhtml", renderTitlePage(options, zhBook, enBook, sectionPairs));
  for (const item of aligned) {
    zip.file(`OEBPS/${chapterFilename(item.pair.number)}`, renderChapter(item.pair, item.groups, options.order));
  }

  const bookId = randomUUID();
  zip.file("OEBPS/content.opf", renderOpf(bookId, options, sectionPairs, coverPath, fallbackCover.mediaType));
  zip.file("OEBPS/toc.ncx", renderNcx(bookId, options.title, sectionPairs));

  const book = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType: "application/epub+zip"
  });

  validateGeneratedEpub(book);

  return {
    book,
    report,
    pairs: sectionPairs.map((pair) => ({
      number: pair.number,
      zhTitle: pair.zh?.title ?? "",
      enTitle: pair.en?.title ?? "",
      zhParagraphs: pair.zh?.paragraphs.length ?? 0,
      enParagraphs: pair.en?.paragraphs.length ?? 0
    }))
  };
}

async function loadEpub(buffer: Buffer, originalName: string): Promise<EpubBook> {
  const zip = await JSZip.loadAsync(buffer);
  const opfPath = await parseContainer(zip);
  const opfText = await readZipText(zip, opfPath);
  const opf = xmlParser.parse(opfText);
  const pkg = opf.package;
  if (!pkg?.manifest || !pkg?.spine) {
    throw new Error(`${originalName} 的 OPF 缺少 manifest 或 spine`);
  }

  const manifest = parseManifest(pkg.manifest);
  const spine = parseSpine(pkg.spine);
  const title = metadataText(pkg.metadata, "title") || originalName;
  const creator = metadataText(pkg.metadata, "creator");
  const language = metadataText(pkg.metadata, "language");
  const cover = findCover(pkg.metadata, manifest, opfPath);
  const tocItems = await readToc(zip, manifest, opfPath, pkg.spine?.toc);
  const tocTitlesByHref = new Map<string, string>();
  for (const item of tocItems) {
    if (!tocTitlesByHref.has(item.href)) {
      tocTitlesByHref.set(item.href, item.label);
    }
  }

  const sections: Section[] = [];
  for (const itemRef of spine) {
    const item = manifest.get(itemRef);
    if (!item || !["application/xhtml+xml", "text/html"].includes(item.mediaType)) {
      continue;
    }
    const href = zipJoin(opfPath, item.href);
    const file = zip.file(href);
    if (!file) {
      continue;
    }
    const source = await file.async("string");
    const blocks = parseBlocks(source);
    const titleForSection = tocTitlesByHref.get(href) || blocks.headings[0] || blocks.title || path.posix.basename(href);
    sections.push({
      index: sections.length + 1,
      href,
      title: titleForSection,
      paragraphs: blocks.paragraphs
    });
  }

  if (sections.length === 0) {
    throw new Error(`${originalName} 没有可读取的 XHTML 正文`);
  }

  return {
    originalName,
    title,
    creator,
    language,
    sections,
    sectionsByHref: new Map(sections.map((section) => [section.href, section])),
    tocItems,
    coverHref: cover.href,
    coverMediaType: cover.mediaType,
    zip
  };
}

async function parseContainer(zip: JSZip): Promise<string> {
  const text = await readZipText(zip, "META-INF/container.xml");
  const container = xmlParser.parse(text);
  const rootFile = first(container.container?.rootfiles?.rootfile);
  const opfPath = stringAttr(rootFile, "full-path");
  if (!opfPath) {
    throw new Error("EPUB container.xml 中没有 rootfile");
  }
  return opfPath;
}

function parseManifest(manifestNode: unknown): Map<string, ManifestItem> {
  const items = new Map<string, ManifestItem>();
  for (const raw of asArray(objectAt(manifestNode, "item"))) {
    const id = stringAttr(raw, "id");
    const href = stringAttr(raw, "href");
    if (!id || !href) {
      continue;
    }
    items.set(id, {
      id,
      href,
      mediaType: stringAttr(raw, "media-type"),
      properties: stringAttr(raw, "properties")
    });
  }
  return items;
}

function parseSpine(spineNode: unknown): string[] {
  return asArray(objectAt(spineNode, "itemref"))
    .map((item) => stringAttr(item, "idref"))
    .filter(Boolean);
}

function metadataText(metadata: unknown, key: string): string {
  const value = objectAt(metadata, key);
  if (Array.isArray(value)) {
    return normalizeText(textValue(value[0]));
  }
  return normalizeText(textValue(value));
}

function findCover(metadata: unknown, manifest: Map<string, ManifestItem>, opfPath: string): { href: string | null; mediaType: string | null } {
  const metas = asArray(objectAt(metadata, "meta"));
  for (const meta of metas) {
    if (stringAttr(meta, "name") === "cover") {
      const id = stringAttr(meta, "content");
      const item = manifest.get(id);
      if (item) {
        return {
          href: zipJoin(opfPath, item.href),
          mediaType: item.mediaType
        };
      }
    }
  }

  for (const item of manifest.values()) {
    const haystack = `${item.id} ${item.href}`.toLowerCase();
    if (item.mediaType.startsWith("image/") && haystack.includes("cover")) {
      return {
        href: zipJoin(opfPath, item.href),
        mediaType: item.mediaType
      };
    }
  }
  return { href: null, mediaType: null };
}

async function readToc(zip: JSZip, manifest: Map<string, ManifestItem>, opfPath: string, ncxId: unknown): Promise<TocItem[]> {
  const ncxItem = typeof ncxId === "string" ? manifest.get(ncxId) : undefined;
  if (ncxItem) {
    const ncxPath = zipJoin(opfPath, ncxItem.href);
    const toc = await parseNcx(zip, ncxPath);
    if (toc.length > 0) {
      return toc;
    }
  }

  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes("nav")) {
      const navPath = zipJoin(opfPath, item.href);
      const toc = await parseEpub3Nav(zip, navPath);
      if (toc.length > 0) {
        return toc;
      }
    }
  }
  return [];
}

async function parseNcx(zip: JSZip, ncxPath: string): Promise<TocItem[]> {
  const file = zip.file(ncxPath);
  if (!file) {
    return [];
  }
  try {
    const ncx = xmlParser.parse(await file.async("string"));
    const items: TocItem[] = [];
    collectNavPoints(asArray(ncx.ncx?.navMap?.navPoint), ncxPath, items);
    return items;
  } catch {
    return [];
  }
}

function collectNavPoints(points: unknown[], basePath: string, out: TocItem[]): void {
  for (const point of points) {
    const label = normalizeText(textValue(objectAt(objectAt(point, "navLabel"), "text")));
    const src = stringAttr(objectAt(point, "content"), "src");
    if (label && src) {
      out.push({ label, href: zipJoin(basePath, src) });
    }
    collectNavPoints(asArray(objectAt(point, "navPoint")), basePath, out);
  }
}

async function parseEpub3Nav(zip: JSZip, navPath: string): Promise<TocItem[]> {
  const file = zip.file(navPath);
  if (!file) {
    return [];
  }
  const links: TocItem[] = [];
  let href: string | null = null;
  let parts: string[] = [];
  const parser = new HtmlParser(
    {
      onopentag(name, attrs) {
        if (name.toLowerCase() === "a" && attrs.href) {
          href = attrs.href;
          parts = [];
        }
      },
      ontext(text) {
        if (href) {
          parts.push(text);
        }
      },
      onclosetag(name) {
        if (name.toLowerCase() === "a" && href) {
          const label = normalizeText(parts.join(""));
          if (label) {
            links.push({ label, href: zipJoin(navPath, href) });
          }
          href = null;
          parts = [];
        }
      }
    },
    { decodeEntities: true, lowerCaseTags: true }
  );
  parser.write(await file.async("string"));
  parser.end();
  return links;
}

function parseBlocks(source: string): { title: string; headings: string[]; paragraphs: string[] } {
  const blockTags = new Set(["p", "h1", "h2", "h3"]);
  let currentTag: string | null = null;
  let depth = 0;
  let parts: string[] = [];
  let inTitle = false;
  let titleParts: string[] = [];
  let title = "";
  const headings: string[] = [];
  const paragraphs: string[] = [];

  const finishBlock = () => {
    const text = normalizeText(parts.join(""));
    if (text && currentTag) {
      if (currentTag === "p") {
        paragraphs.push(text);
      } else {
        headings.push(text);
      }
    }
    currentTag = null;
    depth = 0;
    parts = [];
  };

  const parser = new HtmlParser(
    {
      onopentag(name, attrs) {
        const tag = name.toLowerCase();
        if (tag === "title") {
          inTitle = true;
          titleParts = [];
          return;
        }
        if (blockTags.has(tag) && currentTag === null) {
          currentTag = tag;
          depth = 1;
          parts = [];
          return;
        }
        if (currentTag !== null) {
          if (blockTags.has(tag)) {
            depth += 1;
          } else if (tag === "br") {
            parts.push("\n");
          } else if (tag === "img" && attrs.alt) {
            parts.push(attrs.alt);
          }
        }
      },
      ontext(text) {
        if (inTitle) {
          titleParts.push(text);
        }
        if (currentTag !== null) {
          parts.push(text);
        }
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (tag === "title" && inTitle) {
          title = normalizeText(titleParts.join(""));
          inTitle = false;
          titleParts = [];
          return;
        }
        if (currentTag !== null && tag === currentTag) {
          depth -= 1;
          if (depth <= 0) {
            finishBlock();
          }
        }
      }
    },
    { decodeEntities: true, lowerCaseTags: true }
  );
  parser.write(source);
  parser.end();
  return { title, headings, paragraphs };
}

function selectSections(book: EpubBook, minParagraphs: number): Section[] {
  const selected: Section[] = [];
  const seen = new Set<string>();
  for (const item of book.tocItems) {
    const section = book.sectionsByHref.get(item.href);
    if (!section || seen.has(section.href)) {
      continue;
    }
    if (isChapterLabel(item.label) && section.paragraphs.length >= 1) {
      selected.push({ ...section, title: item.label });
      seen.add(section.href);
    }
  }
  if (selected.length >= 2) {
    return selected;
  }

  const candidates = book.sections.filter((section) => section.paragraphs.length >= minParagraphs);
  const bodyLike = candidates.filter((section) => !frontBackPattern.test(section.title));
  return bodyLike.length >= 2 ? bodyLike : candidates;
}

function isChapterLabel(label: string): boolean {
  const normalized = normalizeText(label);
  return chapterPatterns.some((pattern) => pattern.test(normalized));
}

function alignSections(zhSections: Section[], enSections: Section[]): SectionPair[] {
  if (zhSections.length === enSections.length) {
    return zhSections.map((zh, index) => ({
      number: index + 1,
      zh,
      en: enSections[index]
    }));
  }

  const m = zhSections.length;
  const n = enSections.length;
  const zhLengths = zhSections.map((section) => Math.max(1, sumParagraphLength(section.paragraphs)));
  const enLengths = enSections.map((section) => Math.max(1, sumParagraphLength(section.paragraphs)));
  const ratio = sum(enLengths) / Math.max(1, sum(zhLengths));
  const cost = Array.from({ length: m + 1 }, () => Array(n + 1).fill(Number.POSITIVE_INFINITY) as number[]);
  const prev: Array<Array<[number, number, number, number] | null>> = Array.from({ length: m + 1 }, () => Array(n + 1).fill(null));
  cost[0][0] = 0;

  const pairCost = (i: number, j: number, dz: number, de: number) => {
    if (dz === 0 || de === 0) {
      return 2.3;
    }
    const expectedEn = Math.max(1, zhLengths[i] * ratio);
    return Math.abs(Math.log((enLengths[j] + 1) / (expectedEn + 1)));
  };

  for (let i = 0; i <= m; i += 1) {
    for (let j = 0; j <= n; j += 1) {
      const base = cost[i][j];
      if (!Number.isFinite(base)) {
        continue;
      }
      for (const [dz, de] of [
        [1, 1],
        [1, 0],
        [0, 1]
      ] as const) {
        const ni = i + dz;
        const nj = j + de;
        if (ni > m || nj > n) {
          continue;
        }
        const candidate = base + pairCost(i, j, dz, de);
        if (candidate < cost[ni][nj]) {
          cost[ni][nj] = candidate;
          prev[ni][nj] = [i, j, dz, de];
        }
      }
    }
  }

  const pairs: Omit<SectionPair, "number">[] = [];
  let i = m;
  let j = n;
  while (i || j) {
    const step = prev[i][j];
    if (!step) {
      throw new Error("章节对齐失败");
    }
    const [pi, pj, dz, de] = step;
    pairs.push({
      zh: dz ? zhSections[pi] : null,
      en: de ? enSections[pj] : null
    });
    i = pi;
    j = pj;
  }
  pairs.reverse();
  return pairs.map((pair, index) => ({ number: index + 1, ...pair }));
}

function alignParagraphs(zhParagraphs: string[], enParagraphs: string[]): AlignmentGroup[] {
  const m = zhParagraphs.length;
  const n = enParagraphs.length;
  if (m === 0 && n === 0) {
    return [];
  }
  if (m === 0) {
    return enParagraphs.map((paragraph) => ({ zh: [], en: [paragraph] }));
  }
  if (n === 0) {
    return zhParagraphs.map((paragraph) => ({ zh: [paragraph], en: [] }));
  }
  if (m === n) {
    return zhParagraphs.map((paragraph, index) => ({
      zh: [paragraph],
      en: [enParagraphs[index]]
    }));
  }

  const zhLengths = zhParagraphs.map((paragraph) => Math.max(1, visibleLen(paragraph)));
  const enLengths = enParagraphs.map((paragraph) => Math.max(1, visibleLen(paragraph)));
  const ratio = sum(enLengths) / Math.max(1, sum(zhLengths));
  const moves: Array<[number, number, number]> =
    n > m ? [[1, 1, 0], [1, 2, 0.42], [0, 1, 2.8]] : [[1, 1, 0], [2, 1, 0.42], [1, 0, 2.8]];

  const cost = Array.from({ length: m + 1 }, () => Array(n + 1).fill(Number.POSITIVE_INFINITY) as number[]);
  const prev: Array<Array<[number, number, number, number] | null>> = Array.from({ length: m + 1 }, () => Array(n + 1).fill(null));
  cost[0][0] = 0;

  const groupCost = (i: number, j: number, dz: number, de: number, penalty: number) => {
    if (dz === 0 || de === 0) {
      return penalty;
    }
    const zhLen = sum(zhLengths.slice(i, i + dz));
    const enLen = sum(enLengths.slice(j, j + de));
    const expectedEn = Math.max(1, zhLen * ratio);
    const lengthCost = Math.abs(Math.log((enLen + 1) / (expectedEn + 1)));
    const sizePenalty = 0.06 * Math.max(0, dz + de - 2);
    return 2 * lengthCost + penalty + sizePenalty;
  };

  for (let i = 0; i <= m; i += 1) {
    for (let j = 0; j <= n; j += 1) {
      const base = cost[i][j];
      if (!Number.isFinite(base)) {
        continue;
      }
      for (const [dz, de, penalty] of moves) {
        const ni = i + dz;
        const nj = j + de;
        if (ni > m || nj > n) {
          continue;
        }
        const candidate = base + groupCost(i, j, dz, de, penalty);
        if (candidate < cost[ni][nj]) {
          cost[ni][nj] = candidate;
          prev[ni][nj] = [i, j, dz, de];
        }
      }
    }
  }

  const groups: AlignmentGroup[] = [];
  let i = m;
  let j = n;
  while (i || j) {
    const step = prev[i][j];
    if (!step) {
      throw new Error("段落对齐失败");
    }
    const [pi, pj, dz, de] = step;
    groups.push({
      zh: zhParagraphs.slice(pi, pi + dz),
      en: enParagraphs.slice(pj, pj + de)
    });
    i = pi;
    j = pj;
  }
  groups.reverse();
  return groups;
}

function renderReport(aligned: Array<{ pair: SectionPair; groups: AlignmentGroup[] }>): string {
  const lines = [
    [
      "section",
      "zh_title",
      "en_title",
      "zh_paragraphs",
      "en_paragraphs",
      "groups",
      "one_to_one",
      "zh_merged",
      "en_merged",
      "both_merged",
      "zh_only",
      "en_only"
    ].join("\t")
  ];

  for (const item of aligned) {
    const stats = groupStats(item.groups);
    lines.push(
      [
        item.pair.number,
        item.pair.zh?.title ?? "",
        item.pair.en?.title ?? "",
        item.pair.zh?.paragraphs.length ?? 0,
        item.pair.en?.paragraphs.length ?? 0,
        item.groups.length,
        stats.oneToOne,
        stats.zhMerged,
        stats.enMerged,
        stats.bothMerged,
        stats.zhOnly,
        stats.enOnly
      ].join("\t")
    );
  }
  return `${lines.join("\n")}\n`;
}

function groupStats(groups: AlignmentGroup[]) {
  return {
    oneToOne: groups.filter((group) => group.zh.length === 1 && group.en.length === 1).length,
    zhMerged: groups.filter((group) => group.zh.length > 1 && group.en.length === 1).length,
    enMerged: groups.filter((group) => group.zh.length === 1 && group.en.length > 1).length,
    bothMerged: groups.filter((group) => group.zh.length > 1 && group.en.length > 1).length,
    zhOnly: groups.filter((group) => group.zh.length > 0 && group.en.length === 0).length,
    enOnly: groups.filter((group) => group.en.length > 0 && group.zh.length === 0).length
  };
}

async function readCover(book: EpubBook): Promise<{ bytes: Buffer | null; mediaType: string | null }> {
  if (!book.coverHref || !book.coverMediaType) {
    return { bytes: null, mediaType: null };
  }
  const file = book.zip.file(book.coverHref);
  if (!file) {
    return { bytes: null, mediaType: null };
  }
  return {
    bytes: await file.async("nodebuffer"),
    mediaType: book.coverMediaType
  };
}

function renderContainer(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`;
}

function renderStyle(theme: ThemeOptions): string {
  return `
body {
  color: ${cssColor(theme.zh.color)};
  font-family: serif;
  line-height: 1.6;
  margin: 0 5%;
}
h1 {
  font-size: 1.35em;
  line-height: 1.35;
  margin: 1.6em 0 1.4em;
  text-align: center;
}
.subtitle {
  font-size: 1.05em;
  margin: 0 0 1.4em;
  text-align: center;
}
.pair {
  margin: 0 0 1.1em;
  page-break-inside: avoid;
}
.pair.combined {
  border-left: 0.12em solid #999;
  padding-left: 0.65em;
}
.zh,
.en {
  font-size: 1em;
}
.en {
  color: ${cssColor(theme.en.color)};
  font-size: ${cssNumber(theme.en.fontSizeRem)}rem;
  line-height: ${cssNumber(theme.en.lineHeight)};
  margin: 0 0 0.18em;
}
.zh {
  color: ${cssColor(theme.zh.color)};
  font-size: ${cssNumber(theme.zh.fontSizeRem)}rem;
  line-height: ${cssNumber(theme.zh.lineHeight)};
  margin: 0 0 0.45em;
}
.cover-page {
  margin: 0;
  text-align: center;
}
.cover-wrap {
  margin: 0;
  padding: 0;
  text-align: center;
}
.cover-wrap img {
  height: auto;
  max-height: 100%;
  max-width: 100%;
  width: auto;
}
`.trim();
}

function renderCover(title: string, coverPath: string | null): string {
  const image = coverPath
    ? `<div class="cover-wrap"><img src="../${xesc(coverPath)}" alt="${xesc(title)}" /></div>`
    : `<h1>${xesc(title)}</h1>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head>
<title>${xesc(title)}</title>
<link href="../Styles/style.css" rel="stylesheet" type="text/css" />
</head>
<body class="cover-page">
${image}
</body>
</html>`;
}

function renderTitlePage(options: BuildOptions, zhBook: EpubBook, enBook: EpubBook, pairs: SectionPair[]): string {
  const orderText = options.order === "en-first" ? "英文段落在上，中文段落在下" : "中文段落在上，英文段落在下";
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head>
<title>${xesc(options.title)}</title>
<link href="../Styles/style.css" rel="stylesheet" type="text/css" />
</head>
<body>
<h1>${xesc(options.title)}</h1>
<p class="subtitle">中英对照版</p>
<p class="zh">${xesc(orderText)}。共合成 ${pairs.length} 个章节单元。</p>
<p class="zh">中文来源：${xesc(zhBook.title)}</p>
<p class="en">English source: ${xesc(enBook.title)}</p>
</body>
</html>`;
}

function renderChapter(pair: SectionPair, groups: AlignmentGroup[], order: ParagraphOrder): string {
  const title = pairTitle(pair);
  const body = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">',
    "<head>",
    `<title>${xesc(title)}</title>`,
    '<link href="../Styles/style.css" rel="stylesheet" type="text/css" />',
    "</head>",
    "<body>",
    `<h1>${xesc(title)}</h1>`
  ];

  for (const group of groups) {
    const classes = ["pair"];
    if (group.zh.length !== 1 || group.en.length !== 1) {
      classes.push("combined");
    }
    if (group.zh.length > 0 && group.en.length === 0) {
      classes.push("zh-only");
    }
    if (group.en.length > 0 && group.zh.length === 0) {
      classes.push("en-only");
    }
    body.push(`<div class="${classes.join(" ")}">`);
    if (order === "zh-first") {
      for (const paragraph of group.zh) {
        body.push(`<p class="zh" xml:lang="zh-CN" lang="zh-CN">${xesc(paragraph)}</p>`);
      }
      for (const paragraph of group.en) {
        body.push(`<p class="en" xml:lang="en" lang="en">${xesc(paragraph)}</p>`);
      }
    } else {
      for (const paragraph of group.en) {
        body.push(`<p class="en" xml:lang="en" lang="en">${xesc(paragraph)}</p>`);
      }
      for (const paragraph of group.zh) {
        body.push(`<p class="zh" xml:lang="zh-CN" lang="zh-CN">${xesc(paragraph)}</p>`);
      }
    }
    body.push("</div>");
  }

  body.push("</body>", "</html>");
  return body.join("\n");
}

function renderOpf(bookId: string, options: BuildOptions, pairs: SectionPair[], coverPath: string | null, coverMediaType: string | null): string {
  const authorLine = options.author ? `<dc:creator>${xesc(options.author)}</dc:creator>` : "";
  const coverItem = coverPath && coverMediaType ? `<item id="cover-image" href="${xesc(coverPath)}" media-type="${xesc(coverMediaType)}" />` : "";
  const coverMeta = coverPath ? '<meta name="cover" content="cover-image" />' : "";
  const manifest = [
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />',
    '<item id="style" href="Styles/style.css" media-type="text/css" />',
    '<item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml" />',
    '<item id="title" href="Text/title.xhtml" media-type="application/xhtml+xml" />',
    coverItem,
    ...pairs.map((pair) => `<item id="chapter${pad(pair.number)}" href="${chapterFilename(pair.number)}" media-type="application/xhtml+xml" />`)
  ]
    .filter(Boolean)
    .join("\n    ");
  const spine = [
    '<itemref idref="cover" linear="no" />',
    '<itemref idref="title" />',
    ...pairs.map((pair) => `<itemref idref="chapter${pad(pair.number)}" />`)
  ].join("\n    ");

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${xesc(options.title)}</dc:title>
    ${authorLine}
    <dc:language>zh</dc:language>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid" opf:scheme="UUID">${bookId}</dc:identifier>
    ${coverMeta}
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine toc="ncx">
    ${spine}
  </spine>
  <guide>
    <reference type="cover" title="封面" href="Text/cover.xhtml" />
    <reference type="text" title="正文" href="Text/chapter001.xhtml" />
  </guide>
</package>`;
}

function renderNcx(bookId: string, title: string, pairs: SectionPair[]): string {
  const points = [
    `    <navPoint id="title" playOrder="1">
      <navLabel><text>书名页</text></navLabel>
      <content src="Text/title.xhtml" />
    </navPoint>`,
    ...pairs.map(
      (pair, index) => `    <navPoint id="chapter${pad(pair.number)}" playOrder="${index + 2}">
      <navLabel><text>${xesc(pairTitle(pair))}</text></navLabel>
      <content src="${chapterFilename(pair.number)}" />
    </navPoint>`
    )
  ].join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh">
  <head>
    <meta name="dtb:uid" content="${bookId}" />
    <meta name="dtb:depth" content="1" />
    <meta name="dtb:totalPageCount" content="0" />
    <meta name="dtb:maxPageNumber" content="0" />
  </head>
  <docTitle><text>${xesc(title)}</text></docTitle>
  <navMap>
${points}
  </navMap>
</ncx>`;
}

function validateGeneratedEpub(buffer: Buffer): void {
  const text = buffer.toString("binary", 0, 64);
  if (!text.includes("mimetype")) {
    throw new Error("生成 EPUB 失败：缺少 mimetype");
  }
}

async function readZipText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (!file) {
    throw new Error(`EPUB 缺少 ${name}`);
  }
  return file.async("string");
}

function zipJoin(baseFile: string, href: string): string {
  const cleanHref = safeDecode(href.split("#", 1)[0] ?? "").replace(/^\/+/, "");
  const baseDir = path.posix.dirname(baseFile);
  return path.posix.normalize(path.posix.join(baseDir, cleanHref));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}

function visibleLen(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function sumParagraphLength(paragraphs: string[]): number {
  return sum(paragraphs.map(visibleLen));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function pairTitle(pair: SectionPair): string {
  if (pair.zh && pair.en) {
    return `${pair.zh.title} / ${pair.en.title}`;
  }
  return pair.zh?.title ?? pair.en?.title ?? `Section ${pair.number}`;
}

function chapterFilename(number: number): string {
  return `Text/chapter${pad(number)}.xhtml`;
}

function pad(number: number): string {
  return String(number).padStart(3, "0");
}

function coverExtension(mediaType: string): string {
  if (mediaType.includes("png")) {
    return "png";
  }
  if (mediaType.includes("webp")) {
    return "webp";
  }
  if (mediaType.includes("gif")) {
    return "gif";
  }
  return "jpg";
}

function xesc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cssNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2).replace(/\.?0+$/, "") : "1";
}

function cssColor(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#111111";
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function objectAt(value: unknown, key: string): unknown {
  if (value && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function stringAttr(value: unknown, key: string): string {
  const attr = objectAt(value, key);
  return typeof attr === "string" || typeof attr === "number" ? String(attr) : "";
}

function textValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return textValue(value[0]);
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object["#text"] === "string") {
      return object["#text"];
    }
  }
  return "";
}
