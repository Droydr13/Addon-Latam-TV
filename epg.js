const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

const SOURCES = [
  'https://epgshare01.online/epgshare01/epg_ripper_MX1.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_SV1.xml.gz'
];
const LIST_DIR = path.join(__dirname, 'github', 'build', 'test', 'disk', 'space', '0000', 'cont', 'disk');
const M3U_HEAD = '#EXT' + 'M3U';
const INFO_LINE = '#EXT' + 'INF';
const OUT_FILE = path.join(__dirname, 'epg', 'guia.xml');
const PAST_HOURS = 6;
const FUTURE_HOURS = 48;

function readWanted() {
  const wanted = new Set();
  const files = fs.existsSync(LIST_DIR) ? fs.readdirSync(LIST_DIR) : [];
  for (const name of files) {
    const full = path.join(LIST_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (!text.trimStart().startsWith(M3U_HEAD)) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith(INFO_LINE)) continue;
      const id = (line.match(/tvg-id="([^"]*)"/) || [])[1];
      const name2 = (line.match(/,(.*)$/) || [])[1];
      if (id && id.trim()) wanted.add(id.trim().toLowerCase());
      if (name2 && name2.trim()) wanted.add(name2.trim().toLowerCase());
    }
  }
  return wanted;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')'));
  if (!m) return '';
  return m[2] !== undefined ? m[2] : m[3];
}

function xmltvTime(v) {
  const m = String(v).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return NaN;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    const off = (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * 60000;
    t -= sign * off;
  }
  return t;
}

function open(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (EPG filter)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(open(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(url + ' -> HTTP ' + res.statusCode));
        return;
      }
      resolve(res);
    });
    req.setTimeout(120000, () => req.destroy(new Error(url + ' -> timeout')));
    req.on('error', reject);
  });
}

async function readSource(url, wanted, state, from, to) {
  const res = await open(url);
  const stream = url.toLowerCase().split('?')[0].endsWith('.gz') ? res.pipe(zlib.createGunzip()) : res;
  stream.setEncoding('utf8');
  const alias = new Map();
  const mine = new Set();
  let buf = '';
  let channels = 0;
  let programmes = 0;

  function resolveId(rawId) {
    const low = unescapeXml(rawId).trim().toLowerCase();
    if (alias.has(low)) return alias.get(low);
    return wanted.has(low) ? low : '';
  }

  function handleChannel(block) {
    const open1 = block.slice(0, block.indexOf('>') + 1);
    const id = attr(open1, 'id');
    if (!id) return;
    const low = unescapeXml(id).trim().toLowerCase();
    let keep = wanted.has(low);
    const names = [...block.matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map(m => unescapeXml(m[1]).trim().toLowerCase());
    if (!keep) {
      const hit = names.find(n => wanted.has(n));
      if (hit) {
        alias.set(low, low);
        keep = true;
      }
    } else {
      alias.set(low, low);
    }
    if (!keep) return;
    if (state.owner.has(low) && state.owner.get(low) !== url) return;
    state.owner.set(low, url);
    mine.add(low);
    if (!state.channelXml.has(low)) {
      state.channelXml.set(low, block);
      channels++;
    }
  }

  function handleProgramme(block) {
    const open1 = block.slice(0, block.indexOf('>') + 1);
    const raw = attr(open1, 'channel');
    if (!raw) return;
    const low = unescapeXml(raw).trim().toLowerCase();
    if (!mine.has(low)) {
      if (!wanted.has(low) || (state.owner.has(low) && state.owner.get(low) !== url)) return;
      state.owner.set(low, url);
      mine.add(low);
    }
    const stop = xmltvTime(attr(open1, 'stop'));
    const start = xmltvTime(attr(open1, 'start'));
    if (!(stop > from) || !(start < to)) return;
    state.programmes.push(block);
    programmes++;
  }

  for await (const chunk of stream) {
    buf += chunk;
    let pos = 0;
    while (true) {
      const c = buf.indexOf('<channel', pos);
      const p = buf.indexOf('<programme', pos);
      let start = -1;
      let kind = '';
      if (c >= 0 && (p < 0 || c < p)) { start = c; kind = 'channel'; }
      else if (p >= 0) { start = p; kind = 'programme'; }
      if (start < 0) { pos = Math.max(pos, buf.length - 12); break; }
      const endTag = '</' + kind + '>';
      const end = buf.indexOf(endTag, start);
      const selfEnd = buf.indexOf('/>', start);
      const tagEnd = buf.indexOf('>', start);
      if (tagEnd < 0) { pos = start; break; }
      let block;
      if (selfEnd >= 0 && selfEnd + 1 === tagEnd) {
        block = buf.slice(start, tagEnd + 1);
        pos = tagEnd + 1;
      } else {
        if (end < 0) { pos = start; break; }
        block = buf.slice(start, end + endTag.length);
        pos = end + endTag.length;
      }
      if (kind === 'channel') handleChannel(block); else handleProgramme(block);
    }
    buf = buf.slice(pos);
  }
  return { channels, programmes };
}

async function main() {
  const wanted = readWanted();
  if (wanted.size === 0) throw new Error('No channels found in ' + LIST_DIR);
  const now = Date.now();
  const from = now - PAST_HOURS * 3600000;
  const to = now + FUTURE_HOURS * 3600000;
  const state = { owner: new Map(), channelXml: new Map(), programmes: [] };
  let ok = 0;
  for (const url of SOURCES) {
    try {
      const r = await readSource(url, wanted, state, from, to);
      console.log(url + ': ' + r.channels + ' channels, ' + r.programmes + ' programmes');
      ok++;
    } catch (e) {
      console.log('Failed ' + url + ': ' + e.message);
    }
  }
  if (ok === 0) throw new Error('No guide could be downloaded');
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Addon Latam EPG">'];
  for (const block of state.channelXml.values()) parts.push(block);
  for (const block of state.programmes) parts.push(block);
  parts.push('</tv>', '');
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, parts.join('\n'));
  const size = fs.statSync(OUT_FILE).size;
  console.log('Wrote ' + OUT_FILE + ': ' + state.channelXml.size + ' channels, ' + state.programmes.length + ' programmes, ' + (size / 1048576).toFixed(2) + ' MB, ' + wanted.size + ' ids and names in the list');
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
