const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const PAGE_BOTTOM = 58;

function asciiText(value) {
  return String(value ?? "")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u2265/g, ">=")
    .replace(/\u2264/g, "<=")
    .replace(/\u2022/g, "-")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E\n]/g, "");
}

function pdfText(value) {
  return asciiText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapLine(text, maxCharacters) {
  const words = asciiText(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let line = "";

  for (const word of words) {
    if (word.length > maxCharacters) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let offset = 0; offset < word.length; offset += maxCharacters) {
        lines.push(word.slice(offset, offset + maxCharacters));
      }
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxCharacters) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function wrapText(text, width, fontSize) {
  const maxCharacters = Math.max(12, Math.floor(width / (fontSize * 0.52)));
  return asciiText(text)
    .split("\n")
    .flatMap((line) => wrapLine(line, maxCharacters));
}

class ManualPdfLayout {
  constructor(manual) {
    this.manual = manual;
    this.pages = [];
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  newPage() {
    this.page = [];
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - 52;
  }

  ensureSpace(height) {
    if (this.y - height < PAGE_BOTTOM) this.newPage();
  }

  line(text, { x = MARGIN, size = 10, bold = false, color = "0 0 0" } = {}) {
    this.page.push(
      `q ${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(
        1
      )} ${this.y.toFixed(1)} Tm (${pdfText(text)}) Tj ET Q`
    );
  }

  paragraph(
    text,
    {
      size = 10,
      bold = false,
      indent = 0,
      hangingIndent = 0,
      prefix = "",
      lineHeight = Math.round(size * 1.42),
      after = 8,
      color = "0.12 0.14 0.18",
    } = {}
  ) {
    const textWidth = CONTENT_WIDTH - indent - hangingIndent;
    const lines = wrapText(text, textWidth, size);
    const required = Math.max(lineHeight, lines.length * lineHeight) + after;
    this.ensureSpace(Math.min(required, PAGE_HEIGHT - PAGE_BOTTOM - MARGIN));

    lines.forEach((line, index) => {
      if (this.y - lineHeight < PAGE_BOTTOM) this.newPage();
      const continued = index > 0;
      this.line(`${continued ? "" : prefix}${line}`, {
        x: MARGIN + indent + (continued ? hangingIndent : 0),
        size,
        bold,
        color,
      });
      this.y -= lineHeight;
    });
    this.y -= after;
  }

  heading(text, { level = 2, after = 8 } = {}) {
    const style =
      level === 1
        ? { size: 23, lineHeight: 29, color: "0.08 0.27 0.62" }
        : level === 2
        ? { size: 16, lineHeight: 21, color: "0.08 0.27 0.62" }
        : { size: 12, lineHeight: 17, color: "0.10 0.18 0.32" };
    this.paragraph(text, { ...style, bold: true, after });
  }

  rule() {
    this.ensureSpace(18);
    this.page.push(
      `q 0.77 0.82 0.90 RG 0.7 w ${MARGIN} ${this.y.toFixed(1)} m ${(
        PAGE_WIDTH - MARGIN
      ).toFixed(1)} ${this.y.toFixed(1)} l S Q`
    );
    this.y -= 18;
  }

  renderBlock(block) {
    if (block.type === "paragraph") {
      this.paragraph(block.text);
      return;
    }

    if (block.type === "note") {
      this.heading(block.title, { level: 3, after: 4 });
      this.paragraph(`${block.tone === "warning" ? "Important: " : "Note: "}${block.text}`, {
        indent: 10,
        color: block.tone === "warning" ? "0.55 0.30 0.02" : "0.05 0.30 0.60",
      });
      return;
    }

    if (block.type === "example") {
      this.heading(block.title, { level: 3, after: 4 });
      this.paragraph(`Scenario: ${block.scenario}`, { indent: 10, after: 5 });
      block.steps.forEach((step, index) =>
        this.paragraph(step, {
          indent: 14,
          hangingIndent: 18,
          prefix: `${index + 1}. `,
          after: 3,
        })
      );
      this.paragraph(`Expected result: ${block.result}`, {
        indent: 10,
        bold: true,
        after: 10,
      });
      return;
    }

    this.heading(block.title, { level: 3, after: 4 });
    block.items.forEach((item, index) =>
      this.paragraph(item, {
        indent: 12,
        hangingIndent: block.type === "steps" ? 18 : 12,
        prefix: block.type === "steps" ? `${index + 1}. ` : "- ",
        after: 3,
      })
    );
    this.y -= 5;
  }

  render() {
    this.heading(this.manual.title, { level: 1, after: 10 });
    this.paragraph(this.manual.description, { size: 11, lineHeight: 16, after: 12 });
    this.paragraph(
      `Manual ${this.manual.manualVersion} | Updated ${this.manual.updatedAt} | ${this.manual.coverageBaseline}`,
      { size: 8.5, color: "0.35 0.38 0.44", after: 14 }
    );
    this.rule();
    this.heading("Contents", { level: 2, after: 7 });
    this.manual.sections.forEach((section, index) => {
      this.paragraph(`${index + 1}. ${section.title}`, {
        size: 10,
        indent: 6,
        after: 3,
        color: "0.08 0.27 0.62",
      });
    });

    this.manual.sections.forEach((section, index) => {
      this.ensureSpace(80);
      this.rule();
      this.heading(`${index + 1}. ${section.title}`, { level: 2, after: 4 });
      this.paragraph(section.summary, {
        size: 9.5,
        color: "0.35 0.38 0.44",
        after: 6,
      });
      const roles = section.roles.map((role) => role[0].toUpperCase() + role.slice(1));
      this.paragraph(
        `Available to: ${roles.length === 4 ? "all signed-in roles" : roles.join(", ")}`,
        { size: 8.5, bold: true, color: "0.20 0.32 0.52", after: 10 }
      );
      section.blocks.forEach((block) => this.renderBlock(block));
    });

    return this.pages;
  }
}

function buildPdf(pages, manual) {
  const pageCount = pages.length;
  const firstPageId = 3;
  const firstContentId = firstPageId + pageCount;
  const regularFontId = firstContentId + pageCount;
  const boldFontId = regularFontId + 1;
  const infoId = boldFontId + 1;
  const objectCount = infoId;
  const objects = new Array(objectCount + 1);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from(
    { length: pageCount },
    (_, index) => `${firstPageId + index} 0 R`
  ).join(" ")}] >>`;

  pages.forEach((commands, index) => {
    const pageId = firstPageId + index;
    const contentId = firstContentId + index;
    const pageNumber = index + 1;
    const footer = [
      `q 0.80 0.83 0.88 RG 0.5 w ${MARGIN} 38 m ${PAGE_WIDTH - MARGIN} 38 l S Q`,
      `q 0.38 0.41 0.48 rg BT /F1 8 Tf 1 0 0 1 ${MARGIN} 24 Tm (${pdfText(
        manual.shortTitle
      )}) Tj ET Q`,
      `q 0.38 0.41 0.48 rg BT /F1 8 Tf 1 0 0 1 ${PAGE_WIDTH - 110} 24 Tm (${pdfText(
        `Page ${pageNumber} of ${pageCount}`
      )}) Tj ET Q`,
    ];
    const stream = [...commands, ...footer].join("\n");
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`;
  });

  objects[regularFontId] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[boldFontId] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[infoId] = `<< /Title (${pdfText(manual.title)}) /Author (ALPR Database Community) /Subject (Website user guide) /Creator (ALPR Database Community Help Center) >>`;

  let output = "%PDF-1.4\n";
  const offsets = new Array(objectCount + 1).fill(0);
  for (let id = 1; id <= objectCount; id += 1) {
    offsets[id] = Buffer.byteLength(output, "ascii");
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objectCount + 1}\n`;
  output += "0000000000 65535 f \n";
  for (let id = 1; id <= objectCount; id += 1) {
    output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

export function generateHelpManualPdf(manual) {
  if (!manual?.title || !Array.isArray(manual.sections) || manual.sections.length === 0) {
    throw new TypeError("A populated help manual is required.");
  }
  const pages = new ManualPdfLayout(manual).render();
  return buildPdf(pages, manual);
}
