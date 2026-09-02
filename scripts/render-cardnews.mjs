import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const outputDir = path.join(root, "media/cardnews/repogram-ko");
const backgroundPath = path.join(outputDir, "repogram-graph-background.png");
const iconPath = path.join(root, "media/icon.png");
const W = 1080;
const H = 1350;

await fs.mkdir(outputDir, { recursive: true });

const escapeXml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

function textLines(lines, x, y, size, weight = 700, lineHeight = 1.14, fill = "#f8fafc", anchor = "start") {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="Noto Sans CJK KR, Apple SD Gothic Neo, sans-serif">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : size * lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function footer(page) {
  const dots = Array.from({ length: 6 }, (_, index) => `<circle cx="${468 + index * 22}" cy="1293" r="5" fill="${index + 1 === page ? "#f8fafc" : "#64748b"}"/>`).join("");
  return `${dots}<text x="54" y="1299" fill="#64748b" font-size="21" font-family="Noto Sans CJK KR, sans-serif">github.com/nanjjang/repogram</text><text x="1026" y="1299" fill="#94a3b8" font-size="20" font-weight="700" text-anchor="end" font-family="Noto Sans CJK KR, sans-serif">REPOGRAM</text>`;
}

function svg(body, defs = "") {
  return Buffer.from(`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${body}</svg>`);
}

function sizedSvg(width, height, body) {
  return Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
}

async function baseCanvas(extraDark = 0.28) {
  const bg = await fs.access(backgroundPath)
    .then(() => sharp(backgroundPath).resize(W, H, { fit: "cover" }).png().toBuffer())
    .catch(() => sharp({
      create: { width: W, height: H, channels: 4, background: "#071426" },
    }).png().toBuffer());
  return sharp(bg).composite([{ input: svg(`<rect width="${W}" height="${H}" fill="#020617" opacity="${extraDark}"/>`) }]);
}

async function screenshotPanel(source, width = 980, height = 760) {
  const image = await sharp(source)
    .resize(width, height, { fit: "contain", position: "centre", background: "#101214" })
    .modulate({ brightness: 0.84, saturation: 0.9 })
    .png()
    .toBuffer();
  const mask = sizedSvg(width, height, `<rect x="0" y="0" width="${width}" height="${height}" rx="26" fill="white"/>`);
  return sharp(image).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

async function renderCover() {
  const icon = await sharp(iconPath).resize(340, 340).png().toBuffer();
  const defs = `<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#020617" stop-opacity="0"/><stop offset="0.58" stop-color="#020617" stop-opacity="0.45"/><stop offset="1" stop-color="#020617" stop-opacity="0.96"/></linearGradient>`;
  const overlay = svg(`
    <rect width="${W}" height="${H}" fill="url(#fade)"/>
    <rect x="54" y="70" width="8" height="30" rx="4" fill="#38bdf8"/>
    <text x="78" y="94" fill="#cbd5e1" font-size="24" font-weight="800" letter-spacing="1.5" font-family="Noto Sans CJK KR, sans-serif">VS CODE · STATIC ANALYSIS</text>
    ${textLines(["낯선 코드베이스를", "지도처럼 읽습니다"], 54, 850, 72, 900, 1.13)}
    ${textLines(["Repogram · VS Code 안에서 코드 구조를 탐색하는 익스텐션"], 54, 1040, 27, 500, 1.2, "#cbd5e1")}
    ${footer(1)}
  `, defs);
  await (await baseCanvas(0.12)).composite([{ input: icon, left: 370, top: 250 }, { input: overlay }]).png().toFile(path.join(outputDir, "01-cover.png"));
}

async function renderFeature({ page, eyebrow, title, description, screenshot, position = "centre" }) {
  const panel = await screenshotPanel(screenshot, 980, 760, position);
  const defs = `<linearGradient id="panelFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#020617" stop-opacity="0"/><stop offset="0.62" stop-color="#020617" stop-opacity="0.15"/><stop offset="1" stop-color="#020617" stop-opacity="1"/></linearGradient>`;
  const titleY = 1000;
  const overlay = svg(`
    <rect x="0" y="610" width="${W}" height="740" fill="url(#panelFade)"/>
    <circle cx="85" cy="835" r="39" fill="#38bdf8"/><text x="85" y="847" fill="#04111f" font-size="34" font-weight="900" text-anchor="middle" font-family="Noto Sans CJK KR, sans-serif">${String(page - 1).padStart(2, "0")}</text>
    <rect x="54" y="895" width="7" height="27" rx="4" fill="#38bdf8"/>
    <text x="76" y="918" fill="#cbd5e1" font-size="22" font-weight="800" letter-spacing="1" font-family="Noto Sans CJK KR, sans-serif">${escapeXml(eyebrow)}</text>
    ${textLines(title, 54, titleY, 62, 900, 1.12)}
    ${textLines(description, 54, 1165, 27, 500, 1.44, "#cbd5e1")}
    ${footer(page)}
  `, defs);
  await (await baseCanvas(0.34)).composite([
    { input: panel, left: 50, top: 52 },
    { input: svg(`<rect x="50" y="52" width="980" height="760" rx="26" fill="none" stroke="#38bdf8" stroke-opacity="0.32" stroke-width="2"/>`) },
    { input: overlay },
  ]).png().toFile(path.join(outputDir, `0${page}-${eyebrow.toLowerCase().replaceAll(" ", "-")}.png`));
}

async function renderEnd() {
  const defs = `<linearGradient id="repogram" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#60a5fa"/><stop offset="0.55" stop-color="#38bdf8"/><stop offset="1" stop-color="#5eead4"/></linearGradient>`;
  const overlay = svg(`
    <text x="540" y="560" fill="url(#repogram)" font-size="172" font-weight="900" letter-spacing="10" text-anchor="middle" font-family="Noto Sans CJK KR, sans-serif">REPOGRAM</text>
    <text x="540" y="630" fill="#94a3b8" font-size="24" font-weight="700" letter-spacing="9" text-anchor="middle" font-family="Noto Sans CJK KR, sans-serif">PROJECT · CODEBASE · MAP</text>
    ${textLines(["코드를 떠나지 않고,", "코드베이스를 이해하세요"], 540, 760, 43, 800, 1.4, "#f8fafc", "middle")}
    <rect x="310" y="975" width="460" height="68" rx="34" fill="#0ea5e9" fill-opacity="0.16" stroke="#38bdf8" stroke-opacity="0.8"/>
    <text x="540" y="1019" fill="#bae6fd" font-size="26" font-weight="800" text-anchor="middle" font-family="Noto Sans CJK KR, sans-serif">VS Code Marketplace에서 곧 만나요</text>
    <text x="540" y="1112" fill="#94a3b8" font-size="24" text-anchor="middle" font-family="Noto Sans CJK KR, sans-serif">github.com/nanjjang/repogram</text>
    ${footer(6)}
  `, defs);
  await (await baseCanvas(0.2)).composite([{ input: overlay }]).png().toFile(path.join(outputDir, "06-outro.png"));
}

await renderCover();
await renderFeature({
  page: 2,
  eyebrow: "START READING",
  title: ["어디서 읽을지", "바로 보입니다"],
  description: ["진입점, 의존성 집중 파일, 큰 파일과 테스트 공백을", "한 화면에서 확인합니다."],
  screenshot: path.join(root, "media/screenshots/repogram-files.png"),
});
await renderFeature({
  page: 3,
  eyebrow: "FOLLOW THE FLOW",
  title: ["호출과 분기를", "흐름으로 봅니다"],
  description: ["라우트·호출·명시적 분기를 프로젝트부터 파일 단위까지", "단계적으로 좁혀 봅니다."],
  screenshot: path.join(root, "media/screenshots/repogram-flow.png"),
});
await renderFeature({
  page: 4,
  eyebrow: "DATA MODEL",
  title: ["테이블 관계를", "코드에서 읽습니다"],
  description: ["라이브 DB 연결 없이, 코드와 스키마 선언에서", "엔티티·필드·관계를 그립니다."],
  screenshot: path.join(root, "media/screenshots/repogram-data-model.png"),
});
await renderFeature({
  page: 5,
  eyebrow: "OUTSIDE EDGES",
  title: ["어디로 열리는지", "한눈에 봅니다"],
  description: ["HTTP·WebSocket·포트·핸들러를 선언 근거와 함께", "모아 보여줍니다."],
  screenshot: path.join(root, "media/screenshots/repogram-interfaces-polyglot.png"),
});
await renderEnd();

console.log(`Rendered six carousel cards to ${outputDir}`);
