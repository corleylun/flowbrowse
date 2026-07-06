/**
 * Domain keying for recipes ("memory follows the domain, not the container"). Recipes are
 * grouped by REGISTRABLE domain so a recipe recorded on www.x.com also shows on mobile.x.com
 * — the same way a login session usually spans subdomains.
 */

// Common multi-part public suffixes. NOT a full Public Suffix List (that needs a bundled
// dataset + periodic updates); this shortlist covers the cases a dev beachhead actually hits.
// When a host ends in one of these, the registrable domain keeps THREE labels (foo.co.uk),
// otherwise TWO (x.com).
const MULTI_PART_TLDS = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'co.jp',
  'com.au',
  'net.au',
  'org.au',
  'com.br',
  'com.cn',
  'co.in',
  'co.nz',
  'co.za',
  'com.sg',
  'com.hk',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The registrable domain for a page URL, used as the recipe memory key. Returns '' for pages
 * that have no meaningful web origin (about:blank, file://, chrome://, data:, bad URLs) — the
 * UI disables recording/saving there.
 */
export function domainForUrl(url: string): string {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    host = u.hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host) return '';

  // localhost and bare IPs have no registrable domain — key by the host itself.
  if (host === 'localhost' || IPV4.test(host) || host.includes(':')) return host;

  if (host.startsWith('www.')) host = host.slice(4);

  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');

  const lastTwo = labels.slice(-2).join('.');
  const keep = MULTI_PART_TLDS.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * A filesystem-safe subdirectory name for a domain. Domains are already constrained (letters,
 * digits, dots, hyphens, colons for IPv6/port-ish hosts), but sanitize defensively so a crafted
 * URL can never traverse out of the recipes directory.
 */
export function domainSlug(domain: string): string {
  const s = domain
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-') // drop anything not domain-ish (incl. path separators, colons)
    .replace(/\.{2,}/g, '.') // collapse '..' so it can't mean "parent dir"
    .replace(/^[.-]+|[.-]+$/g, '') // no leading/trailing dots or dashes
    .slice(0, 100);
  return s || 'unknown';
}
