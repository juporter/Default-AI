// Turning a prompt plus attached files into the text sent to every model.

// Text files, and the text taken out of a PDF or Word file, count toward these.
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 2_000_000;
// PDF and Word files themselves (their text is extracted on the server).
export const MAX_DOCUMENT_BYTES = 20_000_000;

export const DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const BINARY_NAME = /\.(xlsx?|pptx?|odt|ods|odp|rtf|pages|key|numbers|png|jpe?g|gif|webp|heic|bmp|ico|tiff?|zip|gz|tgz|7z|rar|mp3|m4a|wav|ogg|mp4|mov|avi|mkv|exe|dll|bin|dmg|iso)$/i;
const BINARY_TYPE = /^(image|audio|video)\/|^application\/(zip|x-zip|vnd\.(ms-|openxmlformats-officedocument\.(spreadsheet|presentation)))/i;

/** PDF and Word (.docx) files, whose text the server extracts. */
export function isDocument(file) {
  return /\.(pdf|docx)$/i.test(file.name) || file.type === DOCUMENT_TYPES.pdf || file.type === DOCUMENT_TYPES.docx;
}

/** The type to send a document to /api/extract with. */
export function documentType(file) {
  if (file.type === DOCUMENT_TYPES.pdf || file.type === DOCUMENT_TYPES.docx) return file.type;
  if (/\.pdf$/i.test(file.name)) return DOCUMENT_TYPES.pdf;
  if (/\.docx$/i.test(file.name)) return DOCUMENT_TYPES.docx;
  return 'application/octet-stream';
}

/** Why a file can't be attached, or '' if it can (before reading it). */
export function checkFile(file, alreadyAttachedBytes) {
  if (/\.doc$/i.test(file.name) || file.type === 'application/msword') {
    return `${file.name} is an old Word file (.doc). Open it in Word and save it as .docx, then attach that.`;
  }
  if (isDocument(file)) return file.size > MAX_DOCUMENT_BYTES ? `${file.name} is larger than 20 MB.` : '';
  if (BINARY_NAME.test(file.name) || BINARY_TYPE.test(file.type || '')) {
    return `${file.name}: this kind of file can't be attached. Attach text files, PDFs or Word (.docx) files.`;
  }
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than 1 MB.`;
  if (alreadyAttachedBytes + file.size > MAX_TOTAL_BYTES) return `${file.name}: attachments are limited to 2 MB in total.`;
  return '';
}

/** Size of text in bytes, as it will be sent. */
export function textBytes(text) {
  return new TextEncoder().encode(text).length;
}

/** Why the text taken from a document can't be attached, or ''. */
export function checkText(name, text, alreadyAttachedBytes) {
  const size = textBytes(text);
  if (size > MAX_FILE_BYTES) return `${name} has more than 1 MB of text. Attach a shorter document or a few pages of it.`;
  if (alreadyAttachedBytes + size > MAX_TOTAL_BYTES) return `${name}: attachments are limited to 2 MB of text in total.`;
  return '';
}

/** Text with NUL characters is almost certainly binary. */
export function looksBinary(text) {
  return text.includes('\u0000');
}

/**
 * The prompt followed by each file in a fenced block. The fence is longer
 * than any run of backticks inside the file, so file contents can't end it.
 */
export function buildPrompt(prompt, attachments = []) {
  if (!attachments.length) return prompt;
  const blocks = attachments.map((file) => {
    let longest = 2;
    for (const match of file.text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    const fence = '`'.repeat(longest + 1);
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    const lang = /^[a-z0-9+#-]{1,15}$/.test(ext) ? ext : '';
    return `Attached file: ${file.name}\n${fence}${lang}\n${file.text}\n${fence}`;
  });
  return `${prompt}\n\n${blocks.join('\n\n')}`;
}
