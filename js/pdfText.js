// Turns a PDF bank statement into text for models that can't read PDFs (the OpenAI-compatible provider).
// Uses pdf.js (Mozilla), loaded from the CDN only when a statement is read this way.
// Each page becomes lines of text, with " | " where a wide gap separates columns, so statement tables keep
// their rows. A page with no text layer (a scan) is sent as a JPEG instead, for models that can see images.

const PDFJS_VERSION = '6.4.299';
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

export const MAX_PAGES = 60;
export const MAX_IMAGE_PAGES = 40; // the relay accepts up to 40 page images
const MIN_TEXT_CHARS = 20;         // fewer readable characters than this: treat the page as a scan
const IMAGE_DPI = 150;
const MAX_IMAGE_SIDE = 2000;       // pixels

let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ||= import(PDFJS_URL).then(lib => {
    lib.GlobalWorkerOptions.workerSrc = WORKER_URL;
    return lib;
  }).catch(e => {
    pdfjsPromise = null;
    throw new Error(`Could not load the PDF reader (${e.message}). Check your connection and try again.`);
  });
  return pdfjsPromise;
}

// Text items of one page, grouped into lines from top to bottom, each line read left to right
function pageLines(items) {
  const pieces = items
    .filter(it => typeof it.str === 'string' && it.str.trim())
    .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || it.height || 10 }));
  pieces.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const p of pieces) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - p.y) <= Math.max(2, Math.min(line.h, p.h) * 0.5)) line.items.push(p);
    else lines.push({ y: p.y, h: p.h, items: [p] });
  }

  return lines.map(line => {
    const row = line.items.sort((a, b) => a.x - b.x);
    let out = '';
    row.forEach((p, i) => {
      if (i) {
        const prev = row[i - 1];
        const gap = p.x - (prev.x + prev.w);
        if (gap > p.h * 1.5) out = out.trimEnd() + ' | ';
        else if (gap > p.h * 0.15 && !out.endsWith(' ') && !p.str.startsWith(' ')) out += ' ';
      }
      out += p.str;
    });
    return out.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

async function pageImage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(IMAGE_DPI / 72, MAX_IMAGE_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.8);
  canvas.width = canvas.height = 0; // release the bitmap
  return url;
}

// Returns { markdown, pages }: the statement's text page by page, and JPEG data URLs of pages that had no text
export async function pdfToMarkdown(file) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    task.destroy();
    if (e?.name === 'PasswordException') throw new Error('This PDF is protected by a password. Save an unprotected copy from your bank or PDF viewer and import that.');
    throw new Error(`This PDF could not be opened (${e?.message || e}).`);
  }
  try {
    if (doc.numPages > MAX_PAGES) throw new Error(`This PDF has ${doc.numPages} pages; the limit is ${MAX_PAGES}. Split it into shorter periods.`);
    const parts = [], pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const lines = pageLines((await page.getTextContent()).items);
      if (lines.join('').replace(/\s/g, '').length >= MIN_TEXT_CHARS) {
        parts.push(`## Page ${n}\n${lines.join('\n')}`);
      } else {
        if (pages.length >= MAX_IMAGE_PAGES) throw new Error(`More than ${MAX_IMAGE_PAGES} pages of this PDF are scans without text. Split it into shorter periods.`);
        pages.push(await pageImage(page));
        parts.push(`## Page ${n}\n(No text on this page: it is image ${pages.length} attached below.)`);
      }
      page.cleanup();
    }
    return { markdown: parts.join('\n\n'), pages };
  } finally {
    task.destroy(); // frees the document and the worker's copy of it
  }
}
