#!/usr/bin/env node
/**
 * teacher-dashboard.html → report.pdf 변환 스크립트
 * puppeteer-core + 로컬 Chrome을 사용합니다.
 *
 * 사용법: node scripts/export-pdf.js
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Chrome을 찾을 수 없습니다. Google Chrome을 설치해 주세요.');
    process.exit(1);
  }

  const htmlPath = path.resolve(__dirname, '../public/teacher-dashboard.html');
  const pdfPath = path.resolve(__dirname, '../public/report.pdf');

  if (!fs.existsSync(htmlPath)) {
    console.error('teacher-dashboard.html 파일이 없습니다.');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30000 });

  // Tailwind CDN 처리 + JS 렌더링 완료 대기
  await page.waitForFunction(
    () => {
      const el = document.getElementById('ranking-body');
      return el && el.children.length > 0;
    },
    { timeout: 15000 }
  );

  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
  });

  await browser.close();

  const stats = fs.statSync(pdfPath);
  const sizeKB = Math.round(stats.size / 1024);
  console.log(`✅ PDF 생성 완료: ${pdfPath} (${sizeKB}KB)`);
}

main().catch(err => {
  console.error('PDF 생성 실패:', err.message);
  process.exit(1);
});
