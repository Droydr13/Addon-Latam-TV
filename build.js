const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const ADDON_LOGO = 'https://archive.org/download/liddoy_20260714/ppped1d0s/logo.png';
const OUT_DIR = __dirname;


const CANVAS_W = 800;
const CANVAS_H = 450;

const LOGO_MAX_FRACTION = 0.72;

const LIGHT_BG = 0xF2F2F2FF; 
const DARK_BG = 0x161616FF;  

function slugify(str) {
  return String(str)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') 
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
  const IGNORED_DIRS = new Set(['node_modules', 'catalog', 'meta', 'stream', 'logos']);
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


function averageLuminance(img) {
  let total = 0;
  let count = 0;
  img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
    const alpha = this.bitmap.data[idx + 3];
    if (alpha < 40) return; 
    const r = this.bitmap.data[idx];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    total += 0.299 * r + 0.587 * g + 0.114 * b;
    count++;
  });
  if (count === 0) return 128; 
  return total / count;
}


async function buildChannelImage(ch, id) {
  let logoImg;
  try {
    logoImg = await Jimp.read(ch.logo);
  } catch (e) {
    console.warn(`  ! No pude bajar el logo de "${ch.name}" (${ch.logo}) — sigue con el original. Motivo: ${e.message}`);
    return null;
  }

  const luminance = averageLuminance(logoImg);
  const bg = luminance < 128 ? LIGHT_BG : DARK_BG;

  const canvas = new Jimp(CANVAS_W, CANVAS_H, bg);

  const maxW = CANVAS_W * LOGO_MAX_FRACTION;
  const maxH = CANVAS_H * LOGO_MAX_FRACTION;
  const scale = Math.min(maxW / logoImg.bitmap.width, maxH / logoImg.bitmap.height, 1);
  logoImg.scale(scale);

  const x = Math.round((CANVAS_W - logoImg.bitmap.width) / 2);
  const y = Math.round((CANVAS_H - logoImg.bitmap.height) / 2);
  canvas.composite(logoImg, x, y);

  const outPath = path.join(OUT_DIR, 'logos', `${id}.png`);
  await canvas.writeAsync(outPath);
  return `logos/${id}.png`;
}

async function main() {
  const m3uPath = findM3UFile(__dirname);
  console.log(`Lista encontrada en: ${path.relative(__dirname, m3uPath)}`);
  const content = fs.readFileSync(m3uPath, 'utf8');
  const channels = parseM3U(content);

  console.log(`Canales encontrados: ${channels.length}`);

  
  fs.rmSync(path.join(OUT_DIR, 'meta'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT_DIR, 'stream'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT_DIR, 'catalog'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT_DIR, 'logos'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, 'meta', 'tv'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'stream', 'tv'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'catalog', 'tv'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'logos'), { recursive: true });

  
  const repoSlug = process.env.GITHUB_REPOSITORY; 
  const branch = process.env.GITHUB_REF_NAME || 'main';
  const RAW_BASE = repoSlug ? `https://raw.githubusercontent.com/${repoSlug}/${branch}` : null;
  if (!RAW_BASE) {
    console.warn('Corriendo local sin GITHUB_REPOSITORY: los logos se generan igual en logos/, pero el manifest va a usar la URL del logo original hasta que esto corra dentro de GitHub Actions (ahí arma la URL sola).');
  }

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

    console.log(`- Procesando logo: ${ch.name}`);
    const relLogoPath = await buildChannelImage(ch, id);
    const finalLogo = (relLogoPath && RAW_BASE) ? `${RAW_BASE}/${relLogoPath}` : ch.logo;

    const meta = {
      id,
      type: 'tv',
      name: ch.name,
      poster: finalLogo,
      logo: finalLogo,
      background: finalLogo,
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

main().catch(err => {
  console.error('Falló el build:', err);
  process.exit(1);
});
