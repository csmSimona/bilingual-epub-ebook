import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "双语 EPUB 合成器",
  description: "上传中英文 EPUB，生成双语对照 EPUB。"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
