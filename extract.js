// Text extraction for PDF and Word (.docx) attachments. The text is then sent
// to the models like any other attached file.
//
// PDFs use Mozilla's pdf.js (the `pdfjs-dist` package, installed by
// `npm install`). Word files are read with the app's own .zip reader.

import { isZip, listZipEntries, readZipEntry } from './public/zip.js';

export const MAX_DOCUMENT_BYTES = 20_000_000;
const MAX_PDF_PAGES = 1000;

export class ExtractError extends Error {}

export const DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** 'pdf', 'docx', or throws an ExtractError explaining what's wrong. */
export function detectDocument(bytes, name = '') {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'pdf';
  if (isZip(bytes)) {
    let entries;
    try {
      entries = listZipEntries(bytes);
    } catch {
      throw new ExtractError(`${name || 'This file'} is damaged and can't be read.`);
    }
    if (entries.some((e) => e.name === 'word/document.xml')) return 'docx';
  }
  if (/\.doc$/i.test(name) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    throw new ExtractError(`${name || 'This file'} is an old Word file (.doc). Open it in Word and save it as .docx, then attach that.`);
  }
  throw new ExtractError(`${name || 'This file'} isn't a PDF or Word (.docx) document.`);
}

/** @returns {Promise<{text: string, pages?: number}>} */
export async function extractDocument(bytes, name = '') {
  const kind = detectDocument(bytes, name);
  return kind === 'pdf' ? extractPdf(bytes, name) : extractDocx(bytes, name);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // pdf.js warns at load time that its optional canvas package (used only
      // to draw pages) is missing. Text extraction doesn't need it, so hide
      // just those lines.
      const quiet = (original) => (...args) => {
        const first = String(args[0] ?? '');
        if (/^Warning: Cannot (load "@napi-rs\/canvas"|polyfill)/.test(first)) return;
        original(...args);
      };
      const { log, warn } = console;
      console.log = quiet(log);
      console.warn = quiet(warn);
      try {
        return await import('pdfjs-dist/legacy/build/pdf.mjs');
      } finally {
        console.log = log;
        console.warn = warn;
      }
    })().catch((err) => {
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

async function extractPdf(bytes, name) {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    throw new ExtractError('PDF support is not installed. Run "npm install" in the app folder, then restart the app.');
  }

  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), // pdf.js takes ownership of the buffer
    isEvalSupported: false, // never compile code from fonts
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      if (err?.name === 'PasswordException') throw new ExtractError(`${name || 'This PDF'} is password-protected. Remove the password and attach it again.`);
      throw new ExtractError(`${name || 'This PDF'} can't be read (${err?.message || 'damaged file'}).`);
    }
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    const pages = [];
    for (let i = 1; i <= pageCount; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((item) => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join('').trim());
    }
    const text = pages.filter(Boolean).join('\n\n');
    if (!text.trim()) {
      throw new ExtractError(`${name || 'This PDF'} has no selectable text. It may be a scanned image.`);
    }
    return { text, pages: doc.numPages };
  } finally {
    await task.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

async function extractDocx(bytes, name) {
  const entry = listZipEntries(bytes).find((e) => e.name === 'word/document.xml');
  const xml = new TextDecoder().decode(await readZipEntry(bytes, entry));
  const text = docxXmlToText(xml);
  if (!text.trim()) throw new ExtractError(`${name || 'This document'} has no text.`);
  return { text };
}

/**
 * Plain text from a .docx body: paragraphs on their own lines, table cells
 * separated by tabs, deleted (tracked) text left out.
 */
export function docxXmlToText(xml) {
  const parts = [];
  let inText = false;
  let cellDepth = 0;
  const dropLast = (token) => {
    if (parts.at(-1) === token) parts.pop();
  };
  const re = /<(\/?)(w:p|w:t|w:tab|w:br|w:cr|w:tc|w:tr)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
  for (const [, closing, tag, selfClosing, text] of xml.matchAll(re)) {
    if (text !== undefined) {
      if (inText) parts.push(decodeXml(text));
    } else if (tag === 'w:t') {
      inText = !closing && !selfClosing;
    } else if (closing) {
      if (tag === 'w:p') {
        parts.push(cellDepth ? ' ' : '\n'); // paragraphs inside a table cell stay on one line
      } else if (tag === 'w:tc') {
        dropLast(' ');
        parts.push('\t');
        cellDepth = Math.max(0, cellDepth - 1);
      } else if (tag === 'w:tr') {
        dropLast('\t');
        parts.push('\n');
      }
    } else if (tag === 'w:tc' && !selfClosing) {
      cellDepth++;
    } else if (tag === 'w:tab') {
      parts.push('\t');
    } else if (tag === 'w:br' || tag === 'w:cr') {
      parts.push('\n');
    }
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeXml(text) {
  return text.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/gi, (_, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const key = code.toLowerCase();
    if (key in named) return named[key];
    const n = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}
