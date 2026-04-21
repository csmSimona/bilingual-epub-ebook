import UploadForm from "@/components/upload-form";

export default function Home() {
  return (
    <main className="page-shell">
      <section className="workspace" aria-labelledby="page-title">
        <div className="intro">
          <p className="eyebrow">EPUB Parallel Builder</p>
          <h1 id="page-title">双语 EPUB 合成器</h1>
          <p className="intro-copy">上传中文和英文 EPUB，生成可下载的中英对照电子书与对齐报告。</p>
        </div>
        <UploadForm />
      </section>
    </main>
  );
}
