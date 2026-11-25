#!/usr/bin/env node
/*
 * Builds an unpacked extension and a Chrome Web Store / Edge Add-ons
 * compatible ZIP with no external dependencies.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'unpacked');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function collectFiles(directory, base = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute, base)));
    } else if (entry.isFile()) {
      files.push({
        absolute,
        name: path.relative(base, absolute).split(path.sep).join('/'),
      });
    }
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  const { time, date } = dosDateTime();
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(await fs.readFile(file.absolute));
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const body = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function validateProject() {
  const manifestPath = path.join(SRC, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  if (manifest.manifest_version !== 3) {
    throw new Error('manifest.json must be Manifest V3');
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`Invalid manifest version: ${manifest.version}`);
  }
  if (!manifest.default_locale) {
    throw new Error('manifest.json is missing default_locale');
  }

  const packageJson = JSON.parse(
    await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')
  );
  if (packageJson.version !== manifest.version) {
    throw new Error(
      `package.json version ${packageJson.version} does not match manifest version ${manifest.version}`
    );
  }

  const localeRoot = path.join(SRC, '_locales');
  const localeEntries = await fs.readdir(localeRoot, { withFileTypes: true });
  const locales = localeEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (!locales.includes(manifest.default_locale)) {
    throw new Error(`Missing default locale: ${manifest.default_locale}`);
  }

  const messagesByLocale = new Map();
  for (const locale of locales) {
    const messagesPath = path.join(localeRoot, locale, 'messages.json');
    const messages = JSON.parse(await fs.readFile(messagesPath, 'utf8'));
    messagesByLocale.set(locale, messages);
  }

  const defaultMessages = messagesByLocale.get(manifest.default_locale);
  const defaultKeys = Object.keys(defaultMessages).sort();

  for (const [locale, messages] of messagesByLocale) {
    const keys = Object.keys(messages).sort();
    const missing = defaultKeys.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !defaultKeys.includes(key));
    if (missing.length || extra.length) {
      throw new Error(
        `Locale ${locale} key mismatch. Missing: ${missing.join(', ') || 'none'}. Extra: ${extra.join(', ') || 'none'}`
      );
    }
    for (const key of keys) {
      if (!messages[key] || typeof messages[key].message !== 'string') {
        throw new Error(`Locale ${locale} has an invalid message: ${key}`);
      }
    }
  }

  const manifestText = JSON.stringify(manifest);
  for (const match of manifestText.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) {
    if (!defaultMessages[match[1]]) {
      throw new Error(`Manifest references missing message: ${match[1]}`);
    }
  }

  const popupHtml = await fs.readFile(path.join(SRC, 'popup.html'), 'utf8');
  for (const match of popupHtml.matchAll(/data-i18n="([^"]+)"/g)) {
    if (!defaultMessages[match[1]]) {
      throw new Error(`popup.html references missing message: ${match[1]}`);
    }
  }

  for (const [size, relativePath] of Object.entries(manifest.icons)) {
    if (!relativePath) throw new Error(`Missing icon size ${size}`);
    await fs.access(path.join(SRC, relativePath));
  }
  for (const [size, relativePath] of Object.entries(manifest.action.default_icon)) {
    if (!relativePath) throw new Error(`Missing action icon size ${size}`);
    await fs.access(path.join(SRC, relativePath));
  }

  for (const file of ['content.js', 'popup.js']) {
    const source = await fs.readFile(path.join(SRC, file), 'utf8');
    new vm.Script(source, { filename: file });
  }

  return { manifest, locales };
}

async function main() {
  const { manifest, locales } = await validateProject();

  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(UNPACKED, { recursive: true });

  for (const entry of await fs.readdir(SRC, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    await fs.cp(path.join(SRC, entry.name), path.join(UNPACKED, entry.name), {
      recursive: true,
    });
  }

  const files = await collectFiles(UNPACKED);
  const zip = await makeZip(files);
  const zipName = `youtube-auto-click-translate-v${manifest.version}.zip`;
  const zipPath = path.join(DIST, zipName);
  await fs.writeFile(zipPath, zip);
  await fs.writeFile(
    path.join(DIST, 'build-info.txt'),
    `version=${manifest.version}\nfiles=${files.length}\nzip=${zipName}\nlocales=${locales.join(',')}\n`
  );

  console.log(`Built ${zipName}`);
  console.log(`Files: ${files.length}`);
  console.log(`Locales: ${locales.length} (${locales.join(', ')})`);
  console.log(`ZIP size: ${(zip.length / 1024).toFixed(1)} KiB`);
  console.log(`Unpacked: ${path.relative(ROOT, UNPACKED)}`);
}

main().catch((error) => {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
});
