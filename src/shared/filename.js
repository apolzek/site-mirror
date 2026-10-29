/** ASCII-only, filesystem-safe slug. */
export function slugify(text, maxLength = 80) {
  const slug = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, maxLength)
    .replace(/[-.]+$/, '');
  return slug || 'site';
}

export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_` +
    `${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

/** e.g. mirror_example.com_2026-10-29_10-36-25.zip */
export function makeFilename(url, date = new Date()) {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    /* not a URL */
  }
  return `mirror_${slugify(host)}_${timestamp(date)}.zip`;
}
