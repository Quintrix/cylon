//
// ──── Qandyland Server v2 ────────────────────────────────────────────────────
//

'use strict';

// Sysop Variables
var sysopOffline = true;            // only serves files to localHost
var sysopCardWidth = 160;           // "Front-and-back punch card" limit
var sysopGfx = 'cylon-desktop.gfx'; // default .gfx file

const UNIVAC   = require('./qandyland-univac.js');
const Krystals = require('./qandyland-krystals.js');
const DOS      = require('./qandyland-dos.js');
const Command  = require('./qandyland-command.js');

UNIVAC.inject({
  fileLoad:        DOS.fileLoad,
  fileSave:        DOS.fileSave,
  fileDelete:      DOS.fileDelete,
  fileList:        DOS.fileList,
  fileRename:      DOS.fileRename,
  futureTimestamp: DOS.futureTimestamp
});

var http   = require('http');
var https  = require('https');
var path   = require('path');
var fs     = require('fs');
var crypto = require('crypto');

// .env loader (no npm package required)
(function loadDotEnv() {
  var envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(function (line) {
    var m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) return;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });

})();

// ── CLI Arguments & Configuration ─────────────────────────────────────────────

function parseCliArgs(argv) {
  var cfg = {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 8080,
    serverId: process.env.SERVER_ID || null,
    cfgFile: process.env.QANDY_CFG || 'qandyland.cfg',
    mounts: []
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) {
      cfg.port = parseInt(argv[++i], 10) || cfg.port;
    } else if ((a === '--id' || a === '--server-id') && argv[i + 1]) {
      cfg.serverId = argv[++i];
    } else if (a === '--cfg' && argv[i + 1]) {
      cfg.cfgFile = argv[++i];
    } else if ((a === '--mount' || a === '-m') && argv[i + 1]) {
      cfg.mounts.push(argv[++i]);
    }
  }
  if (!cfg.serverId) cfg.serverId = 'qandy-' + cfg.port;
  return cfg;
}

var CLI_CONFIG     = parseCliArgs(process.argv.slice(2));
var PORT           = CLI_CONFIG.port;
var SERVER_ID      = CLI_CONFIG.serverId;
var SESSION_COOKIE = 'q';

var encodeZ = UNIVAC.encodeZ;
var decodeZ = UNIVAC.decodeZ;

var playerIndex = new Map();

// ── Request logging ───────────────────────────────────────────────────────────

function logRequest(req, method, drive, name, session, result) {
  var ts     = new Date().toISOString().slice(11, 19);
  var ip     = (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown')
    .replace('::ffff:', '').replace('::1', 'local').slice(0, 15);
  var action = (method  || '').slice(0, 8).padEnd(9);
  var drv    = (drive   || '-').slice(0, 8).padEnd(8);
  var file   = (name    || '-').slice(0, 12).padEnd(12);
  var sess   = (session || '').slice(0, 8).padEnd(8);
  var status = (result && result.success) ? 'SUCCESS' : 'FAILED';
  console.log('[' + ts + '] ' + ip.padEnd(15) + ' ' + action + ' ' + drv + ' ' + file + ' ' + sess + ' ' + status);
}

// ── Console display ───────────────────────────────────────────────────────────

var BOX_WIDTH = 62; // inner width between ║ characters

function _boxLine(text) {
  var s = (text == null ? '' : String(text));
  if (s.length > BOX_WIDTH) s = s.slice(0, BOX_WIDTH);
  return '║' + s + ' '.repeat(BOX_WIDTH - s.length) + '║';
}

function displayStartupBanner(publicIP, registryStatus, serverId) {
  var line = '═'.repeat(BOX_WIDTH);
  console.log('╔' + line + '╗');
  console.log(_boxLine('       QANDYLAND SERVER AND UNIVAC PUNCH CODE PROCESSOR '));
  console.log('╠' + line + '╣');

  console.log(_boxLine(''));

  var idStr   = 'Server ID: ' + (serverId || SERVER_ID).padEnd(20);
  var portStr = 'Port: ' + String(PORT).padEnd(10);
  var ipStr   = 'IP: ' + (publicIP || '(unknown)');
  console.log(_boxLine(' ' + idStr + ' ' + portStr + ' ' + ipStr));

  console.log(_boxLine(''));
  console.log(_boxLine(' Mounted Drives:'));

  var mountedRows = DOS.mounts();
  if (mountedRows.length === 0) {
    console.log(_boxLine('   (no drives mounted)'));
  } else {
    for (var i = 0; i < mountedRows.length; i++) {
      var r = mountedRows[i];
      var marker = r.current ? '*' : ' ';
      var mode = r.readOnly ? 'ro' : 'rw';
      var entry = ' ' + marker + ' ' + r.name.padEnd(15) + ' [' + r.type + '/' + mode + '] ' +
        '(' + r.count + ' files, ' + DOS.formatSize(r.used) + ')';
      console.log(_boxLine(entry));
    }
  }

  console.log(_boxLine(''));
  console.log(_boxLine(' Ready for connections...'));
  console.log('╚' + line + '╝');
  console.log('');
  console.log('[TIME    ] CLIENT          ACTION    DRIVE    FILE         SESSION  RESULT');
}

// ── HTTP Helpers & Static File Serving ────────────────────────────────────────

function getSession(req) {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    return reqUrl.searchParams.get('s') || req.headers['x-session-token'] || null;
  } catch (e) {
    return null;
  }
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total  = 0;
    req.on('data', function (chunk) {
      total += chunk.length;
      if (total > DOS.MAX_FILE_BYTES + 4096) {
        req.destroy();
        return reject(new Error('Request too large'));
      }
      chunks.push(chunk);
    });
    req.on('end',   function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function getIP(req) {
  var rawIp = req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
  var ip = rawIp.replace('::ffff:', '').replace('::1', '127.0.0.1').slice(0, 15);
  return ip;
}

var MIME = {
  '.html': 'text/html',
  '.htm':  'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.txt':  'text/plain',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

function serve404(res) {
  var errorPage = path.join(__dirname, '404.html');
  fs.stat(errorPage, function (err, stat) {
    if (!err && stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      fs.createReadStream(errorPage).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
  });
}

function respondRetro(res, text, session) {
  if (session) res.setHeader('X-Session-Token', session);
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end(String(text));
}

// ── bigbang() – GFX World Generation ─────────────────────────────────────────

function bigbang(driveName, sourceFile, session, rawOverride) {
  // Support legacy 2-arg call: bigbang(driveName, session)
  if (arguments.length <= 2 && typeof rawOverride === 'undefined') {
    session = sourceFile;
    sourceFile = driveName;
  }

  if (!DOS.getDrive(driveName)) return { success: false, error: 'drive not mounted: ' + driveName };

  var srcName = sourceFile || driveName;
  var raw = rawOverride;
  if (raw == null) {
    var gfxPath = path.resolve(process.cwd(), srcName);
    try {
      raw = fs.readFileSync(gfxPath, 'utf8');
    } catch (e) {
      return { success: false, error: 'cannot read ' + srcName + ': ' + (e.message || String(e)) };
    }
  }

  // --- Load matching legacy .qpc tapes file and queue valid entries for /q/ ---
  var VALID_QPC_TAG_RE = /^[a-z0-9]{3,}$/;
  var qpcEntries = [];
  if (!/^https?:\/\//i.test(srcName) && srcName.charAt(0) !== '{') {
    var qpcPath = path.resolve(process.cwd(), srcName.replace(/\.gfx$/i, '.qpc'));
    try {
      if (fs.existsSync(qpcPath)) {
        var rawQpc = fs.readFileSync(qpcPath, 'utf8');
        var qpcLines = rawQpc.split(/\r?\n/);
        for (var qi = 0; qi < qpcLines.length; qi++) {
          var qLine = qpcLines[qi].trim();
          if (!qLine) continue;
          var match = qLine.match(/^\[(.*?)\](.*)$/);
          if (match) {
            var tapeName = match[1];
            if (!VALID_QPC_TAG_RE.test(tapeName)) {
              console.warn('Skipping invalid QPC tag "' + tapeName + '" (must be >= 3 lowercase a-z / 0-9 chars)');
              continue;
            }
            var tapeCode = match[2]
              .replace(/_NL_/g, "\n")
              .replace(/\\n/g, "\n")
              .replace(/\\r/g, "")
              .replace(/\\\\/g, "\\") //
              .trim();
            qpcEntries.push({ name: tapeName, code: tapeCode });
          }
        }
      }
    } catch (e) {
      console.warn('Could not read QPC tapes file:', e.message);
    }
  }

  var lines = String(raw).split('\n');
  var sectors = [];
  var systemFiles = [];
  var playerCodes = [];

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li].trim();
    if (!line) continue;

    var eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;

    var sectorId = line.substring(0, eqIdx);
    var rest     = line.substring(eqIdx + 1);

    if (sectorId === '##') continue;

    if (sectorId.length === 1) {
      systemFiles.push({ id: sectorId, data: rest });
      continue;
    }

    var dotIdx   = rest.indexOf('.');
    var mapData  = dotIdx >= 0 ? rest.substring(0, dotIdx) : rest;
    var itemData = dotIdx >= 0 ? rest.substring(dotIdx + 1) : '';

    var tiles   = mapData.substring(0, 280);
    var exitStr = mapData.substring(280);

    var items = [];
    if (itemData) {
      var rawItems = itemData.split('~');
      for (var ri = 0; ri < rawItems.length; ri++) {
        var blob = rawItems[ri].trim();
        if (blob) items.push(blob);
      }
    }
    sectors.push({ id: sectorId, tiles: tiles, exits: exitStr, items: items });
  }

  if (sectors.length === 0) {
    return { success: false, error: srcName + ' contains no valid world sectors' };
  }

  var created = [];
  var errors  = [];

  var wDir = DOS.dirMake(driveName, '/', 'w', session);
  if (!wDir.success && wDir.error !== 'directory already exists') {
    return { success: false, error: 'failed to create /w/ directory: ' + wDir.error };
  }

  var pDir = DOS.dirMake(driveName, '/', 'p', session);
  if (!pDir.success && pDir.error !== 'directory already exists') {
    return { success: false, error: 'failed to create /p/ directory: ' + pDir.error };
  }

  var qDir = DOS.dirMake(driveName, '/', 'q', session);
  if (!qDir.success && qDir.error !== 'directory already exists') {
    return { success: false, error: 'failed to create /q/ directory: ' + qDir.error };
  }

  for (var qei = 0; qei < qpcEntries.length; qei++) {
    var qRes = DOS.fileSave(driveName, '/', 'q/' + qpcEntries[qei].name, qpcEntries[qei].code, 'UNIVAC', 'UNIVAC');
    if (!qRes.success) errors.push('q/' + qpcEntries[qei].name + ': ' + qRes.error);
  }

  for (var fi = 0; fi < systemFiles.length; fi++) {
    var sysFile = systemFiles[fi];
    var sysCode = String(sysFile.data || '')
      .replace(/_NL_/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "")
      .replace(/\\\\/g, "\\") //
      .trim();

    var sfResult = DOS.fileSave(driveName, '/', 'w/' + sysFile.id, sysCode, 'UNIVAC', 'UNIVAC');
    if (!sfResult.success) errors.push('w/' + sysFile.id + ': ' + sfResult.error);
  }

  for (var si = 0; si < sectors.length; si++) {
    var sector  = sectors[si];
    var dirPath = 'w/' + sector.id;

    var mkResult = DOS.dirMake(driveName, '/', dirPath, session);
    if (!mkResult.success && mkResult.error !== 'directory already exists') {
      errors.push('mkdir ' + dirPath + ': ' + mkResult.error);
      continue;
    }

    var mResult = DOS.fileSave(driveName, '/', dirPath + '/m', sector.tiles, session, 'bigbang');
    if (!mResult.success) errors.push(dirPath + '/m: ' + mResult.error);

    var eResult = DOS.fileSave(driveName, '/', dirPath + '/e', sector.exits, session, 'bigbang');
    if (!eResult.success) errors.push(dirPath + '/e: ' + eResult.error);

    for (var ii = 0; ii < sector.items.length; ii++) {
      var parts = sector.items[ii].split('|');
      var itemMeta = parts[0];
      var itemCode = String(parts[1] || '')
        .replace(/_NL_/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .trim();

      var iResult = DOS.fileSave(driveName, '/', dirPath + '/' + itemMeta, itemCode, '', 'bigbang');
      if (!iResult.success) errors.push(dirPath + '/' + itemMeta + ': ' + iResult.error);
    }

    created.push(sector.id);
  }

  if (errors.length > 0) {
    return { success: false, error: errors.join('; '), maps: created };
  }

  return {
    success: true,
    result:  'World created: ' + created.length + ' sector(s), ' + playerCodes.length + ' player slots',
    maps:    created,
    players: playerCodes
  };
}

DOS.injectBigBang(bigbang);

// ── Line of Sight & Geometry Helpers ──────────────────────────────────────────

const Y_AXIS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const X_AXIS = "abcdefghijklmnopqrstuvwxyz0123456789";

function sectorToCoords(sector) {
  if (!sector || sector.length !== 2) return null;
  let y = Y_AXIS.indexOf(sector[0]);
  let x = X_AXIS.indexOf(sector[1]);
  if (y === -1 || x === -1) return null;
  return { x, y };
}

function coordsToSector(x, y) {
  if (y < 0 || y >= Y_AXIS.length || x < 0 || x >= X_AXIS.length) return null;
  return Y_AXIS[y] + X_AXIS[x];
}

function getSectorTerrain(drive, sector) {
  if (!drive || !drive.manifestMap) return 'A';
  let prefix = 'w/' + sector + '/Vl95';

  for (let key of drive.manifestMap.keys()) {
    if (key.startsWith(prefix) && key.length >= prefix.length + 1) {
      return key.charAt(prefix.length);
    }
  }
  return 'A';
}

function calculateLineOfSight(driveName, centerSector) {
  let drive = DOS.getDrive(driveName);
  let centerPos = sectorToCoords(centerSector);

  if (!centerPos) return [centerSector];

  let terrainChar = getSectorTerrain(drive, centerSector);
  let isElevated = (terrainChar === 'M' || terrainChar === 'S' || terrainChar === 'W');

  let visible = new Set();
  visible.add(centerSector);

  let offsets = [ [0, -1], [0, 1], [-1, 0], [1, 0] ];

  for (let off of offsets) {
    let tx = centerPos.x + off[0];
    let ty = centerPos.y + off[1];
    let targetSector = coordsToSector(tx, ty);

    if (!targetSector) continue;

    if (isElevated) {
      visible.add(targetSector);
    } else {
      let targetTerrain = getSectorTerrain(drive, targetSector);
      let isFlatland = 'ABCDEFGHIJK'.includes(targetTerrain);
      if (isFlatland) {
        visible.add(targetSector);
      }
    }
  }

  return Array.from(visible);
}

// ── Player Auth, JSON Snapshots & Idle Cleanup ────────────────────────────────

var DEFAULT_PLAYER_ITEM = 'Sa';
var DEFAULT_PLAYER_INV  = 'Za'.repeat(20);
var IDLE_LOGOUT_MS      = 120000; // 2 minutes without a ping removes idle player from /w/

var kickedSessions = new Map(); // session -> { msg, at }

setInterval(function () {
  var cutoff = Date.now() - 300000;
  for (var entry of kickedSessions.entries()) {
    if (entry[1].at < cutoff) kickedSessions.delete(entry[0]);
  }
}, 60000).unref();

function getRequestServerUrl(req) {
  if (process.env.SERVER_URL) return process.env.SERVER_URL.trim();
  if (!req || !req.headers) return 'http://localhost:' + PORT + '/qandyland.js';
  var protoHeader = req.headers['x-forwarded-proto'];
  var proto = protoHeader ? String(protoHeader).split(',')[0].trim() : 'http';
  var hostHeader = req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT);
  var host = String(hostHeader).split(',')[0].trim();
  return proto + '://' + host + '/qandyland.js';
}

function getDriveZBase(drive) {
  var gfxZBase = 10;
  var zBaseLoad = DOS.fileLoad(drive, '/', 'a/gfxZBase', 'system');
  if (zBaseLoad.success && zBaseLoad.content) {
    var parsed = parseInt(zBaseLoad.content, 10);
    if (!isNaN(parsed) && ((parsed >= 2 && parsed <= 36) || parsed === 52)) gfxZBase = parsed;
  }
  return gfxZBase;
}

function hashPassword(password) {
  var salt = crypto.randomBytes(16).toString('hex');
  var hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  var parts = stored.split(':');
  var salt = parts[0];
  var expectedHex = parts[1];
  if (!salt || !expectedHex) return false;
  var actualBuf = crypto.scryptSync(String(password), salt, 32);
  var expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function validateCredentials(username, password) {
  if (!username || username.length < 3) return '04';
  if (username.length >= 16) return '05';
  if (!/^[A-Za-z0-9]+$/.test(username)) return '03';
  if (!/^[A-Z]/.test(username)) return '16';
  if (/^guest/i.test(username)) return '17';
  if (!password || password.length < 4) return '08';
  if (/[\r\n]/.test(password) || password.indexOf('--') !== -1) return '07';
  return null;
}

function formatTimestampFromMs(ms) {
  var d = new Date(ms);
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function formatTsReadable(ts) {
  if (!ts || ts.length < 14) return ts || '';
  return ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8) + ' ' +
         ts.slice(8, 10) + ':' + ts.slice(10, 12) + ':' + ts.slice(12, 14);
}

function parsePlayerStatus(statusStr) {
  var s = String(statusStr || 'player').trim();
  if (!s || s === 'player') {
    return { type: 'player', until: null, expired: false };
  }
  var parts = s.split(/\s+/);
  var kind = parts[0].toLowerCase();
  if (kind !== 'ban' && kind !== 'mute') {
    return { type: 'player', until: null, expired: false };
  }
  var until = parts[1] || null;
  if (until && /^\d{14}$/.test(until)) {
    if (DOS.timestamp() >= until) {
      return { type: 'player', until: null, expired: true };
    }
    return { type: kind, until: until, expired: false };
  }
  return { type: kind, until: null, expired: false };
}

function parseDurationToStatus(kind, rawDuration) {
  if (rawDuration === undefined || rawDuration === null || String(rawDuration).trim() === '') {
    return { ok: true, status: kind }; // permanent
  }
  var d = String(rawDuration).trim().toLowerCase();
  if (d === '0' || d === 'off' || d === 'none' || d === 'clear' || d === 'unban' || d === 'unmute') {
    return { ok: true, status: 'player' };
  }
  if (d === 'perm' || d === 'permanent' || d === 'forever') {
    return { ok: true, status: kind };
  }
  if (/^\d{14}$/.test(d)) {
    return { ok: true, status: kind + ' ' + d };
  }
  var m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(d);
  if (!m) {
    return { ok: false, error: 'Invalid duration "' + rawDuration + '". Use e.g. 30m, 12h, 7d, 0/off, or omit for permanent.' };
  }
  var n = parseInt(m[1], 10);
  if (n <= 0) return { ok: true, status: 'player' };
  var mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2].toLowerCase()];
  return { ok: true, status: kind + ' ' + formatTimestampFromMs(Date.now() + n * mult) };
}

function parsePlayerRecord(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    var obj = JSON.parse(raw);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch (e) {
    return null;
  }
}

function serializePlayerRecord(rec) {
  return JSON.stringify(rec, null, 2);
}

function getSpawnDefaults(drive, gfxZBase) {
  var sector = 'Bc';
  var zStr = encodeZ(0, gfxZBase);
  var sLoad = DOS.fileLoad(drive, '/', 'a/gfxSpawn', 'system');
  if (sLoad.success && sLoad.content && sLoad.content.trim().length === 2) {
    sector = sLoad.content.trim();
  }
  var zLoad = DOS.fileLoad(drive, '/', 'a/gfxSpawnZ', 'system');
  if (zLoad.success && zLoad.content) {
    zStr = encodeZ(decodeZ(zLoad.content.trim(), gfxZBase), gfxZBase);
  }
  return { sector: sector, zStr: zStr };
}

function saveUserSnapshot(player, session, overrides) {
  if (!player || !player.drive || !player.userKey) return;
  var drive = player.drive;
  var uPath = 'u/' + player.userKey;
  var gfxZBase = getDriveZBase(drive);
  var sp = getSpawnDefaults(drive, gfxZBase);

  var existing = {};
  var exLoad = DOS.fileLoad(drive, '/', uPath, 'system');
  if (exLoad.success && exLoad.content) {
    existing = parsePlayerRecord(exLoad.content) || {};
  }

  var invContent = existing.inventory !== undefined ? existing.inventory : DEFAULT_PLAYER_INV;
  if (player.fullPath) {
    var pFile = DOS.fileLoad(drive, '/', player.fullPath, session || 'system');
    if (pFile.success && typeof pFile.content === 'string') {
      invContent = pFile.content;
    }
  }

  var itemId = (player.item && player.item.length >= 2)
    ? player.item.substring(0, 2)
    : (existing.item || DEFAULT_PLAYER_ITEM);
  var zStr = encodeZ(parseInt(player.z, 10) || 0, gfxZBase);
  var nowTs = DOS.timestamp();

  var record = {
    username:  player.username || existing.username || player.userKey,
    password:  (overrides && overrides.password !== undefined) ? overrides.password : (existing.password || ''),
    item:      itemId,
    avatar:    player.avatar != null ? player.avatar : (existing.avatar || ''),
    sector:    player.map || existing.sector || sp.sector,
    z:         zStr,
    status:    (overrides && overrides.status !== undefined) ? overrides.status : (player.status || existing.status || 'player'),
    created:   (overrides && overrides.created !== undefined) ? overrides.created : (player.created || existing.created || nowTs),
    lastLogin: (overrides && overrides.lastLogin !== undefined) ? overrides.lastLogin : (player.lastLogin || existing.lastLogin || nowTs),
    server:    (overrides && overrides.server !== undefined) ? overrides.server : (player.server !== undefined ? player.server : (existing.server || '')),
    inventory: invContent
  };

  DOS.fileSave(drive, '/', uPath, serializePlayerRecord(record), 'system', 'system');
}

var inFlightUsers = new Set();

function isUserActiveOnDrive(drive, userKey) {
  for (var entry of playerIndex.entries()) {
    var p = entry[1];
    if (p && p.drive === drive && p.userKey === userKey) return true;
  }
  return false;
}

function removePlayerFromWorld(player, session) {
  if (!player || !player.drive) return Promise.resolve();
  var syncPromise = Promise.resolve();
  if (player.userKey) {
    player.server = '';
    saveUserSnapshot(player, session, { server: '' });
    var drive = player.drive;
    var userKey = player.userKey;
    syncPromise = upstashSaveUser(drive, userKey).then(function (res) {
      if (
        res && res.ok && res.status === 'saved' &&
        !isUserActiveOnDrive(drive, userKey) &&
        !inFlightUsers.has(drive + ':' + userKey)
      ) {
        DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
      }
      return res;
    });
  }

  if (player.chatPath) {
    DOS.fileDelete(player.drive, '/', player.chatPath, session || 'system');
    player.chatPath = null;
    player.chatLoc = null;
  }
  if (player.fullPath) {
    DOS.fileDelete(player.drive, '/', player.fullPath, session || 'system');
  }
  if (player.pubId) {
    DOS.fileDelete(player.drive, '/', 'p/' + player.pubId, session || 'system');
  }
  return syncPromise;
}

setInterval(function () {
  var now = Date.now();
  for (var entry of playerIndex.entries()) {
    var sess = entry[0];
    var p = entry[1];
    if (p && p.lastSeen && (now - p.lastSeen > IDLE_LOGOUT_MS)) {
      playerIndex.delete(sess);
      removePlayerFromWorld(p, sess);
    }
  }
}, 30000).unref();

// ── Plugboard Command Processor ───────────────────────────────────────────────

async function plugboard(req, stacker, plugs, drive, session) {

  drive = DOS.resolveDriveName(drive) || drive;

  if (session && kickedSessions.has(session)) {
    var kickedMsg = kickedSessions.get(session).msg;
    kickedSessions.delete(session);
    return respondRetro(stacker, kickedMsg, null);
  }

  var skipPostTick = false;

  let gfxZBase = 10;
  let zBaseLoad = DOS.fileLoad(drive, '/', 'a/gfxZBase', session);
  if (zBaseLoad.success && zBaseLoad.content) {
    let parsedBase = parseInt(zBaseLoad.content, 10);
    if (!isNaN(parsedBase) && ((parsedBase >= 2 && parsedBase <= 36) || parsedBase === 52)) gfxZBase = parsedBase;
  }

  let output = "";

  function getPlayerStatus(p) {
    if (!p || !p.userKey) return 'guest';
    return p.status || 'player';
  }

  function runtape(code) {
    if (code) {
      let uResult = UNIVAC(drive, player.fullPath, "RAM:" + code, session, {
        noScroll: !!(player && player.fillTileCode),
        playerStatus: getPlayerStatus(player)
      });
      if (uResult) {
        player.map      = uResult.sector;
        player.z        = uResult.z;
        player.avatar   = uResult.avatar;
        if (uResult.playerid) player.pubId = uResult.playerid;
        if (uResult.item) player.item  = uResult.item + player.pubId;
        player.fullPath = uResult.fullPath;
        output += uResult.output;
      }
    }
  }

  function runfile(filepath) {
    if (typeof UNIVAC === 'function') {
      let uResult = UNIVAC(drive, player.fullPath, filepath, session, {
        playerStatus: getPlayerStatus(player)
      });
      if (uResult) {
        player.map      = uResult.sector;
        player.z        = uResult.z;
        player.avatar   = uResult.avatar;
        if (uResult.playerid) player.pubId = uResult.playerid;
        if (uResult.item) player.item  = uResult.item + player.pubId;
        player.fullPath = uResult.fullPath;
        output += uResult.output;
      }
    }
  }

  var player = playerIndex.get(session);
  
  if (!player) {
    player = {
      drive: drive,
      fullPath: null,
      map: "A1",
      z: 0,
      item: "",
      avatar: "",
      pubId: ""
    };
  } else {
    if (!player.map) player.map = "A1";
    if (player.z == null) player.z = 0;
    if (!player.item) player.item = "";
    if (!player.avatar) player.avatar = "";
    if (player.avatar.indexOf('-') !== -1) {
      let cleanAvatar = player.avatar.replace(/\-../g, '');
      runtape("Va" + cleanAvatar + "--");
    }
  }
  
  var avatarBeforeTape = player.avatar;

  let tape = "";
  if (DOS.fileExists(drive, '/', 'w/b').exists) runfile('w/b');

  var refresh = true;
  let column = 0;

  while (column < plugs.length) {

    let code = plugs.slice(column, column + 2);
    column += 2;

    switch (code) {
      case 'Vb': {
        if (tape) { runtape(tape); tape = ""; }
        let endChat = plugs.indexOf('--', column);
        let chatRaw = endChat !== -1 ? plugs.slice(column, endChat) : plugs.slice(column);
        column = endChat !== -1 ? endChat + 2 : plugs.length;

        if (!player.item || player.item === "" || player.item.startsWith('Za') || !player.pubId) break;

        if (player.userKey) {
          let muteCheck = parsePlayerStatus(player.status);
          if (muteCheck.expired) {
            player.status = 'player';
            saveUserSnapshot(player, session, { status: 'player' });
            await upstashSaveUser(drive, player.userKey);
          } else if (muteCheck.type === 'mute') {
            let untilText = muteCheck.until ? (' until ' + formatTsReadable(muteCheck.until)) : ' permanently';
            output += 'S^Vh<div style="text-align:center;padding:8px;">You are muted' + untilText + '.</div>--^S';
            break;
          }
        }

        let cleanText = String(chatRaw || '')
          .replace(/[\x00-\x1f\x7f]/g, ' ')
          .replace(/~/g, '-')
          .replace(/--/g, '-')
          .trim()
          .slice(0, 80);

        if (player.chatPath) {
          DOS.fileDelete(drive, '/', player.chatPath, session);
          player.chatPath = null;
          player.chatLoc = null;
        }

        if (cleanText) {
          let bZStr = encodeZ(parseInt(player.z, 10) || 0, gfxZBase);
          let bLoc  = player.map + bZStr;
          let bPath = 'b/' + bLoc + player.pubId;
          let bExp  = 'X' + DOS.futureTimestamp(1);
          DOS.fileSave(drive, '/', bPath, cleanText, session, session, bExp);
          player.chatPath = bPath;
          player.chatLoc  = bLoc;
        }
        break;
      }

      case 'Vu': {
        if (!player.item || player.item === "" || player.item.startsWith('Za')) { column += 2; break; }
        let useItem = plugs.slice(column, column + 2); column += 2;
        tape += code + useItem;
        break;
      }

      case 'Vn':
      case 'Vs':
      case 'Ve':
      case 'Vw':
        if (!player.item || player.item === "" || player.item.startsWith('Za')) { break; }
        tape += code;
        break;

      case 'Vd':
        if (!player.item || player.item === "" || player.item.startsWith('Za')) { break; }
        let item = plugs.slice(column, column + 2); column += 2;
        tape += code + item;
        break;

      case 'OD':
        if (tape) { runtape(tape); tape = ""; }
        let objfile = null;
        let objid = plugs.slice(column, column + 2);
        let objz  = plugs.slice(column + 2, column + 4);
        column += 4;

        if (!player.item || player.item.startsWith('Za')) {
          if (objid.charAt(0) === 'S') {
            player.z = decodeZ(objz, gfxZBase);
          }
        }

        let pZStr = encodeZ(player.z, gfxZBase);
        let odSearchPattern = 'w/' + player.map + '/' + objid + pZStr + '??';
        let odFilesResponse = DOS.fileSearch(drive, odSearchPattern);

        if (odFilesResponse.success && odFilesResponse.results.length > 0) {
          for (let i = 0; i < odFilesResponse.results.length; i++) {
            let entryName = odFilesResponse.results[i].name;
            let matchedBase = entryName.substring(entryName.lastIndexOf('/') + 1);
            if (entryName === 'w/' + player.map + '/' + matchedBase &&
                matchedBase.length === 6 &&
                matchedBase.startsWith(objid + pZStr)) {
              objfile = entryName;
              break;
            }
          }
        }


        if (objfile != null) {
          if (typeof UNIVAC === 'function') {
            let uResult = UNIVAC(drive, player.fullPath, objfile, session, {
              playerStatus: getPlayerStatus(player)
            });
            if (uResult) {
              player.map = uResult.sector;
              player.z = uResult.z;
              player.avatar = uResult.avatar;
              if (uResult.playerid) player.pubId = uResult.playerid;
              if (uResult.item) player.item = uResult.item + player.pubId;
              player.fullPath = uResult.fullPath;
              output += uResult.output;
            }
          }
        }
        break;

      case 'ID':
        if (tape) { runtape(tape); tape = ""; }
        let itemId = plugs.slice(column, column + 2);
        let itemZ  = plugs.slice(column + 2, column + 4);
        column += 4;

        let searchPrefix = 'w/' + player.map + '/' + itemId;
        let filesResponse = DOS.fileSearch(drive, searchPrefix + '*');

        if (filesResponse.success && filesResponse.results.length > 0) {
          let matchedPath = null;
          let matchedBase = null;

          for (let i = 0; i < filesResponse.results.length; i++) {
            let entryName = filesResponse.results[i].name;
            let base = entryName.split('/').pop();
            if (entryName !== 'w/' + player.map + '/' + base) continue;
            if (base.substring(0, 2) !== itemId || base.substring(2, 4) !== itemZ) continue;

            let candidateFullId = base.length >= 8 ? (itemId + base.substring(4, 8)) : itemId;
            if (!matchedPath) {
              matchedPath = entryName;
              matchedBase = base;
            }
            if (candidateFullId === player.item) {
              matchedPath = entryName;
              matchedBase = base;
              break;
            }
          }

          if (matchedPath) {
            let matchedPubId = matchedBase.length >= 8 ? matchedBase.substring(4, 8) : "";
            let matchedFullId = matchedPubId ? itemId + matchedPubId : itemId;

            if (itemId === 'Zj') {
              if (typeof UNIVAC === 'function') {
                let uResult = UNIVAC(drive, player.fullPath, 'w/f', session, {
                  playerStatus: getPlayerStatus(player)
                });
                if (uResult) {
                  player.map = uResult.sector;
                  player.z = uResult.z;
                  player.avatar = uResult.avatar;
                  if (uResult.playerid) player.pubId = uResult.playerid;
                  if (uResult.item) player.item = uResult.item + player.pubId;
                  player.fullPath = uResult.fullPath;
                  output += uResult.output;
                }
              }
              break;
            }

            if (matchedFullId === player.item) {
              let invLoad = DOS.fileLoad(drive, '/', player.fullPath, session);
              let inventoryData = (invLoad.success && invLoad.content) ? invLoad.content : '';
              output += "S^Vi" + inventoryData + "--^S";
              break;
            }

            if (itemId >= 'Aa' && itemId < 'Qa') { tape += 'XnVd' + itemId; }
          }
        }
        break;

      case 'Xt':
        if (tape) { runtape(tape); tape = ""; }
        let playerid = plugs.slice(column, column + 4);
        column = column + 4;
        if (!player.item || player.item.startsWith('Za')) { break; }
        tape = 'Xt' + playerid;
        runtape(tape);
        break;

      case 'Vl':
        if (tape) { runtape(tape); tape = ""; }
        refresh = false;

        let myTeam = player.item ? player.item.substring(0, 2) : 'Za';
        let tsStr = "";

        if (myTeam >= 'Sa' && myTeam <= 'Sd') {
          let tsLoad = DOS.fileLoad(drive, '/', 'w/' + myTeam, session);
          tsStr = (tsLoad.success && tsLoad.content) ? tsLoad.content : "";
        }

        let activeSectors = {};

        let pListRes = DOS.fileList(drive, 'p/', null, session);
        if (pListRes && pListRes.success && pListRes.listing) {
          let pFiles = pListRes.listing.trim().split(/\s+/);
          for (let i = 0; i < pFiles.length; i++) {
            if (!pFiles[i]) continue;
            let pLoad = DOS.fileLoad(drive, '/', 'p/' + pFiles[i], session);
            if (pLoad.success && pLoad.content && pLoad.content.length >= 2) {
              let sec = pLoad.content.substring(0, 2);
              activeSectors[sec] = true;
            }
          }
        }

        let myVisibleSectors = calculateLineOfSight(drive, player.map);
        for (let i = 0; i < myVisibleSectors.length; i++) {
          activeSectors[myVisibleSectors[i]] = true;
        }

        let pCSVArr = [];
        let currentlyVisibleSectorsArr = [];

        for (let sec in activeSectors) {
          let secListRes = DOS.fileList(drive, 'w/' + sec, null, session);
          if (secListRes && secListRes.success && secListRes.listing) {
            let wFiles = secListRes.listing.trim().split(/\s+/);
            let secPlayers = [];
            let teammateInSector = false;
            let isDirectLoS = myVisibleSectors.includes(sec);

            for (let j = 0; j < wFiles.length; j++) {
              let fname = wFiles[j];
              if (fname && fname.length >= 8) {
                let fid = fname.substring(0, 2);
                if (fid >= 'Sa' && fid < 'Ua') {
                  let fz = fname.substring(2, 4);
                  let uid = fname.substring(4, 8);
                  secPlayers.push(fid + sec + fz + uid);
                  if (fid === myTeam) {
                    teammateInSector = true;
                  }
                }
              }
            }

            if (teammateInSector || isDirectLoS) {
              currentlyVisibleSectorsArr.push(sec);
              if (tsStr.indexOf(sec) < 0) { tsStr += sec; }
              if (secPlayers.length > 0) {
                pCSVArr = pCSVArr.concat(secPlayers);
              }
            }
          }
        }

        if (myTeam >= 'Sa' && myTeam <= 'Ua') {
          DOS.fileSave(drive, '/', 'w/' + myTeam, tsStr, session, 'system');
        }

        let pCSV = pCSVArr.join('~');
        let visibleSectorsStr = currentlyVisibleSectorsArr.join('');
        let zStr = encodeZ(player.z, gfxZBase);

        output += "Vl" + player.map + zStr + pCSV + "|" + visibleSectorsStr + "|" + tsStr;
        break;

      case 'ST':
        skipPostTick = true;
        if (tape) { runtape(tape); tape = ""; }
        if (session && playerIndex.has(session)) {
          output = "ST" + session;
          refresh = false;
        } else {
          let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
          let pubId = '';
          for (let i = 0; i < 4; i++) pubId += chars.charAt(Math.floor(Math.random() * chars.length));

          let secret = Math.random().toString(36).substring(2, 10);
          session = secret;

          player = {
            drive:    drive,
            fullPath: null,
            map:      "A1",
            item:     "",
            z:        0,
            avatar:   "",
            pubId:    pubId,
            lastSeen: Date.now()
          };
          playerIndex.set(session, player);

          runtape("XaZa");
          if (!player.item) player.item = 'Za' + (player.pubId || '');

          output = "ST" + session;
          refresh = false;
        }
        column = plugs.length;
        break;

      case 'VA':
        if (tape) { runtape(tape); tape = ""; }
        let vaAvatar = "";
        let vaTermIdx = plugs.indexOf('--', column);
        if (vaTermIdx !== -1) {
          vaAvatar = plugs.slice(column, vaTermIdx);
          column = vaTermIdx + 2;
        } else {
          vaAvatar = plugs.slice(column);
          column = plugs.length;
        }

        if (!player.item || player.item === "") break;
        if (vaAvatar !== player.avatar) {
          runtape("Va" + vaAvatar + "--");
          if (player.userKey) saveUserSnapshot(player, session);
        }
        break;

      case 'LG': {
        if (tape) { runtape(tape); tape = ""; }
        if (player.userKey) {
          output += "S^LE21^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        }
        if (!player.item || player.item.startsWith('Za')) {
          runtape("Xa" + DEFAULT_PLAYER_ITEM + DEFAULT_PLAYER_INV + "--");
        }
        var guestName = 'guest' + (player.pubId || '0000');
        player.username = guestName;
        player.userKey  = null;
        player.lastSeen = Date.now();
        output += "S^LG" + guestName + "--^S";
        break;
      }

      case 'LI': {
        if (tape) { runtape(tape); tape = ""; }
        let endUser = plugs.indexOf('--', column);
        let uName = endUser !== -1 ? plugs.slice(column, endUser) : '';
        column = endUser !== -1 ? endUser + 2 : plugs.length;
        let endPass = plugs.indexOf('--', column);
        let uPass = endPass !== -1 ? plugs.slice(column, endPass) : '';
        column = endPass !== -1 ? endPass + 2 : plugs.length;

        let err = validateCredentials(uName, uPass);
        if (err) {
          output += "S^LE" + err + "^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        }

        let userKey = uName.toLowerCase();
        let lockKey = drive + ':' + userKey;
        let serverUrl = getRequestServerUrl(req);
        inFlightUsers.add(lockKey);
        try {
          let existedLocally = DOS.fileExists(drive, '/', 'u/' + userKey).exists;
          let uLoad = existedLocally ? DOS.fileLoad(drive, '/', 'u/' + userKey, 'system') : { success: false };
          if (!uLoad.success || !uLoad.content) {
            let remote = await upstashLoadUser(drive, userKey);
            if (!remote.ok) {
              output += "S^LE14^S";
              refresh = false; skipPostTick = true;
              column = plugs.length;
              break;
            }
            uLoad = DOS.fileLoad(drive, '/', 'u/' + userKey, 'system');
          }

          let rec = uLoad.success ? parsePlayerRecord(uLoad.content) : null;
          if (!rec) {
            if (!existedLocally && !isUserActiveOnDrive(drive, userKey)) {
              DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
            }
            output += "S^LE09^S";
            refresh = false; skipPostTick = true;
            column = plugs.length;
            break;
          }

          let exactName  = String(rec.username || uName).trim();
          let storedHash = String(rec.password || '').trim();

          if (!verifyPassword(uPass, storedHash)) {
            if (!existedLocally && !isUserActiveOnDrive(drive, userKey)) {
              DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
            }
            output += "S^LE09^S";
            refresh = false; skipPostTick = true;
            column = plugs.length;
            break;
          }

          // Lazy status expiration / ban check
          let stInfo = parsePlayerStatus(rec.status);
          let statusWasReset = false;
          if (stInfo.expired) {
            rec.status = 'player';
            statusWasReset = true;
          } else if (stInfo.type === 'ban') {
            if (!existedLocally && !isUserActiveOnDrive(drive, userKey)) {
              DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
            }
            output += "S^LE22^S";
            refresh = false; skipPostTick = true;
            column = plugs.length;
            break;
          }

          // Single-server lock check
          if (rec.server && rec.server !== serverUrl) {
            if (statusWasReset) {
              DOS.fileSave(drive, '/', 'u/' + userKey, serializePlayerRecord(rec), 'system', 'system');
              await upstashSaveUser(drive, userKey);
            }
            if (!existedLocally && !isUserActiveOnDrive(drive, userKey)) {
              DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
            }
            output += "S^LE23^S";
            refresh = false; skipPostTick = true;
            column = plugs.length;
            break;
          }

          let alreadyActive = false;
          let evictedIdle = false;
          for (let [otherSess, otherP] of playerIndex.entries()) {
            if (otherSess !== session && otherP.drive === drive && otherP.userKey === userKey) {
              if (Date.now() - (otherP.lastSeen || 0) < 10000) {
                alreadyActive = true;
                break;
              } else {
                playerIndex.delete(otherSess);
                await removePlayerFromWorld(otherP, otherSess);
                evictedIdle = true;
              }
            }
          }
          if (alreadyActive) {
            if (!existedLocally && !isUserActiveOnDrive(drive, userKey)) {
              DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
            }
            output += "S^LE20^S";
            refresh = false; skipPostTick = true;
            column = plugs.length;
            break;
          }

          if (evictedIdle && !DOS.fileExists(drive, '/', 'u/' + userKey).exists) {
            let remoteAfterEvict = await upstashLoadUser(drive, userKey);
            if (!remoteAfterEvict.ok) {
              output += "S^LE14^S";
              refresh = false; skipPostTick = true;
              column = plugs.length;
              break;
            }
            uLoad = DOS.fileLoad(drive, '/', 'u/' + userKey, 'system');
            rec = uLoad.success ? parsePlayerRecord(uLoad.content) : rec;
            exactName = String(rec.username || uName).trim();
          }

          if (player.fullPath || player.pubId) {
            await removePlayerFromWorld(player, session);
            player.fullPath = null;
            player.userKey  = null;
            player.username = null;
          }

          let sp       = getSpawnDefaults(drive, gfxZBase);
          let pId      = rec.item || DEFAULT_PLAYER_ITEM;
          let pSector  = rec.sector || sp.sector;
          let pZStr    = rec.z || sp.zStr;
          let pAvatar  = rec.avatar || '';
          let pContent = rec.inventory !== undefined ? rec.inventory : DEFAULT_PLAYER_INV;
          let newPubId = UNIVAC.tickOdometer(drive);
          let nowTs    = DOS.timestamp();

          let restoredPath = 'w/' + pSector + '/' + pId + pZStr + newPubId + pAvatar;
          DOS.fileSave(drive, '/', restoredPath, pContent, session, session);
          DOS.fileSave(drive, '/', 'p/' + newPubId, pSector + pZStr + pAvatar, session, session);

          player.fullPath  = restoredPath;
          player.map       = pSector;
          player.z         = decodeZ(pZStr, gfxZBase);
          player.item      = pId + newPubId;
          player.avatar    = pAvatar;
          player.pubId     = newPubId;
          player.username  = exactName;
          player.userKey   = userKey;
          player.status    = rec.status || 'player';
          player.created   = rec.created || nowTs;
          player.lastLogin = nowTs;
          player.server    = serverUrl;
          player.lastSeen  = Date.now();

          saveUserSnapshot(player, session, {
            password:  rec.password,
            status:    player.status,
            created:   player.created,
            lastLogin: player.lastLogin,
            server:    serverUrl
          });
          await upstashSaveUser(drive, userKey);

          output += "S^LI" + exactName + "--^S";
        } finally {
          inFlightUsers.delete(lockKey);
        }
        break;
      }

      case 'LC': {
        if (tape) { runtape(tape); tape = ""; }
        let endUser = plugs.indexOf('--', column);
        let uName = endUser !== -1 ? plugs.slice(column, endUser) : '';
        column = endUser !== -1 ? endUser + 2 : plugs.length;
        let endPass = plugs.indexOf('--', column);
        let uPass = endPass !== -1 ? plugs.slice(column, endPass) : '';
        column = endPass !== -1 ? endPass + 2 : plugs.length;

        if (player.userKey) {
          output += "S^LE21^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        }

        let err = validateCredentials(uName, uPass);
        if (err) {
          output += "S^LE" + err + "^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        }

        let userKey = uName.toLowerCase();
        let lockKey = drive + ':' + userKey;
        let serverUrl = getRequestServerUrl(req);
        inFlightUsers.add(lockKey);
        try {
          let existsLocally = DOS.fileExists(drive, '/', 'u/' + userKey).exists;
          if (!existsLocally) {
            let remote = await upstashLoadUser(drive, userKey);
            if (!remote.ok) {
              output += "S^LE14^S";
              refresh = false; skipPostTick = true;
              column = plugs.length;
              break;
            }
            if (remote.status === 'found') {
              existsLocally = true;
            }
          }
          if (existsLocally) {
            output += "S^LE10^S";
            refresh = false; skipPostTick = true;
            column = plugs.length;
            break;
          }

          if (!player.item || player.item.startsWith('Za')) {
            runtape("Xa" + DEFAULT_PLAYER_ITEM + DEFAULT_PLAYER_INV + "--");
          }

          let nowTs = DOS.timestamp();
          player.username  = uName;
          player.userKey   = userKey;
          player.status    = 'player';
          player.created   = nowTs;
          player.lastLogin = nowTs;
          player.server    = '';
          player.lastSeen  = Date.now();

          saveUserSnapshot(player, session, {
            password:  hashPassword(uPass),
            status:    'player',
            created:   nowTs,
            lastLogin: nowTs,
            server:    ''
          });

          let created = await upstashSaveUser(drive, userKey, true);
          if (!created.ok || created.status === 'exists') {
            DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
            player.username = null;
            player.userKey  = null;
            player.server   = '';
            output += "S^LE" + (created.status === 'exists' ? "10" : "14") + "^S";
            refresh = false; skipPostTick = true;
            column = plugs.length;
            break;
          }

          if (session) playerIndex.delete(session);
          await removePlayerFromWorld(player, session);
          session = null;
          output += "S^LC" + uName + "--LO--^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        } finally {
          inFlightUsers.delete(lockKey);
        }
        break;
      }

      case 'LO': {
        if (tape) { runtape(tape); tape = ""; }
        if (session) playerIndex.delete(session);
        await removePlayerFromWorld(player, session);
        session = null;
        output += "S^LO--^S";
        refresh = false; skipPostTick = true;
        column = plugs.length;
        break;
      }

      case 'OO':
        refresh = false;
        column = plugs.length;
        break;
    }
  }

  if (tape) { runtape(tape); tape = ""; }

  if (!skipPostTick && session && player.userKey && player.avatar !== avatarBeforeTape) {
    saveUserSnapshot(player, session);
  }

  if (!skipPostTick && session) {
    if (player.item && player.item.length >= 2) {
      var team = player.item.substring(0, 2);
      if (team >= 'Sa' && team <= 'Sd') {
        let tsLoad = DOS.fileLoad(drive, '/', 'w/' + team, session);
        let tsStr = (tsLoad.success && tsLoad.content) ? tsLoad.content : "";
        if (tsStr.indexOf(player.map) < 0) {
          tsStr = tsStr + player.map;
          DOS.fileSave(drive, '/', 'w/' + team, tsStr, session, 'system');
        }
      }
    }

    if (player.pubId && player.map) {
      let tagPath = 'w/' + player.map + '/Xt' + player.pubId;
      let tagRes = DOS.fileLoad(drive, '/', tagPath, session);
      if (tagRes.success && tagRes.content) {
        let attackVal = tagRes.content.substring(4, 6);
        DOS.fileDelete(drive, '/', tagPath, session);
        if (DOS.fileExists(drive, '/', 'w/t').exists) {
          runtape('XsW@' + attackVal);
          runfile('w/t');
        }
      }
    }

    if (DOS.fileExists(drive, '/', 'w/c').exists) runfile('w/c');

    let curZStr = encodeZ(parseInt(player.z, 10) || 0, gfxZBase);
    if (player.chatPath && player.chatLoc !== (player.map + curZStr)) {
      DOS.fileDelete(drive, '/', player.chatPath, session);
      player.chatPath = null;
      player.chatLoc  = null;
    }

    player.lastSeen = Date.now();
    playerIndex.set(session, player);
  }

  if (refresh) {
    let list = DOS.fileList(drive, 'w/' + player.map, null, session);
    let items = [];
    if (list.success && list.listing) {
      let files = list.listing.split(' ');
      files.forEach(f => {
        if (f.length > 1) {
          items.push(f);
        }
      });
    }

    let bList = DOS.fileList(drive, 'b/', player.map + '*', session);
    if (bList.success && bList.listing) {
      let bFiles = bList.listing.trim().split(/\s+/);
      for (let bi = 0; bi < bFiles.length; bi++) {
        let bf = bFiles[bi];
        if (bf.length !== 8) continue;
        let bSec  = bf.substring(0, 2);
        let bZStr = bf.substring(2, 4);
        let bPub  = bf.substring(4, 8);
        if (bSec !== player.map) continue;

        let pCheck = DOS.fileLoad(drive, '/', 'p/' + bPub, 'system');
        if (!pCheck.success || !pCheck.content || pCheck.content.substring(0, 4) !== (bSec + bZStr)) {
          DOS.fileDelete(drive, '/', 'b/' + bf, 'system');
          continue;
        }

        let bLoad = DOS.fileLoad(drive, '/', 'b/' + bf, session);
        if (bLoad.success && bLoad.content) {
          let safeMsg = String(bLoad.content).replace(/[\r\n~]/g, ' ').trim();
          if (safeMsg) {
            items.push('Vb' + bZStr + bPub + safeMsg);
          }
        }
      }
    }

    let numericZ = parseInt(player.z, 10) || 0;
    let z = numericZ < 0 ? encodeZ(0, gfxZBase) : encodeZ(numericZ, gfxZBase);

    let pItemId = player.item ? player.item.substring(0, 2) : "Za";
    let pPubId = player.pubId ? player.pubId : "0000";
    if (pPubId.length < 4) pPubId = pPubId.padEnd(4, '0');

    output = "PI" + pItemId + z + pPubId + output;
    output += "RF" + player.map + z + items.join('~');
  }
  return respondRetro(stacker, output, session);
}

// ── DevTeam Remote GFX Map Editor (Independent of Plugboard) ──────────────────

function handleGfxDevCommand(req, res, rawCmd, drive, session) {
  var player = session ? playerIndex.get(session) : null;
  var VALID_ITEM_ID_RE = /^[A-Z][a-z0-9_()[\]{}^,:;+\-=%@]$/;

  function sendDev(ok, output, extra) {
    logRequest(req, 'GFX', drive, (player && player.username) || '-', session, { success: ok });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(Object.assign({ ok: !!ok, output: String(output == null ? '' : output) }, extra || {})));
  }

  // 1. Must be logged in with a real account (not guest, not Za)
  if (!player || !player.userKey) {
    return sendDev(false, 'Error: [.4]DevTeam editing requires a logged-in account.[.]');
  }

  drive = DOS.resolveDriveName(player.drive || drive) || drive;
  var driveObj = DOS.getDrive(drive);
  if (!driveObj) {
    return sendDev(false, 'Error: [.4]Drive "' + drive + '" is not mounted.[.]');
  }
  if (driveObj.readOnly) {
    return sendDev(false, 'Error: [.4]Drive ' + drive + ':/ is read-only (ROM mode).[.]');
  }

  // 2. Sysop authorization check: /a/ must exist and /a/playerDevTeam must list player.userKey
  if (!DOS.dirExists(drive, 'a')) {
    return sendDev(false, 'Error: [.4]/a/ directory does not exist on ' + drive + ':/ (devteam not authorized).[.]');
  }

  var devLoad = DOS.fileLoad(drive, '/', 'a/playerDevTeam', 'system');
  var devMembers = (devLoad.success && devLoad.content)
    ? devLoad.content.split(/\r?\n/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean)
    : [];

  if (devMembers.indexOf(player.userKey) === -1) {
    return sendDev(false, 'Error: [.4]Permission denied: "' + player.username + '" is not in /a/playerDevTeam.[.]');
  }

  player.lastSeen = Date.now();

  // 3. Read drive geometry / Z-base config
  var gfxZBase = 10;
  var zBaseRes = DOS.fileLoad(drive, '/', 'a/gfxZBase', 'system');
  if (zBaseRes.success && zBaseRes.content) {
    var parsedB = parseInt(zBaseRes.content.trim(), 10);
    if (!isNaN(parsedB) && ((parsedB >= 2 && parsedB <= 36) || parsedB === 52)) gfxZBase = parsedB;
  }

  var gridWide = 14;
  var gridTall = 10;
  var gwRes = DOS.fileLoad(drive, '/', 'a/gfxGridWide', 'system');
  if (!gwRes.success) gwRes = DOS.fileLoad(drive, '/', 'a/mapx', 'system');
  if (gwRes.success && gwRes.content) {
    var gw = parseInt(gwRes.content.trim(), 10);
    if (!isNaN(gw) && gw > 0) gridWide = gw;
  }
  var gtRes = DOS.fileLoad(drive, '/', 'a/gfxGridTall', 'system');
  if (!gtRes.success) gtRes = DOS.fileLoad(drive, '/', 'a/mapy', 'system');
  if (gtRes.success && gtRes.content) {
    var gt = parseInt(gtRes.content.trim(), 10);
    if (!isNaN(gt) && gt > 0) gridTall = gt;
  }

  // 4. Parse command
  var trimmed = String(rawCmd || '').trim();
  if (!trimmed) return sendDev(false, 'Error: [.4]Empty GFX command.[.]');

  var spIdx  = trimmed.search(/\s/);
  var sub    = (spIdx === -1 ? trimmed : trimmed.substring(0, spIdx)).toLowerCase();
  var argStr = spIdx === -1 ? '' : trimmed.substring(spIdx + 1).trim();
  var args   = argStr ? argStr.split(/\s+/) : [];

  var sector   = player.map || 'Bc';
  var maxTiles = gridWide * gridTall;
  var curZ     = parseInt(player.z, 10) || 0;
  if (curZ < 0) curZ = 0;
  if (curZ >= maxTiles) curZ = maxTiles - 1;
  var zStr = encodeZ(curZ, gfxZBase);

  function isValidSectorId(sec) {
    return /^[A-Z][A-Za-z0-9_()[\]{}^,:;+\-=%@]$/.test(sec);
  }
  function isReservedItemId(id) {
    return id.charAt(0) === 'V' || id.charAt(0) === 'X' || (id >= 'Sa' && id < 'Ua');
  }

  switch (sub) {
    case 'tile': {
      if (!DOS.dirExists(drive, 'w/' + sector)) {
        return sendDev(false, 'Error: [.4]Sector "' + sector + '" does not exist.[.]');
      }
      var mPath = 'w/' + sector + '/m';
      var mLoad = DOS.fileLoad(drive, '/', mPath, 'system');
      var mData = (mLoad.success && mLoad.content) ? mLoad.content.replace(/\s+/g, '') : '';
      while (mData.length < maxTiles * 2) mData += 'Za';

      if (!args[0]) {
        var curCode = mData.substring(curZ * 2, curZ * 2 + 2) || 'Za';
        return sendDev(true, 'Tile at ' + sector + ' (' + zStr + ' / Z:' + curZ + ') is [' + curCode + ']', {
          sector: sector, z: curZ, zStr: zStr, tile: curCode
        });
      }

      var tileCode = args[0];
      if (!/^[A-Za-z0-9]{2}$/.test(tileCode)) {
        return sendDev(false, 'Error: [.4]Tile code must be 2 alphanumeric characters.[.]');
      }

      var idx = curZ * 2;
      mData = mData.substring(0, idx) + tileCode + mData.substring(idx + 2);
      var saveTile = DOS.fileSave(drive, '/', mPath, mData, session, player.username);
      if (!saveTile.success) return sendDev(false, 'Error: [.4]' + saveTile.error + '[.]');

      // Remove any temporary Xz marker at this coordinate so permanent edit isn't shadowed
      var xzSearch = DOS.fileSearch(drive, 'w/' + sector + '/Xz' + zStr + '??');
      if (xzSearch.success && xzSearch.results.length) {
        xzSearch.results.forEach(function (r) {
          if (r.name.length === ('w/' + sector + '/').length + 6) {
            DOS.fileDelete(drive, '/', r.name, session);
          }
        });
      }

      return sendDev(true, 'Tile at ' + sector + ' (' + zStr + ') set to [' + tileCode + ']', {
        sector: sector, z: curZ, zStr: zStr, tile: tileCode
      });
    }
    
    case 'fill': {
      var fillArg = args[0] ? String(args[0]).trim() : '';
      if (!fillArg || fillArg.toLowerCase() === 'off' || fillArg.toLowerCase() === 'none') {
        player.fillTileCode = null;
        return sendDev(true, '[.2]GFX Fill Mode DISABLED.[.]', { fill: null });
      }
      var fillCode = fillArg.substring(0, 2);
      if (!/^[A-Za-z0-9]{2}$/.test(fillCode)) {
        return sendDev(false, 'Error: [.4]Tile code must be 2 alphanumeric characters.[.]');
      }
      player.fillTileCode = fillCode;
      return sendDev(true, '[.4]GFX Fill Mode ENGAGED: brush set to [' + fillCode + '][.]', { fill: fillCode });
    }


    case 'obj': {
      if (!DOS.dirExists(drive, 'w/' + sector)) {
        return sendDev(false, 'Error: [.4]Sector "' + sector + '" does not exist.[.]');
      }
      var objMatch = argStr.match(/^(\S+)(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/);
      if (!objMatch) return sendDev(false, 'Usage: gfx obj <2-char id> [2-char data] [punchcode]');

      var objId   = objMatch[1];
      var objData = objMatch[2] || 'Za';
      var objCode = objMatch[3] || '';

      if (!VALID_ITEM_ID_RE.test(objId)) {
        return sendDev(false, 'Error: [.4]Invalid object ID "' + objId + '".[.]');
      }

      var objFilename = objId + zStr + objData;
      var saveObj = DOS.fileSave(drive, '/', 'w/' + sector + '/' + objFilename, objCode, session, player.username);
      if (!saveObj.success) return sendDev(false, 'Error: [.4]' + saveObj.error + '[.]');

      return sendDev(true, 'Saved object ' + sector + '/' + objFilename, {
        sector: sector, z: curZ, zStr: zStr, filename: objFilename
      });
    }

    case 'item': {
      if (!DOS.dirExists(drive, 'w/' + sector)) {
        return sendDev(false, 'Error: [.4]Sector "' + sector + '" does not exist.[.]');
      }
      var itemId = args[0] || '';

      if (!VALID_ITEM_ID_RE.test(itemId)) {
        return sendDev(false, 'Error: [.4]Invalid item ID "' + itemId + '".[.]');
      }

      var itemFilename = itemId + zStr;
      var saveItem = DOS.fileSave(drive, '/', 'w/' + sector + '/' + itemFilename, '', session, player.username);
      if (!saveItem.success) return sendDev(false, 'Error: [.4]' + saveItem.error + '[.]');

      return sendDev(true, 'Saved item ' + sector + '/' + itemFilename, {
        sector: sector, z: curZ, zStr: zStr, filename: itemFilename
      });
    }

    case 'save': {
      var saveSector = args[0] || sector;
      if (!isValidSectorId(saveSector) || !DOS.dirExists(drive, 'w/' + saveSector)) {
        return sendDev(false, 'Error: [.4]Sector "' + saveSector + '" does not exist.[.]');
      }

      var dirRes = DOS.getDirEntries(drive, 'w/' + saveSector);
      var sectorFiles = {};
      var fileCount = 0;

      for (var si = 0; si < dirRes.files.length; si++) {
        var fEntry = dirRes.files[si];
        var fname = DOS.rawBaseName(fEntry.name);
        if (!fname || fname === DOS.MANIFEST_KEY || fname.charAt(0) === '_') continue;
        // Skip temporary/expiring items (e.g. dropped items) and active players
        if (fEntry.timestamp && fEntry.timestamp.charAt(0) === 'X') continue;
        if (fname.length >= 8) continue;
        // Skip runtime UNIVAC markers (Vx, Vy, Xz, Xt, Vb, etc.)
        if ((fname.length === 4 || fname.length === 6) && (fname.charAt(0) === 'V' || fname.charAt(0) === 'X')) continue;

        var fLoaded = DOS.fileLoad(drive, '/', fEntry.name, 'system');
        if (fLoaded.success) {
          sectorFiles[fname] = fLoaded.content == null ? '' : String(fLoaded.content);
          fileCount++;
        }
      }

      return sendDev(true, '', {
        sector: saveSector,
        count: fileCount,
        files: sectorFiles
      });
    }

    case 'del':
    case 'rm': {
      var delId = args[0] || '';

      if (!VALID_ITEM_ID_RE.test(delId)) {
        return sendDev(false, 'Usage: gfx del <2-char id> (deletes static item/object at cursor)');
      }

      var prefixPath = 'w/' + sector + '/';
      var matches = DOS.fileSearch(drive, prefixPath + delId + zStr + '*');
      var deleted = [];
      if (matches.success && matches.results.length) {
        for (var i = 0; i < matches.results.length; i++) {
          var full = matches.results[i].name;
          if (full.indexOf(prefixPath) !== 0) continue;
          var base = full.substring(prefixPath.length);
          // Only delete 4-char items or 6-char static objects at this exact Z
          if ((base.length === 4 || base.length === 6) && base.substring(0, 4) === (delId + zStr)) {
            if (DOS.fileDelete(drive, '/', full, session).success) {
              deleted.push(base);
            }
          }
        }
      }

      if (!deleted.length) {
        return sendDev(false, 'Error: [.4]No matching static object/item "' + delId + zStr + '" at Z:' + curZ + '.[.]');
      }
      return sendDev(true, 'Deleted ' + sector + '/' + deleted.join(', '), {
        sector: sector, z: curZ, deleted: deleted
      });
    }

    case 'code': {
      var codeMatch = argStr.match(/^(\S+)(?:\s+([\s\S]+))?$/);

      if (!codeMatch) {
        return sendDev(false, 'Usage: gfx code <2-char id | sector/filename> [punchcode|null]');
      }

      var targetSpec = codeMatch[1];
      var newCode = codeMatch[2];
      var targetFile = null;
      var targetSector = sector;
      var targetFilename = null;

      if (targetSpec.indexOf('/') !== -1) {
        var slashParts = targetSpec.split('/');
        if (
          slashParts.length !== 2 ||
          !isValidSectorId(slashParts[0]) ||
          !/^[A-Z][A-Za-z0-9_()[\]{}^,:;+\-=%@]{5}$/.test(slashParts[1])
        ) {
          return sendDev(false, 'Usage: gfx code <2-char id | sector/filename> [punchcode|null]');
        }
        targetSector = slashParts[0];
        targetFilename = slashParts[1];
        var candidatePath = 'w/' + targetSector + '/' + targetFilename;
        if (DOS.fileExists(drive, '/', candidatePath).exists) {
          targetFile = candidatePath;
        }
      } else {
        if (!VALID_ITEM_ID_RE.test(targetSpec)) {
          return sendDev(false, 'Usage: gfx code <2-char id> [punchcode|null]');
        }
        var cId = targetSpec;
        var cPrefix = 'w/' + sector + '/';
        var cMatches = DOS.fileSearch(drive, cPrefix + cId + zStr + '??');

        if (cMatches.success && cMatches.results.length) {
          for (var ci = 0; ci < cMatches.results.length; ci++) {
            var cFull = cMatches.results[ci].name;
            var cBase = cFull.substring(cPrefix.length);
            if (cFull.indexOf(cPrefix) === 0 && cBase.length === 6 && cBase.substring(0, 4) === (cId + zStr)) {
              targetFile = cFull;
              targetFilename = cBase;
              break;
            }
          }
        }
      }

      if (!targetFile) {
        return sendDev(false, 'Error: [.4]No 6-char object "' + targetSpec + '" found.[.]');
      }

      if (newCode === undefined) {
        var cLoad = DOS.fileLoad(drive, '/', targetFile, session);
        var loadedCode = (cLoad.success && cLoad.content != null) ? String(cLoad.content) : '';
        return sendDev(true, targetFile + ' = ' + loadedCode, {
          sector: targetSector,
          filename: targetFilename,
          code: loadedCode
        });
      }

      if (newCode === 'null') {
        newCode = '';
      }

      var cSave = DOS.fileSave(drive, '/', targetFile, newCode, session, player.username);
      if (!cSave.success) return sendDev(false, 'Error: [.4]' + cSave.error + '[.]');
      return sendDev(true, 'Updated punch code for ' + targetFile, {
        sector: targetSector,
        filename: targetFilename,
        code: newCode
      });
    }

    case 'exits': {
      if (!DOS.dirExists(drive, 'w/' + sector)) {
        return sendDev(false, 'Error: [.4]Sector "' + sector + '" does not exist.[.]');
      }
      var ePath = 'w/' + sector + '/e';
      if (!args[0]) {
        var eLoad = DOS.fileLoad(drive, '/', ePath, 'system');
        return sendDev(true, 'Exits for ' + sector + ': ' + ((eLoad.success && eLoad.content) ? eLoad.content : '(none)'));
      }
      var newExits = (args[0].toLowerCase() === 'none' || args[0] === '-') ? '' : args[0];
      if (newExits && (newExits.length % 2 !== 0 || !/^[A-Za-z0-9_()[\]{}^,:;+\-=%@]+$/.test(newExits))) {
        return sendDev(false, 'Error: [.4]Exits must be concatenated 2-char sector IDs (or "none").[.]');
      }
      var eSave = DOS.fileSave(drive, '/', ePath, newExits, session, player.username);
      if (!eSave.success) return sendDev(false, 'Error: [.4]' + eSave.error + '[.]');
      return sendDev(true, 'Exits for ' + sector + ' set to: ' + (newExits || '(none)'));
    }

    case 'sector': {
      var newSec = args[0] || '';
      if (!isValidSectorId(newSec)) {
        return sendDev(false, 'Error: [.4]Invalid sector ID "' + newSec + '".[.]');
      }
      if (DOS.dirExists(drive, 'w/' + newSec)) {
        return sendDev(false, 'Error: [.4]Sector "' + newSec + '" already exists.[.]');
      }
      if (!DOS.dirExists(drive, 'w')) {
        DOS.dirMake(drive, '/', 'w', session);
      }
      var mkSec = DOS.dirMake(drive, '/', 'w/' + newSec, session);
      if (!mkSec.success) return sendDev(false, 'Error: [.4]' + mkSec.error + '[.]');
      DOS.fileSave(drive, '/', 'w/' + newSec + '/m', 'Za'.repeat(maxTiles), session, player.username);
      DOS.fileSave(drive, '/', 'w/' + newSec + '/e', '', session, player.username);
      return sendDev(true, 'Created sector ' + newSec + ' (' + gridWide + 'x' + gridTall + ').');
    }

    case 'tele': {
      var targetSec = args[0] || '';
      if (!isValidSectorId(targetSec) || !DOS.dirExists(drive, 'w/' + targetSec)) {
        return sendDev(false, 'Error: [.4]Sector "' + targetSec + '" does not exist.[.]');
      }

      var targetZ = curZ;
      if (args[1]) {
        targetZ = /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : decodeZ(args[1], gfxZBase);
        if (isNaN(targetZ) || targetZ < 0 || targetZ >= maxTiles) {
          return sendDev(false, 'Error: [.4]Z out of bounds (0..' + (maxTiles - 1) + ').[.]');
        }
      }

      var targetZStr = encodeZ(targetZ, gfxZBase);
      var pId = (player.item && player.item.length >= 2) ? player.item.substring(0, 2) : DEFAULT_PLAYER_ITEM;
      var newPath = 'w/' + targetSec + '/' + pId + targetZStr + player.pubId + (player.avatar || '');

      var invLoad = player.fullPath ? DOS.fileLoad(drive, '/', player.fullPath, session) : { success: false };
      var invContent = (invLoad.success && typeof invLoad.content === 'string') ? invLoad.content : DEFAULT_PLAYER_INV;

      var pSave = DOS.fileSave(drive, '/', newPath, invContent, session, session);
      if (!pSave.success) return sendDev(false, 'Error: [.4]' + pSave.error + '[.]');

      if (player.fullPath && player.fullPath !== newPath) {
        DOS.fileDelete(drive, '/', player.fullPath, session);
      }
      if (player.chatPath) {
        DOS.fileDelete(drive, '/', player.chatPath, session);
        player.chatPath = null;
        player.chatLoc = null;
      }

      DOS.fileSave(drive, '/', 'p/' + player.pubId, targetSec + targetZStr + (player.avatar || ''), session, session);
      player.fullPath = newPath;
      player.map = targetSec;
      player.z = targetZ;

      return sendDev(true, 'Teleported to sector ' + targetSec + ' (Z:' + targetZ + ')', {
        sector: targetSec, z: targetZ, zStr: targetZStr
      });
    }

    case 'id':
    case 'mod': {
      var modMatch = argStr.match(/^(\S+)(?:\s+([\s\S]+))?$/);
      if (!modMatch || !/^[A-Z][a-z0-9]$/.test(modMatch[1])) {
        return sendDev(false, 'Usage: gfx mod <2-char ItemID> [description]');
      }
      var modId = modMatch[1];
      var modPath = 'a/gfxItemID';
      var mods = {};
      var modLoad = DOS.fileLoad(drive, '/', modPath, 'system');
      if (modLoad.success && modLoad.content && modLoad.content.trim()) {
        try {
          var parsedMods = JSON.parse(modLoad.content);
          if (parsedMods && typeof parsedMods === 'object' && !Array.isArray(parsedMods)) mods = parsedMods;
        } catch (e) { mods = {}; }
      }

      if (modMatch[2] === undefined) {
        var curDesc = mods[modId];
        return sendDev(true, modId + (curDesc ? ' mod = ' + curDesc : ' (no server mod set)'));
      }

      var desc = modMatch[2].trim();
      if (desc.length >= 2 && ((desc[0] === '"' && desc[desc.length - 1] === '"') || (desc[0] === "'" && desc[desc.length - 1] === "'"))) {
        desc = desc.slice(1, -1).trim();
      }
      if (/[\x00-\x1F\x7F]/.test(desc) || desc.length > 64) {
        return sendDev(false, 'Error: [.4]Invalid description (max 64 printable characters).[.]');
      }

      if (desc === '') {
        delete mods[modId];
      } else {
        mods[modId] = desc;
      }

      if (Object.keys(mods).length === 0) {
        DOS.fileDelete(drive, '/', modPath, session);
      } else {
        var modSave = DOS.fileSave(drive, '/', modPath, JSON.stringify(mods), session, player.username);
        if (!modSave.success) return sendDev(false, 'Error: [.4]' + modSave.error + '[.]');
      }

      return sendDev(true, modId + (desc === '' ? ' mod cleared.' : ' mod = ' + desc));
    }

    case 'export': {
      var entries = [];
      var nowTs = DOS.timestamp();

      driveObj.manifestMap.forEach(function (e, key) {
        if (!key || key === DOS.MANIFEST_KEY) return;

        var isDir = key.charAt(0) === '<';
        var pathName = isDir ? key.substring(1, key.length - 1) : key;

        var content = '';
        if (!isDir) {
          var fLoad = DOS.fileLoad(drive, '/', key, 'system');
          if (!fLoad.success) return;
          content = fLoad.content == null ? '' : String(fLoad.content);
        }

        entries.push({
          name: pathName,
          type: isDir ? 'directory' : 'file',
          content: content,
          size: e.size,
          timestamp: e.timestamp,
          owner: e.owner,
          session: e.session,
          readOnly: pathName.endsWith('!')
        });
      });

      entries.sort(function (a, b) { return a.name < b.name ? -1 : 1; });

      var archiveJson = JSON.stringify({
        format: DOS.ARCHIVE_FORMAT,
        version: DOS.ARCHIVE_VERSION,
        drive: drive,
        created: new Date().toISOString(),
        entries: entries
      }, null, 2);

      return sendDev(true, 'Exported ' + entries.length + ' entries from ' + drive + ':/', {
        drive: drive,
        count: entries.length,
        archive: archiveJson
      });
    }

    default:
      return sendDev(false, 'Error: [.4]Unknown remote GFX command "' + sub + '".[.]');
  }
}

// ── UPSTASH server ───────────────────────────────────────────────────────────────

var UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL || '';
var UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

function getUpstashGfxNamespace(drive) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;

  var driveObj = DOS.getDrive(drive);
  if (!driveObj || driveObj.readOnly) return null;

  var cfg = DOS.fileLoad(drive, '/', 'a/gfxUpstash', 'system');
  if (!cfg.success || !cfg.content) return null;

  var val = cfg.content.trim();
  if (!val || val === 'false' || val === '0' || val === 'off') return null;

  // Explicit .gfx name in a/gfxUpstash (e.g. "cylon-queville.gfx")
  if (/\.gfx$/i.test(val)) return val;

  // Otherwise derive from drive source or drive name
  var src = (driveObj.source || driveObj.name || drive).split(/[?#]/)[0];
  var base = path.basename(src);
  if (/\.json$/i.test(base)) return base.replace(/\.json$/i, '.gfx');
  if (/\.gfx$/i.test(base))  return base;
  return driveObj.name + '.gfx';
}

function getUpstashUserKey(drive, userKey) {
  var gfx = getUpstashGfxNamespace(drive);
  if (!gfx) return null;
  return 'qandy:u:' + gfx + ':' + String(userKey).toLowerCase();
}

function upstashCmd(args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return Promise.resolve({ ok: false, error: 'Upstash not configured' });
  }
  return new Promise(function (resolve) {
    var parsed;
    try {
      parsed = new URL(UPSTASH_URL);
    } catch (e) {
      return resolve({ ok: false, error: 'Invalid UPSTASH_REDIS_REST_URL' });
    }

    var body = JSON.stringify(args);
    var transport = parsed.protocol === 'http:' ? http : https;
    var settled = false;
    function done(val) {
      if (!settled) { settled = true; resolve(val); }
    }

    var req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + UPSTASH_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8')
      }
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.warn('[Upstash] HTTP ' + res.statusCode);
          return done({ ok: false, error: 'HTTP ' + res.statusCode });
        }
        try {
          var data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data && data.error) {
            console.warn('[Upstash] Error:', data.error);
            return done({ ok: false, error: data.error });
          }
          return done({ ok: true, result: data ? data.result : null });
        } catch (err) {
          console.warn('[Upstash] Invalid JSON:', err.message);
          return done({ ok: false, error: err.message });
        }
      });
    });

    req.setTimeout(5000, function () {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', function (err) {
      console.warn('[Upstash] Request failed:', err.message);
      done({ ok: false, error: err.message });
    });

    req.write(body);
    req.end();
  });
}

async function upstashLoadUser(drive, userKey) {
  var key = getUpstashUserKey(drive, userKey);
  if (!key) return { ok: true, status: 'disabled', content: null };

  var res = await upstashCmd(['GET', key]);
  if (!res.ok) {
    return { ok: false, status: 'error', error: res.error };
  }
  if (typeof res.result === 'string' && res.result.length > 0) {
    DOS.fileSave(drive, '/', 'u/' + userKey, res.result, 'system', 'system');
    return { ok: true, status: 'found', content: res.result };
  }
  return { ok: true, status: 'not_found', content: null };
}

async function upstashSaveUser(drive, userKey, onlyIfAbsent) {
  var key = getUpstashUserKey(drive, userKey);
  if (!key) return { ok: true, status: 'disabled' };

  var uLoad = DOS.fileLoad(drive, '/', 'u/' + userKey, 'system');
  if (!uLoad.success || typeof uLoad.content !== 'string') {
    return { ok: false, status: 'error', error: 'missing local user file' };
  }

  // Using NX on account creation prevents two simultaneous registrations from overwriting each other
  var cmd = onlyIfAbsent
    ? ['SET', key, uLoad.content, 'NX']
    : ['SET', key, uLoad.content];

  var res = await upstashCmd(cmd);
  if (!res.ok) return { ok: false, status: 'error', error: res.error };
  if (onlyIfAbsent && res.result === null) return { ok: true, status: 'exists' };
  return { ok: res.result === 'OK', status: res.result === 'OK' ? 'saved' : 'error' };
}

var _flushPendingRunning = false;

async function flushPendingUpstashUsers() {
  if (_flushPendingRunning) return;
  _flushPendingRunning = true;
  try {
    var driveNames = DOS.listDrives();
    for (var di = 0; di < driveNames.length; di++) {
      var dn = driveNames[di];
      if (!getUpstashGfxNamespace(dn)) continue;
      var uList = DOS.fileList(dn, 'u/', null, 'system');
      if (!uList.success || !uList.listing) continue;
      var files = uList.listing.trim().split(/\s+/);
      for (var fi = 0; fi < files.length; fi++) {
        var userKey = files[fi];
        if (!userKey) continue;
        if (isUserActiveOnDrive(dn, userKey) || inFlightUsers.has(dn + ':' + userKey)) continue;
        var res = await upstashSaveUser(dn, userKey);
        if (
          res && res.ok && res.status === 'saved' &&
          !isUserActiveOnDrive(dn, userKey) &&
          !inFlightUsers.has(dn + ':' + userKey)
        ) {
          DOS.fileDelete(dn, '/', 'u/' + userKey, 'system');
        }
      }
    }
  } finally {
    _flushPendingRunning = false;
  }
}

setInterval(flushPendingUpstashUsers, 60000).unref();

async function flushAllPlayersToUpstash() {
  var tasks = [];
  for (var entry of playerIndex.entries()) {
    var sess = entry[0];
    var p = entry[1];
    if (p && p.userKey) {
      p.server = '';
      saveUserSnapshot(p, sess, { server: '' });
      tasks.push((function (drive, userKey) {
        return upstashSaveUser(drive, userKey).then(function (res) {
          if (res && res.ok && res.status === 'saved') {
            DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
          }
        });
      })(p.drive, p.userKey));
    }
  }
  await Promise.allSettled(tasks);
  await flushPendingUpstashUsers();
}

function findActiveSession(drive, userKey) {
  for (var entry of playerIndex.entries()) {
    var p = entry[1];
    if (p && p.drive === drive && p.userKey === userKey) {
      return { session: entry[0], player: p };
    }
  }
  return null;
}

var upstashAdmin = {
  isConfigured: function () {
    return !!(UPSTASH_URL && UPSTASH_TOKEN);
  },

  getNamespace: function (drive) {
    return getUpstashGfxNamespace(drive);
  },

  list: async function (drive, pattern) {
    var gfx = getUpstashGfxNamespace(drive);
    if (!gfx) return { ok: false, error: 'Upstash is not enabled on ' + drive + ':/' };

    var prefix = 'qandy:u:' + gfx + ':';
    var glob = (pattern || '*').toLowerCase();
    var cursor = '0';
    var seen = Object.create(null);
    var names = [];

    do {
      var res = await upstashCmd(['SCAN', cursor, 'MATCH', prefix + glob, 'COUNT', 100]);
      if (!res.ok) return { ok: false, error: res.error || 'Upstash SCAN failed' };
      if (!Array.isArray(res.result) || res.result.length < 2) break;
      cursor = String(res.result[0]);
      var keys = Array.isArray(res.result[1]) ? res.result[1] : [];
      for (var i = 0; i < keys.length; i++) {
        var k = String(keys[i]);
        if (k.indexOf(prefix) === 0) {
          var name = k.substring(prefix.length);
          if (name && !seen[name]) {
            seen[name] = true;
            names.push(name);
          }
        }
      }
    } while (cursor !== '0');

    names.sort();
    return { ok: true, gfx: gfx, names: names };
  },

  view: async function (drive, username) {
    var gfx = getUpstashGfxNamespace(drive);
    if (!gfx) return { ok: false, error: 'Upstash is not enabled on ' + drive + ':/' };

    var userKey = String(username || '').trim().toLowerCase();
    var res = await upstashCmd(['GET', 'qandy:u:' + gfx + ':' + userKey]);
    if (!res.ok) return { ok: false, error: res.error || 'Upstash GET failed' };
    if (typeof res.result !== 'string' || !res.result) {
      return { ok: false, error: 'Player "' + username + '" not found.' };
    }
    var rec = parsePlayerRecord(res.result);
    if (!rec) return { ok: false, error: 'Corrupt player record for "' + username + '".' };
    return { ok: true, gfx: gfx, record: rec, statusInfo: parsePlayerStatus(rec.status) };
  },

  setStatus: async function (drive, username, kind, durationArg) {
    var gfx = getUpstashGfxNamespace(drive);
    if (!gfx) return { ok: false, error: 'Upstash is not enabled on ' + drive + ':/' };

    var parsedDur = parseDurationToStatus(kind, durationArg);
    if (!parsedDur.ok) return { ok: false, error: parsedDur.error };

    var userKey = String(username || '').trim().toLowerCase();
    var key = 'qandy:u:' + gfx + ':' + userKey;
    var res = await upstashCmd(['GET', key]);
    if (!res.ok) return { ok: false, error: res.error || 'Upstash GET failed' };
    if (typeof res.result !== 'string' || !res.result) {
      return { ok: false, error: 'Player "' + username + '" not found.' };
    }
    var rec = parsePlayerRecord(res.result);
    if (!rec) return { ok: false, error: 'Corrupt player record for "' + username + '".' };

    var newStatus = parsedDur.status;
    var active = findActiveSession(drive, userKey);

    if (active) {
      active.player.status = newStatus;

      if (kind === 'ban' && newStatus !== 'player') {
        playerIndex.delete(active.session);
        kickedSessions.set(active.session, { msg: 'S^LO--LE22^S', at: Date.now() });
        await removePlayerFromWorld(active.player, active.session);
        return { ok: true, username: rec.username || userKey, status: newStatus, kicked: true };
      }

      if (kind === 'mute' && newStatus !== 'player' && active.player.chatPath) {
        DOS.fileDelete(drive, '/', active.player.chatPath, active.session);
        active.player.chatPath = null;
        active.player.chatLoc = null;
      }

      saveUserSnapshot(active.player, active.session, { status: newStatus });
      var saved = await upstashSaveUser(drive, userKey);
      if (!saved.ok) return { ok: false, error: saved.error || 'Upstash SET failed' };
      return { ok: true, username: rec.username || userKey, status: newStatus, kicked: false };
    }

    rec.status = newStatus;
    var setRes = await upstashCmd(['SET', key, serializePlayerRecord(rec)]);
    if (!setRes.ok) return { ok: false, error: setRes.error || 'Upstash SET failed' };
    return { ok: true, username: rec.username || userKey, status: newStatus, kicked: false };
  },

  del: async function (drive, username) {
    var gfx = getUpstashGfxNamespace(drive);
    if (!gfx) return { ok: false, error: 'Upstash is not enabled on ' + drive + ':/' };

    var userKey = String(username || '').trim().toLowerCase();
    var key = 'qandy:u:' + gfx + ':' + userKey;

    var active = findActiveSession(drive, userKey);
    if (active) {
      active.player.userKey = null; // prevent removePlayerFromWorld from re-saving to Upstash
      playerIndex.delete(active.session);
      kickedSessions.set(active.session, { msg: 'S^LO--^S', at: Date.now() });
      await removePlayerFromWorld(active.player, active.session);
    }

    if (DOS.fileExists(drive, '/', 'u/' + userKey).exists) {
      DOS.fileDelete(drive, '/', 'u/' + userKey, 'system');
    }

    var delRes = await upstashCmd(['DEL', key]);
    if (!delRes.ok) return { ok: false, error: delRes.error || 'Upstash DEL failed' };
    if (!delRes.result) {
      return { ok: false, error: 'Player "' + username + '" not found in Upstash.' };
    }
    return { ok: true, username: userKey, kicked: !!active };
  }
};

// ── HTTP server ───────────────────────────────────────────────────────────────

var server = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  var reqUrl = new URL(req.url, `http://${req.headers.host}`);
  var reqPathname = reqUrl.pathname;

  if ((reqPathname === '/qandyland.js') && req.method === 'POST') {
    readBody(req).then(async function (bodyText) {
      var command, drive, session;

      if (req.headers['content-type'] === 'application/x-www-form-urlencoded') {
        var params = new URLSearchParams(bodyText);
        command = params.get('c');
        drive   = params.get('d');
        session = params.get('s');
      } else {
        command = bodyText;
        drive   = reqUrl.searchParams.get('d');
        session = getSession(req);
      }

      if (command === 'SYS:DRIVES') {
        var driveNames = DOS.mounts()
          .filter(function (m) {
            return (m.source && /\.gfx$/i.test(m.source)) || DOS.dirExists(m.name, 'w');
          })
          .map(function (m) { return m.name; });
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end(driveNames.join(','));
      }

      if (command === 'SYS:INFO') {
        var info = {
          serverId: SERVER_ID,
          port: PORT,
          players: playerIndex.size,
          drives: DOS.mounts().map(function (m) {
            return {
              name: m.name,
              type: m.type,
              source: m.source,
              readOnly: m.readOnly,
              used: m.used,
              quota: m.quota
            };
          })
        };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(info));
      }

      if (command === 'SYS:KRYSTALS_LIST') {
        var list = Krystals.getList();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(list));
      }

      if (session && playerIndex.has(session)) {
        var cachedProfile = playerIndex.get(session);
        if (cachedProfile && cachedProfile.drive) {
          drive = cachedProfile.drive;
        }
      }

      if (drive) {
        drive = DOS.resolveDriveName(drive) || drive;
      }

      if (drive) {
        drive = DOS.resolveDriveName(drive) || drive;
      }

      if (typeof command === 'string' && command.indexOf('GFX:') === 0) {
        return handleGfxDevCommand(req, res, command.slice(4), drive, session);
      }

      await plugboard(req, res, command, drive, session);

    }).catch(err => {
      console.error("HTTP 500 ERROR:", err.stack || err);
      res.writeHead(500);
      res.end("Server Error");
    });
    return;
  }

  var pathname = path.normalize(decodeURIComponent(reqUrl.pathname).replace(/\0/g, ''));
  if (pathname === '/') pathname = '/index.htm';
  var filePath = path.join(__dirname, pathname);
  var realBase = fs.realpathSync(__dirname);
  try {
    var resolvedPath = fs.realpathSync(filePath);
    if (!resolvedPath.startsWith(realBase) || pathname.includes('.sys!')) return serve404(res);
    fs.stat(resolvedPath, function (err, stat) {
      if (err || !stat.isFile()) return serve404(res);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(resolvedPath).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(resolvedPath).pipe(res);
    });
  } catch (e) { serve404(res); }
});

// ── Server initialization ─────────────────────────────────────────────────────

var commandExecutor = Command.createExecutor({
  dos: DOS,
  krystals: Krystals,
  upstash: upstashAdmin,
  getPlayers: function () { return playerIndex; },
  shutdown: async function () {
    setTimeout(function () {
      process.stdout.write('Forcing shutdown...\n');
      process.exit(0);
    }, 5000).unref();

    try {
      await flushAllPlayersToUpstash();
    } catch (e) {
      console.warn('[Upstash] Shutdown flush failed:', e.message);
    }

    server.close(function () {
      process.stdout.write('All connections closed. HTTP server stopped.\n\n');
      process.exit(0);
    });
  }
});

async function _proceedWithStartup() {
  var cfgPath = path.resolve(process.cwd(), CLI_CONFIG.cfgFile);
  var usedConfig = false;

  // 1. Run qandyland.cfg (mirrors cylon.cfg autoexec) if present
  if (fs.existsSync(cfgPath)) {
    usedConfig = true;
    console.log('Executing boot config: ' + CLI_CONFIG.cfgFile);
    var cfgLines = fs.readFileSync(cfgPath, 'utf8').split(/\r?\n/);
    for (var ci = 0; ci < cfgLines.length; ci++) {
      var line = cfgLines[ci].trim();
      if (!line || line.startsWith('//') || line.startsWith(';') || line.startsWith('#')) continue;
      var res = await commandExecutor(line);
      if (res && res.output) console.log('  ' + res.output);
    }
  }

  // 2. Apply any CLI --mount <source>[:name][:type] flags
  if (CLI_CONFIG.mounts.length > 0) {
    usedConfig = true;
    for (var mi = 0; mi < CLI_CONFIG.mounts.length; mi++) {
      var parts = CLI_CONFIG.mounts[mi].split(':');
      // Handle URLs like https://host/world.json:world:rom
      var src = parts[0];
      var restParts = parts.slice(1);
      if (/^https?$/i.test(src) && restParts.length > 0) {
        src = src + ':' + restParts.shift();
      }
      var mName = restParts[0] || null;
      var mType = restParts[1] || 'ram';
      try {
        var mounted = await DOS.mount(src, mName, { type: mType });
        console.log('  Mounted ' + mounted + ':/ (' + mType + ') from ' + src);
      } catch (e) {
        console.error('  Failed to mount ' + src + ': ' + e.message);
      }
    }
  }

  // 3. Default startup drives if no config/CLI mounts were provided
  // if (!usedConfig) {
  //   var driveList = ['cylon-capflag.gfx', 'cylon-desktop.gfx', 'cylon-queville.gfx'];
  //   for (var i = 0; i < driveList.length; i++) {
  //     var file = driveList[i];
  //     var filepath = path.resolve(process.cwd(), file);
  //     if (!fs.existsSync(filepath)) {
  //       console.warn('  Warning: File ' + file + ' not found on disk.');
  //       continue;
  //     }
  //     try {
  //       var mountedName = await DOS.mount(file, null, { type: 'ram' });
  //       console.log('  ✓ Mounted ' + mountedName + ':/ from ' + file);
  //     } catch (e) {
  //       console.error('  ✗ Failed to mount ' + file + ': ' + e.message);
  //     }
  //   }
  // }
}

(async function _initializeServer() {
  await _proceedWithStartup();

  server.listen(PORT, '0.0.0.0', function () {
    Krystals.init(server);

    var publicIP = '127.0.0.1';
    displayStartupBanner(publicIP, null, SERVER_ID);

    Command.init({
      dos: DOS,
      execute: commandExecutor
    });
  });
})();

async function shutdownWithFlush() {
  try {
    await flushAllPlayersToUpstash();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdownWithFlush);
process.on('SIGTERM', shutdownWithFlush);

process.on('uncaughtException', function (err) {
  console.error("UNCAUGHT EXCEPTION:", err.stack || err);
});

process.on('unhandledRejection', function (reason, p) {
  console.error("UNHANDLED PROMISE REJECTION:", reason.stack || reason);
});
