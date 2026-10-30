// Bundled example content for the standalone website (no claude.ai shared database there):
// data/seed.json = { lives: [...real lives], stories: [...photo stories] }, photos under seed/*.jpg.
// Loaded once, only in local mode; a missing file simply means no examples.

let loaded = null;

export function loadSeed() {
  if (!loaded) {
    loaded = (async () => {
      try {
        if (typeof fetch !== 'function') return { lives: [], stories: [] };
        const r = await fetch('data/seed.json', { cache: 'no-cache' });
        if (!r.ok) return { lives: [], stories: [] };
        const d = await r.json();
        return { lives: Array.isArray(d.lives) ? d.lives : [], stories: Array.isArray(d.stories) ? d.stories : [] };
      } catch {
        return { lives: [], stories: [] };
      }
    })();
  }
  return loaded;
}

export const SEED_PHOTO_RE = /^seed\/[A-Za-z0-9_-]{1,40}\.jpg$/;

/** Image source for a stored photo reference: platform asset id or a bundled seed file. */
export function photoUrl(ref) {
  if (typeof ref !== 'string') return null;
  if (SEED_PHOTO_RE.test(ref)) return ref;
  if (/^[0-9a-f]{32}$/.test(ref)) return '/_blob/' + ref;
  return null;
}
