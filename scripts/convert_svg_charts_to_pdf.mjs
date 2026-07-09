import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const chartsDirArg = process.argv[2];
if (!chartsDirArg) {
  console.error('Usage: node scripts/convert_svg_charts_to_pdf.mjs <charts-dir> [chrome-path]');
  process.exit(2);
}

const chartsDir = path.resolve(process.cwd(), chartsDirArg);
const chromePath = process.argv[3] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(chartsDir) || !statSync(chartsDir).isDirectory()) {
  throw new Error(`Charts directory not found: ${chartsDir}`);
}
if (!existsSync(chromePath)) {
  throw new Error(`Chrome executable not found: ${chromePath}`);
}

const svgFiles = readdirSync(chartsDir)
  .filter(file => file.endsWith('.svg'))
  .sort((a, b) => a.localeCompare(b));

if (svgFiles.length === 0) {
  throw new Error(`No SVG files found in ${chartsDir}`);
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'sonarscan-svg-pdf-'));
const outputs = [];

const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

try {
  for (const svgFile of svgFiles) {
    const svgPath = path.join(chartsDir, svgFile);
    const svg = readFileSync(svgPath, 'utf8');
    const sizeMatch = svg.match(/<svg[^>]*\bwidth="([0-9.]+)"[^>]*\bheight="([0-9.]+)"/);
    if (!sizeMatch) {
      throw new Error(`Could not determine SVG size: ${svgPath}`);
    }
    const width = Number(sizeMatch[1]);
    const height = Number(sizeMatch[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`Invalid SVG size for ${svgPath}: ${sizeMatch[1]} x ${sizeMatch[2]}`);
    }

    const basename = path.basename(svgFile, '.svg');
    const htmlPath = path.join(tempDir, `${basename}.html`);
    const pdfPath = path.join(chartsDir, `${basename}.pdf`);
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(basename)}</title>
<style>
  @page { size: ${width}px ${height}px; margin: 0; }
  html, body { width: ${width}px; height: ${height}px; margin: 0; background: #ffffff; }
  svg { display: block; width: ${width}px; height: ${height}px; }
</style>
</head>
<body>
${svg}
</body>
</html>
`;
    writeFileSync(htmlPath, html);

    const result = spawnSync(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ], {
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`Chrome failed for ${svgFile}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    const sizeBytes = statSync(pdfPath).size;
    if (sizeBytes <= 0) {
      throw new Error(`Empty PDF generated: ${pdfPath}`);
    }
    outputs.push({ svgPath, pdfPath, sizeBytes });
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  chartsDir,
  converted: outputs.length,
  outputs,
}, null, 2));
