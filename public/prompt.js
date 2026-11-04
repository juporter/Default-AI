// Turning a prompt plus attached files into the text sent to every model.

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 2_000_000;

const BINARY_NAME = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|png|jpe?g|gif|webp|heic|bmp|ico|tiff?|zip|gz|tgz|7z|rar|mp3|m4a|wav|ogg|mp4|mov|avi|mkv|exe|dll|bin|dmg|iso)$/i;
const BINARY_TYPE = /^(image|audio|video)\/|^application\/(pdf|zip|x-zip|msword|vnd\.)/i;

/** Why a file can't be attached, or '' if it can (before reading it). */
export function checkFile(file, alreadyAttachedBytes) {
  if (BINARY_NAME.test(file.name) || BINARY_TYPE.test(file.type || '')) {
    return `${file.name}: only text files can be attached (not PDFs, Word files, images or archives).`;
  }
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than 1 MB.`;
  if (alreadyAttachedBytes + file.size > MAX_TOTAL_BYTES) return `${file.name}: attachments are limited to 2 MB in total.`;
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
