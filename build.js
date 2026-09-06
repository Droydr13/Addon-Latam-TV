const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const ADDON_LOGO = 'https://archive.org/download/liddoy_20260714/ppped1d0s/logo.png';
const OUT_DIR = __dirname;


const CANVAS_W = 800;
const CANVAS_H = 450;

const LOGO_MAX_FRACTION = 0.82;

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


async function buildFallbackCard(ch, id) {
  const canvas = new Jimp(CANVAS_W, CANVAS_H, DARK_BG);
  const fontSize = ch.name.length > 16 ? Jimp.FONT_SANS_32_WHITE : Jimp.FONT_SANS_64_WHITE;
  const font = await Jimp.loadFont(fontSize);
  canvas.print(
    font,
    40, 0,
    {
      text: ch.name,
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
      alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
    },
    CANVAS_W - 80, CANVAS_H
  );
  const outPath = path.join(OUT_DIR, 'logos', `${id}.png`);
  await canvas.writeAsync(outPath);
  return `logos/${id}.png`;
}


async function buildChannelImage(ch, id) {
  let logoImg;
  try {
    logoImg = await Jimp.read(ch.logo);
  } catch (e) {
    console.warn(`  ! No pude bajar/leer el logo de "${ch.name}" (${ch.logo}) — genero tarjeta de texto en su lugar. Motivo: ${e.message}`);
    return await buildFallbackCard(ch, id);
  }

  const luminance = averageLuminance(logoImg);
  const bg = luminance < 128 ? LIGHT_BG : DARK_BG;

  
  try {
    logoImg.autocrop({ tolerance: 0.02, cropSymmetric: false, leaveBorder: 0 });
  } catch (e) {
    
  }

  const canvas = new Jimp(CANVAS_W, CANVAS_H, bg);

  const maxW = CANVAS_W * LOGO_MAX_FRACTION;
  const maxH = CANVAS_H * LOGO_MAX_FRACTION;
  
  const scale = Math.min(maxW / logoImg.bitmap.width, maxH / logoImg.bitmap.height, 4);
  logoImg.scale(scale, Jimp.RESIZE_BICUBIC);

  const x = Math.round((CANVAS_W - logoImg.bitmap.width) / 2);
  const y = Math.round((CANVAS_H - logoImg.bitmap.height) / 2);
  canvas.composite(logoImg, x, y);

  const outPath = path.join(OUT_DIR, 'logos', `${id}.png`);
  await canvas.writeAsync(outPath);
  return `logos/${id}.png`;
}


async function buildFondoMosaico(rutasLogos) {
  if (rutasLogos.length === 0) return null;

  const CANVAS_W = 1920, CANVAS_H = 1080;
  const COLS = 6, ROWS = 6; 
  const GAP = 6;

  const barajadas = [...rutasLogos];
  for (let i = barajadas.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [barajadas[i], barajadas[j]] = [barajadas[j], barajadas[i]];
  }

  const celdaW = Math.floor((CANVAS_W - GAP * (COLS + 1)) / COLS);
  const celdaH = Math.floor((CANVAS_H - GAP * (ROWS + 1)) / ROWS);
  const canvas = new Jimp(CANVAS_W, CANVAS_H, 0x0a0a0aFF);

  let idx = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const archivo = barajadas[idx % barajadas.length];
      idx++;
      try {
        const tile = await Jimp.read(archivo);
        
        tile.contain(celdaW, celdaH);
        const x = GAP + c * (celdaW + GAP);
        const y = GAP + r * (celdaH + GAP);
        canvas.composite(tile, x, y);
      } catch (e) {
        
      }
    }
  }

  canvas.brightness(-0.25);
  canvas.contrast(0.1);

  
  const vineta = new Jimp(CANVAS_W, CANVAS_H, 0x00000000);
  const grosor = 220;
  vineta.scan(0, 0, CANVAS_W, CANVAS_H, function (x, y, i2) {
    const distBorde = Math.min(x, y, CANVAS_W - x, CANVAS_H - y);
    if (distBorde < grosor) {
      const t = 1 - (distBorde / grosor);
      this.bitmap.data[i2 + 0] = 229;
      this.bitmap.data[i2 + 1] = 9;
      this.bitmap.data[i2 + 2] = 20;
      this.bitmap.data[i2 + 3] = Math.round(180 * Math.pow(t, 1.6));
    }
  });
  canvas.composite(vineta, 0, 0);

  
  const degrade = new Jimp(CANVAS_W, CANVAS_H, 0x00000000);
  degrade.scan(0, 0, CANVAS_W, CANVAS_H, function (x, y, i2) {
    const t = y / CANVAS_H;
    if (t > 0.35) {
      const alpha = Math.round(255 * ((t - 0.35) / 0.65) * 0.85);
      this.bitmap.data[i2 + 0] = 0;
      this.bitmap.data[i2 + 1] = 0;
      this.bitmap.data[i2 + 2] = 0;
      this.bitmap.data[i2 + 3] = alpha;
    }
  });
  canvas.composite(degrade, 0, 0);

  const outPath = path.join(OUT_DIR, 'fondo', 'fondo-canales.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await canvas.writeAsync(outPath);
  return 'fondo/fondo-canales.png';
}


function cargarDescripciones() {
  const rutaPosible = path.join(OUT_DIR, 'descripciones-canales.json');
  if (!fs.existsSync(rutaPosible)) return {};
  try {
    return JSON.parse(fs.readFileSync(rutaPosible, 'utf8'));
  } catch (e) {
    console.warn('descripciones-canales.json existe pero no se pudo leer (JSON invalido) -- se usa la descripcion generica para todos. Detalle:', e.message);
    return {};
  }
}

async function main() {

  const m3uPath = findM3UFile(__dirname);
  console.log(`Lista encontrada en: ${path.relative(__dirname, m3uPath)}`);
  const content = fs.readFileSync(m3uPath, 'utf8');
  const channels = parseM3U(content);

  console.log(`Líneas de canal encontradas: ${channels.length}`);

  
  const gruposPorClave = new Map(); 
  for (const ch of channels) {
    const clave = ch.tvgId
      ? `tvgid:${ch.tvgId}`
      : `nombre:${slugify(ch.name.replace(/\s*OP\d+$/i, ''))}`;
    if (!gruposPorClave.has(clave)) gruposPorClave.set(clave, []);
    gruposPorClave.get(clave).push(ch);
  }
  const grupos = [...gruposPorClave.values()];
  console.log(`Canales únicos tras agrupar variantes (OP2/OP3/...): ${grupos.length}`);

  
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
  
  const CACHE_BUST = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 8) : String(Date.now());

  const usedIds = new Set();
  const metas = [];
  const VALID_SHAPES = ['landscape', 'poster', 'square'];
  const descripciones = cargarDescripciones();
  const logosGeneradosParaFondo = [];

  for (const opciones of grupos) {
    
    const base = opciones.find(o => !/\s*OP\d+$/i.test(o.name)) || opciones[0];

    const shape = VALID_SHAPES.includes(base.shape) ? base.shape : 'landscape';
    let baseId = slugify(base.tvgId || base.name);
    let id = `addonlatam-canal-${baseId}`;
    let n = 2;
    while (usedIds.has(id)) {
      id = `addonlatam-canal-${baseId}-${n++}`;
    }
    usedIds.add(id);

    console.log(`- Procesando logo: ${base.name}${opciones.length > 1 ? ` (${opciones.length} opciones)` : ''}`);
    const relLogoPath = await buildChannelImage(base, id);
    const finalLogo = (relLogoPath && RAW_BASE) ? `${RAW_BASE}/${relLogoPath}?v=${CACHE_BUST}` : base.logo;
    if (relLogoPath) logosGeneradosParaFondo.push(path.join(OUT_DIR, relLogoPath));

    const descripcionManual = descripciones[id];
    const descripcionFinal = descripcionManual
      ? `${descripcionManual} Vía Addon Latam.`
      : `Canal en vivo — ${base.name}${base.country ? ' (' + base.country + ')' : ''}. Vía Addon Latam.`;

    const meta = {
      id,
      type: 'tv',
      name: base.name,
      poster: finalLogo,
      logo: finalLogo,
      background: finalLogo,
      posterShape: shape,
      genres: base.group ? [base.group] : undefined,
      description: descripcionFinal
    };

    metas.push(meta);

    fs.writeFileSync(
      path.join(OUT_DIR, 'meta', 'tv', `${id}.json`),
      JSON.stringify({ meta }, null, 2)
    );

   
    fs.writeFileSync(
      path.join(OUT_DIR, 'stream', 'tv', `${id}.json`),
      JSON.stringify({ streams: opciones.map(o => ({ title: o.name, url: o.url })) }, null, 2)
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

  
  console.log('Armando el mosaico de fondo compartido...');
  const relFondo = await buildFondoMosaico(logosGeneradosParaFondo);
  if (relFondo && RAW_BASE) {
    const fondoUrl = `${RAW_BASE}/${relFondo}?v=${CACHE_BUST}`;
    for (const m of metas) {
      m.background = fondoUrl;
      fs.writeFileSync(
        path.join(OUT_DIR, 'meta', 'tv', `${m.id}.json`),
        JSON.stringify({ meta: m }, null, 2)
      );
    }
    console.log(`Fondo aplicado a los ${metas.length} canales: ${relFondo}`);
  } else if (relFondo) {
    console.warn('Fondo generado en fondo/fondo-canales.png, pero corriendo local sin GITHUB_REPOSITORY no se pudo armar su URL -- cada canal se queda con su propio logo como fondo hasta que esto corra en GitHub Actions.');
  }

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

  console.log(`Listo. ${grupos.length} canales generados en la raíz del repo (a partir de ${channels.length} líneas del M3U).`);
}

main().catch(err => {
  console.error('Falló el build:', err);
  process.exit(1);
});
