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
var path   = require('path');
var fs     = require('fs');
var crypto = require('crypto');

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

// ── Player Auth, Snapshots & Idle Cleanup ─────────────────────────────────────

var DEFAULT_PLAYER_ITEM = 'Sa';
var DEFAULT_PLAYER_INV  = 'Za'.repeat(20);
var IDLE_LOGOUT_MS      = 120000; // 2 minutes without a ping removes idle player from /w/

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

function saveUserSnapshot(player, session, passwordHashOverride) {
  if (!player || !player.drive || !player.userKey) return;
  var drive = player.drive;
  var uPath = 'u/' + player.userKey;

  var gfxZBase = 10;
  var zBaseLoad = DOS.fileLoad(drive, '/', 'a/gfxZBase', 'system');
  if (zBaseLoad.success && zBaseLoad.content) {
    var parsed = parseInt(zBaseLoad.content, 10);
    if (!isNaN(parsed) && ((parsed >= 2 && parsed <= 36) || parsed === 52)) gfxZBase = parsed;
  }

  var existing = DOS.fileLoad(drive, '/', uPath, 'system');
  var exactName = player.username || player.userKey;
  var passHash  = passwordHashOverride || '';
  if (existing.success && existing.content) {
    var lines = existing.content.split('\n');
    if (lines[0]) exactName = lines[0].trim();
    if (!passHash && lines[1]) passHash = lines[1].trim();
  }

  var invContent = DEFAULT_PLAYER_INV;
  if (player.fullPath) {
    var pFile = DOS.fileLoad(drive, '/', player.fullPath, session || 'system');
    if (pFile.success && typeof pFile.content === 'string') {
      invContent = pFile.content;
    }
  }

  var itemId = (player.item && player.item.length >= 2) ? player.item.substring(0, 2) : DEFAULT_PLAYER_ITEM;
  var zStr   = encodeZ(parseInt(player.z, 10) || 0, gfxZBase);
  var stateLine = [itemId, player.map || 'Bc', zStr, player.avatar || '', invContent].join('|');

  DOS.fileSave(drive, '/', uPath, exactName + '\n' + passHash + '\n' + stateLine, 'system', 'system');
}

function removePlayerFromWorld(player, session) {
  if (!player || !player.drive) return;
  if (player.userKey) {
    saveUserSnapshot(player, session);
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
}

setInterval(function () {
  var now = Date.now();
  for (var entry of playerIndex.entries()) {
    var sess = entry[0];
    var p = entry[1];
    if (p && p.lastSeen && (now - p.lastSeen > IDLE_LOGOUT_MS)) {
      removePlayerFromWorld(p, sess);
      playerIndex.delete(sess);
    }
  }
}, 30000).unref();

// ── Plugboard Command Processor ───────────────────────────────────────────────

function plugboard(req, stacker, plugs, drive, session) {

  drive = DOS.resolveDriveName(drive) || drive;

  var skipPostTick = false;

  let gfxZBase = 10;
  let zBaseLoad = DOS.fileLoad(drive, '/', 'a/gfxZBase', session);
  if (zBaseLoad.success && zBaseLoad.content) {
    let parsedBase = parseInt(zBaseLoad.content, 10);
    if (!isNaN(parsedBase) && ((parsedBase >= 2 && parsedBase <= 36) || parsedBase === 52)) gfxZBase = parsedBase;
  }

  let output = "";

  function runtape(code) {
    if (code) {
      let uResult = UNIVAC(drive, player.fullPath, "RAM:" + code, session);
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
      let uResult = UNIVAC(drive, player.fullPath, filepath, session);
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
            let uResult = UNIVAC(drive, player.fullPath, objfile, session);
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
                let uResult = UNIVAC(drive, player.fullPath, 'w/f', session);
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
        let uLoad = DOS.fileLoad(drive, '/', 'u/' + userKey, 'system');
        if (!uLoad.success || !uLoad.content) {
          output += "S^LE13^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        }

        let lines = uLoad.content.split('\n');
        let exactName  = (lines[0] || uName).trim();
        let storedHash = (lines[1] || '').trim();

        if (!verifyPassword(uPass, storedHash)) {
          output += "S^LE09^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        }

        let alreadyActive = false;
        for (let [otherSess, otherP] of playerIndex.entries()) {
          if (otherSess !== session && otherP.drive === drive && otherP.userKey === userKey) {
            if (Date.now() - (otherP.lastSeen || 0) < 10000) {
              alreadyActive = true;
              break;
            } else {
              removePlayerFromWorld(otherP, otherSess);
              playerIndex.delete(otherSess);
            }
          }
        }
        if (alreadyActive) {
          output += "S^LE20^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        }

        uLoad = DOS.fileLoad(drive, '/', 'u/' + userKey, 'system');
        lines = (uLoad.content || '').split('\n');
        let savedParts = (lines[2] || '').split('|');

        if (player.fullPath || player.pubId) {
          removePlayerFromWorld(player, session);
          player.fullPath = null;
          player.userKey  = null;
          player.username = null;
        }

        let sp = getSpawnDefaults(drive, gfxZBase);
        let pId      = savedParts[0] || DEFAULT_PLAYER_ITEM;
        let pSector  = savedParts[1] || sp.sector;
        let pZStr    = savedParts[2] || sp.zStr;
        let pAvatar  = savedParts[3] || '';
        let pContent = savedParts[4] !== undefined ? savedParts[4] : DEFAULT_PLAYER_INV;
        let newPubId = UNIVAC.tickOdometer(drive);

        let restoredPath = 'w/' + pSector + '/' + pId + pZStr + newPubId + pAvatar;
        DOS.fileSave(drive, '/', restoredPath, pContent, session, session);
        DOS.fileSave(drive, '/', 'p/' + newPubId, pSector + pZStr + pAvatar, session, session);

        player.fullPath = restoredPath;
        player.map      = pSector;
        player.z        = decodeZ(pZStr, gfxZBase);
        player.item     = pId + newPubId;
        player.avatar   = pAvatar;
        player.pubId    = newPubId;
        player.username = exactName;
        player.userKey  = userKey;
        player.lastSeen = Date.now();

        output += "S^LI" + exactName + "--^S";
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
        if (DOS.fileExists(drive, '/', 'u/' + userKey).exists) {
          output += "S^LE10^S";
          refresh = false; skipPostTick = true;
          column = plugs.length;
          break;
        }

        if (!player.item || player.item.startsWith('Za')) {
          runtape("Xa" + DEFAULT_PLAYER_ITEM + DEFAULT_PLAYER_INV + "--");
        }

        player.username = uName;
        player.userKey  = userKey;
        player.lastSeen = Date.now();
        saveUserSnapshot(player, session, hashPassword(uPass));

        output += "S^LC" + uName + "--^S";
        break;
      }

      case 'LO': {
        if (tape) { runtape(tape); tape = ""; }
        removePlayerFromWorld(player, session);
        if (session) playerIndex.delete(session);
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
    readBody(req).then(function (bodyText) {
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

      plugboard(req, res, command, drive, session);

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
  getPlayers: function () { return playerIndex; },
  shutdown: function () {
    server.close(function () {
      process.stdout.write('All connections closed. HTTP server stopped.\n\n');
      process.exit(0);
    });
    setTimeout(function () {
      process.stdout.write('Forcing shutdown...\n');
      process.exit(0);
    }, 3000);
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

process.on('SIGINT', function () {
  process.exit(0);
});

process.on('SIGTERM', function () {
  process.exit(0);
});

process.on('uncaughtException', function (err) {
  console.error("UNCAUGHT EXCEPTION:", err.stack || err);
});

process.on('unhandledRejection', function (reason, p) {
  console.error("UNHANDLED PROMISE REJECTION:", reason.stack || reason);
});
