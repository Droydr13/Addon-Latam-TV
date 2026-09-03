const fs = require('fs');
const path = require('path');

const ADDON_LOGO = 'https://archive.org/download/liddoy_20260714/ppped1d0s/logo.png';

const OUT_DIR = __dirname;

function slugify(str) {
  return String(str)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U') || line.startsWith('#EXTVLCOPT') || line.startsWith('# ')) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
      let m;
      while ((m = attrRegex.exec(line))) {
        attrs[m[1]] = m[2];
      }
      const nameMatch = line.match(/,(.*)$/);
      const name = nameMatch ? nameMatch[1].trim() : 'Canal sin nombre';

      current = {
        name,
        tvgId: attrs['tvg-id'] || '',
        tvgName: attrs['tvg-name'] || name,
        logo: attrs['tvg-logo'] || ADDON_LOGO,
        group: attrs['group-title'] || 'General',
        country: attrs['tvg-country'] || '',
        shape: (attrs['tvg-shape'] || 'landscape').toLowerCase()
      };
    } else if (line.startsWith('#')) {
      continue; 
    } else {
      
      if (current) {
        current.url = line;
        channels.push(current);
        current = null;
      }
    }
  }
  return channels;
}

function findM3UFile(dir) {
  const IGNORED_DIRS = new Set(['node_modules', 'catalog', 'meta', 'stream']);
  const candidates = [];

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; 
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (stat.size > 5 * 1024 * 1024) continue; 
        let content;
        try { content = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
        if (content.indexOf('\u0000') !== -1) continue; 
        const extinfCount = (content.match(/#EXTINF/g) || []).length;
        if (content.trimStart().startsWith('#EXTM3U') || extinfCount > 0) {
          candidates.push({ path: full, extinfCount });
        }
      }
    }
  }

  walk(dir);
  if (candidates.length === 0) {
    throw new Error('No encontré ningún archivo con formato M3U en el repo (ni #EXTM3U ni líneas #EXTINF).');
  }
  candidates.sort((a, b) => b.extinfCount - a.extinfCount);
  return candidates[0].path;
}

function main() {
  const m3uPath = findM3UFile(__dirname);
  console.log(`Lista encontrada en: ${path.relative(__dirname, m3uPath)}`);
  const content = fs.readFileSync(m3uPath, 'utf8');
  const channels = parseM3U(content);

  console.log(`Canales encontrados: ${channels.length}`);

  // limpiar solo las carpetas generadas (nunca la raíz entera, ahí
  // viven list.m3u, build.js, el workflow y el resto del repo)
  fs.rmSync(path.join(OUT_DIR, 'meta'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT_DIR, 'stream'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT_DIR, 'catalog'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, 'meta', 'tv'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'stream', 'tv'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'catalog', 'tv'), { recursive: true });

  const usedIds = new Set();
  const metas = [];

  const VALID_SHAPES = ['landscape', 'poster', 'square'];

  for (const ch of channels) {
    const shape = VALID_SHAPES.includes(ch.shape) ? ch.shape : 'landscape';
    let baseId = slugify(ch.tvgId || ch.name);
    let id = `addonlatam-canal-${baseId}`;
    let n = 2;
    while (usedIds.has(id)) {
      id = `addonlatam-canal-${baseId}-${n++}`;
    }
    usedIds.add(id);

    const meta = {
      id,
      type: 'tv',
      name: ch.name,
      poster: ch.logo,
      logo: ch.logo,
      background: ch.logo,
      posterShape: shape,
      genres: ch.group ? [ch.group] : undefined,
      description: `Canal en vivo — ${ch.name}${ch.country ? ' (' + ch.country + ')' : ''}. Vía Addon Latam.`
    };

    metas.push(meta);

    
    fs.writeFileSync(
      path.join(OUT_DIR, 'meta', 'tv', `${id}.json`),
      JSON.stringify({ meta }, null, 2)
    );

    
    fs.writeFileSync(
      path.join(OUT_DIR, 'stream', 'tv', `${id}.json`),
      JSON.stringify({ streams: [{ title: ch.name, url: ch.url }] }, null, 2)
    );
  }

  
  fs.writeFileSync(
    path.join(OUT_DIR, 'catalog', 'tv', 'addonlatam-canales.json'),
    JSON.stringify({
      metas: metas.map(m => ({
        id: m.id,
        type: 'tv',
        name: m.name,
        poster: m.poster,
        posterShape: m.posterShape,
        genres: m.genres
      }))
    }, null, 2)
  );

  // manifest.json
  const manifest = {
    id: 'community.addonlatam.canales',
    version: '1.0.0',
    name: 'Addon Latam - Canales',
    description: 'Complemento de Addon Latam para ver canales en vivo',
    logo: ADDON_LOGO,
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: ['addonlatam-canal-'],
    catalogs: [
      {
        type: 'tv',
        id: 'addonlatam-canales',
        name: 'Addon Latam - Canales'
      }
    ],
    behaviorHints: {
      configurable: false
    }
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.log(`Listo. ${channels.length} canales generados en la raíz del repo.`);
  console.log(`IDs duplicados evitados automáticamente cuando dos canales compartían tvg-id/nombre.`);
}

main();
