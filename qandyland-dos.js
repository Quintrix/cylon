'use strict';

//
// ──── Qandyland DOS – Storage & Mount Layer ──────────────────────────────────
//
// RAM and ROM mount table, clean drive names, quotas, read-only images,
// JSON archive import/export, and synchronous file/dir operations for UNIVAC
// and plugboard().
//

var fs    = require('fs');
var path  = require('path');
var http  = require('http');
var https = require('https');

// ── Configuration ─────────────────────────────────────────────────────────────

var MANIFEST_KEY         = '_dir.sys!';
var ARCHIVE_FORMAT       = 'qandy-ramdrive';
var ARCHIVE_VERSION      = 2;
var MAX_NAME_BYTES       = 255;
var DEFAULT_QUOTA        = 32 * 1024 * 1024; // 32 MB per drive
var MAX_TOTAL_DRIVE_SIZE = DEFAULT_QUOTA;
var MIN_QUOTA            = 16 * 1024;
var MAX_QUOTA            = 2 * 1024 * 1024 * 1024 * 1024;
var MAX_FILE_BYTES       = 512 * 1024;       // 512 KB per file
var MAX_DRIVE_FILES      = 20000;
var MAX_ROM_BYTES        = 64 * 1024 * 1024;
var VALID_NAME_RE        = /^(?!\.)(?!.*[\\/])[A-Za-z0-9 \-_.()+=!%,:;\[\]\^_{}@]+$/;
var DRIVE_RE             = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
var RESERVED_NAMES       = ['none'];

// ── State ─────────────────────────────────────────────────────────────────────

var drives      = Object.create(null);
var mountOrder  = [];
var currentName = null;
var _driveCwds  = Object.create(null);
var _bigbangFn  = null;

function injectBigBang(fn) {
  _bigbangFn = fn;
}

// ── Drive Lookup & Mount Table Helpers ────────────────────────────────────────

function resolveDriveName(driveName) {
  var name = String(driveName == null ? '' : driveName).trim().replace(/:$/, '');
  if (!name) return null;
  if (drives[name]) return name;
  var stripped = name.replace(/\.(json|gfx)$/i, '');
  if (stripped && drives[stripped]) return stripped;
  return null;
}

function getDrive(driveName) {
  var resolved = resolveDriveName(driveName);
  return resolved ? drives[resolved] : null;
}

function listDrives() {
  return mountOrder.slice();
}

function getDriveCwd(driveName) {
  var resolved = resolveDriveName(driveName);
  return (resolved && _driveCwds[resolved]) ? _driveCwds[resolved] : '/';
}

function setDriveCwd(driveName, cwd) {
  var resolved = resolveDriveName(driveName) || driveName;
  if (!resolved) return;
  _driveCwds[resolved] = cwd || '/';
}

function current() {
  return currentName ? drives[currentName] : null;
}

function setDrive(name) {
  var resolved = resolveDriveName(name);
  if (!resolved) throw new Error('drive not mounted: ' + String(name || '').replace(/:$/, ''));
  currentName = resolved;
  return resolved;
}

function pwd() {
  var m = current();
  if (!m) return '(no drive)';
  var cwd = getDriveCwd(m.name).replace(/^\/+|\/+$/g, '');
  return m.name + ':/' + cwd;
}

function sourceName(spec) {
  spec = String(spec || '').trim();
  if (!spec || spec.charAt(0) === '{') return '';
  var clean = spec.split(/[?#]/)[0];
  var name = rawBaseName(clean);
  return name.replace(/\.(json|gfx)$/i, '');
}

// ── Time, Size & Name Helpers ─────────────────────────────────────────────────

function timestamp() {
  var d = new Date();
  var pad = function (n, w) { return String(n).padStart(w || 2, '0'); };
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function futureTimestamp(minutes) {
  var d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  var pad = function (n, w) { return String(n).padStart(w || 2, '0'); };
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function utf8len(s) {
  return Buffer.byteLength(String(s == null ? '' : s), 'utf8');
}

function formatSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  var units = ['KB', 'MB', 'GB', 'TB'];
  var i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + units[i];
}

function formatBytes(bytes) {
  if (bytes === 0) return '0B';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB';
  return Math.round(bytes / (1024 * 1024)) + 'MB';
}

function parseSize(text) {
  var m = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)(?:i?b)?\s*$/i.exec(String(text == null ? '' : text));
  if (!m) throw new Error('invalid size: ' + text + ' (examples: 512K, 10M, 1G)');
  var mult = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2].toLowerCase()];
  var bytes = Math.floor(parseFloat(m[1]) * mult);
  if (!(bytes > 0)) throw new Error('invalid size: ' + text);
  if (bytes < MIN_QUOTA) throw new Error('drive too small (minimum ' + formatSize(MIN_QUOTA) + ')');
  if (bytes > MAX_QUOTA) throw new Error('drive too large (maximum ' + formatSize(MAX_QUOTA) + ')');
  return bytes;
}

function normName(n) {
  return (typeof n === 'string') ? n.trim() : String(n == null ? '' : n).trim();
}

function rawBaseName(p) {
  var s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, ''); //'
  var slash = s.lastIndexOf('/');
  return slash < 0 ? s : s.substring(slash + 1);
}

function baseName(name) {
  var n = normName(name);
  var slash = n.lastIndexOf('/');
  if (slash >= 0) n = n.substring(slash + 1);
  if (n.charAt(0) === '_') n = n.substring(1);
  if (n.length > 0 && n.charAt(n.length - 1) === '!') n = n.substring(0, n.length - 1);
  return n;
}

function validateName(name) {
  var n = normName(name);
  if (!n) return { ok: false, reason: 'empty filename' };
  if (!VALID_NAME_RE.test(n)) return { ok: false, reason: 'invalid characters in filename' };
  if (utf8len(n) > MAX_NAME_BYTES) return { ok: false, reason: 'filename exceeds 255 bytes' };
  return { ok: true };
}

function isWriteProtected(name) {
  var n = normName(name);
  return n.charAt(n.length - 1) === '!';
}

function isHidden(name) {
  var n = normName(name);
  var slash = n.lastIndexOf('/');
  var b = slash >= 0 ? n.substring(slash + 1) : n;
  return b.charAt(0) === '_';
}

function resolveName(cwd, name) {
  var base = (cwd || '/').replace(/^\//, '').replace(/\/$/, '');
  var n = normName(name);
  if (n.indexOf('/') >= 0) {
    return n.replace(/^\//, '');
  }
  return base ? (base + '/' + n) : n;
}

function normalizePath(p, base) {
  p = String(p == null ? '' : p).trim().replace(/\\/g, '/'); //'
  base = String(base == null ? '' : base).replace(/^\/+|\/+$/g, '');
  var parts = (p.charAt(0) === '/' ? p : (base ? base + '/' : '') + p).split('/');
  var result = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length) result.pop();
      continue;
    }
    result.push(part);
  }
  return result.join('/');
}

function extractWildcard(inputPath) {
  inputPath = String(inputPath == null ? '' : inputPath).trim();
  if (!/[*?]/.test(inputPath)) return { path: inputPath, regex: null };

  var slash = inputPath.lastIndexOf('/');
  var colon = inputPath.lastIndexOf(':');
  var splitAt = Math.max(slash, colon);

  var dirPath = splitAt >= 0 ? inputPath.substring(0, splitAt + 1) : '';
  var pattern = splitAt >= 0 ? inputPath.substring(splitAt + 1) : inputPath;

  var esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return { path: dirPath, regex: new RegExp('^' + esc + '$', 'i') };
}

function matchPattern(name, pattern) {
  if (!pattern) return true;
  var escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp('^' + escaped + '$', 'i').test(name);
  } catch (e) {
    return false;
  }
}

// ── Expiration / Garbage Collection ───────────────────────────────────────────

function isExpiredTimestamp(ts, now) {
  if (!ts || ts.charAt(0) !== 'X') return false;
  return (now || timestamp()) >= ts.substring(1);
}

function _expireEntry(driveName, canonical, existing) {
  var drive = drives[driveName];
  if (!drive) return;
  _storageDelete(drive.storage, canonical);
  drive.manifestMap.delete(canonical);
  if (canonical.charAt(0) !== '<' && existing) {
    drive.fileCount = Math.max(0, drive.fileCount - 1);
    drive.totalSize = Math.max(0, drive.totalSize - (existing.size || 0));
  }
  _debounceSaveManifestToStorage(driveName);
}

function sweepExpired(driveName) {
  var now = timestamp();
  var targetNames = driveName ? [driveName] : Object.keys(drives);
  for (var i = 0; i < targetNames.length; i++) {
    var dn = targetNames[i];
    var drive = drives[dn];
    if (!drive || !drive.manifestMap) continue;
    var expired = [];
    drive.manifestMap.forEach(function (e, key) {
      if (isExpiredTimestamp(e.timestamp, now)) {
        expired.push({ key: key, entry: e });
      }
    });
    for (var j = 0; j < expired.length; j++) {
      _expireEntry(dn, expired[j].key, expired[j].entry);
    }
  }
}

setInterval(function () {
  sweepExpired();
}, 60000).unref();

// ── Storage Helpers ───────────────────────────────────────────────────────────

function _storageGet(storage, key) {
  var val = storage.get(key);
  return val !== undefined ? val : null;
}

function _storageSet(storage, key, value) {
  storage.set(key, value);
}

function _storageDelete(storage, key) {
  storage.delete(key);
}

// ── Manifest Helpers ──────────────────────────────────────────────────────────

var _manifestDebounceTimers = new Map();

function _debounceSaveManifestToStorage(driveName) {
  if (_manifestDebounceTimers.has(driveName)) {
    clearTimeout(_manifestDebounceTimers.get(driveName));
  }
  var timer = setTimeout(function () {
    _serializeManifestMapToStorage(driveName);
    _manifestDebounceTimers.delete(driveName);
  }, 50);
  if (timer.unref) timer.unref();
  _manifestDebounceTimers.set(driveName, timer);
}

function _serializeManifestMapToStorage(driveName) {
  var drive = drives[driveName];
  if (!drive || !drive.manifestMap) return;

  var ts = timestamp();
  var lines = [];
  drive.manifestMap.forEach(function (e) {
    if (e.name === MANIFEST_KEY) return;
    lines.push(
      e.name + '|' + e.size + '|' + e.timestamp + '|' +
      (e.owner || '') + '|' + (e.session || '')
    );
  });

  var body     = lines.length ? lines.join('\n') + '\n' : '';
  var selfLine = MANIFEST_KEY + '|0|' + ts;
  var full     = body + selfLine;
  var mSize    = utf8len(full);
  selfLine     = MANIFEST_KEY + '|' + mSize + '|' + ts;
  full         = body + selfLine;

  var finalSize = utf8len(full);
  if (finalSize !== mSize) {
    selfLine = MANIFEST_KEY + '|' + finalSize + '|' + ts;
    full     = body + selfLine;
  }
  _storageSet(drive.storage, MANIFEST_KEY, full);
}

function _readManifest(driveName) {
  var drive = drives[driveName];
  if (!drive || !drive.manifestMap) {
    console.error('_readManifest called on uninitialized drive: ' + driveName);
    return [];
  }
  return Array.from(drive.manifestMap.values());
}

function _saveManifest(driveName, entries) {
  var drive = drives[driveName];
  if (!drive) return;

  drive.manifestMap.clear();
  var currentTotalSize = 0;
  var currentFileCount = 0;

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.name === MANIFEST_KEY) continue;
    drive.manifestMap.set(e.name, {
      name: e.name,
      size: e.size,
      timestamp: e.timestamp,
      owner: e.owner,
      session: e.session
    });
    if (e.name.charAt(0) !== '<') {
      currentFileCount++;
      currentTotalSize += e.size;
    }
  }
  drive.fileCount = currentFileCount;
  drive.totalSize = currentTotalSize;
  _debounceSaveManifestToStorage(driveName);
}

function _findEntry(manifest, userInput) {
  var base = baseName(normName(userInput)).toLowerCase();
  for (var i = 0; i < manifest.length; i++) {
    var entry = manifest[i];
    if (baseName(normName(entry.name)).toLowerCase() === base) return entry;
  }
  return null;
}

function findEntry(driveName, pathOrName) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return null;
  var entry = drive.manifestMap.get(pathOrName) || null;
  if (!entry) entry = _findEntry(_readManifest(resolved), pathOrName);
  if (entry && isExpiredTimestamp(entry.timestamp)) {
    _expireEntry(resolved, entry.name, entry);
    return null;
  }
  return entry;
}

// ── Drive Stats & Debug Info ──────────────────────────────────────────────────

function calculateDriveStats(drive) {
  if (typeof drive.fileCount === 'number' && typeof drive.totalSize === 'number') {
    return { fileCount: drive.fileCount, totalSize: drive.totalSize };
  }
  var fileCount = 0, totalSize = 0;
  (drive.storage || new Map()).forEach(function (val, key) {
    if (key !== MANIFEST_KEY && key.charAt(0) !== '<') {
      fileCount++;
      totalSize += utf8len(val);
    }
  });
  drive.fileCount = fileCount;
  drive.totalSize = totalSize;
  return { fileCount: fileCount, totalSize: totalSize };
}

function getDriveDebugInfo(driveName) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return null;
  var stats = calculateDriveStats(drive);
  var dirTokens = [];
  var fileEntries = [];
  drive.storage.forEach(function (val, key) {
    if (!key) return;
    if (key.charAt(0) === '<') {
      dirTokens.push({ key: key, val: val });
    } else if (key !== MANIFEST_KEY) {
      fileEntries.push({ key: key, val: val });
    }
  });
  return {
    driveName: resolved,
    type: drive.type || 'ram',
    source: drive.source || '',
    readOnly: !!drive.readOnly,
    owner: drive.owner || 'none',
    created: drive.created || 'unknown',
    stats: stats,
    storageSize: drive.storage.size,
    dirTokens: dirTokens,
    fileEntries: fileEntries,
    manifestEntries: _readManifest(resolved)
  };
}

// ── Remote / Local Source Loader (for mount) ──────────────────────────────────

function fetchUrl(urlStr, redirects) {
  redirects = redirects || 0;
  if (redirects > 5) return Promise.reject(new Error('too many redirects'));
  return new Promise(function (resolve, reject) {
    var mod = urlStr.indexOf('https://') === 0 ? https : http;
    mod.get(urlStr, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        var next = new URL(res.headers.location, urlStr).toString();
        return fetchUrl(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('cannot load ' + urlStr + ': HTTP ' + res.statusCode));
      }
      var chunks = [];
      var total = 0;
      res.on('data', function (chunk) {
        total += chunk.length;
        if (total > MAX_ROM_BYTES) {
          res.destroy();
          return reject(new Error('image too large (exceeds ' + formatSize(MAX_ROM_BYTES) + ')'));
        }
        chunks.push(chunk);
      });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function loadArchiveText(spec, options) {
  if (options && options.data != null) return String(options.data);
  spec = String(spec || '').trim();
  if (!spec) return '';
  if (spec.charAt(0) === '{') return spec;
  if (/^https?:\/\//i.test(spec)) {
    return await fetchUrl(spec);
  }
  var resolvedPath = path.resolve(process.cwd(), spec);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('cannot load ' + spec + ': file not found');
  }
  return fs.readFileSync(resolvedPath, 'utf8');
}

// ── Mount Table & Drive Lifecycle ─────────────────────────────────────────────

var MOUNT_TYPES = {
  ram: 'ram',
  rom: 'rom',
  idb: 'idb', indexdb: 'idb', indexeddb: 'idb',
  ls: 'ls', localstorage: 'ls',
  host: 'host'
};

function mountType(text) {
  return MOUNT_TYPES[String(text == null ? '' : text).trim().toLowerCase()] || null;
}

function driveCreate(driveName, session, options) {
  options = options || {};
  var name = normName(driveName);
  var fv = validateName(name);
  if (!fv.ok) return { success: false, error: 'invalid drive name: ' + fv.reason };
  if (!DRIVE_RE.test(name) || RESERVED_NAMES.indexOf(name.toLowerCase()) >= 0) {
    return { success: false, error: 'invalid drive name: ' + name };
  }
  if (drives[name]) return { success: false, error: 'drive already exists' };

  var ts = timestamp();
  drives[name] = {
    name:        name,
    type:        options.type || 'ram',
    source:      options.source || (options.type === 'ram' ? 'ram:' : name),
    readOnly:    !!options.readOnly,
    quota:       options.quota || DEFAULT_QUOTA,
    mounted:     new Date().toISOString(),
    storage:     new Map(),
    manifestMap: new Map(),
    owner:       session || 'console',
    created:     ts,
    fileCount:   0,
    totalSize:   0
  };

  mountOrder.push(name);
  if (!currentName) currentName = name;
  _saveManifest(name, []);
  return { success: true, result: 'drive created' };
}

function driveMount(driveName, session) {
  var resolved = resolveDriveName(driveName);
  if (!resolved) return { success: false, error: 'drive not found' };
  currentName = resolved;
  return { success: true, result: resolved + ':' + getDriveCwd(resolved), cwd: getDriveCwd(resolved) };
}

function driveDelete(driveName) {
  var dn = resolveDriveName(driveName) || normName(driveName);
  if (!drives[dn]) return { success: false, error: 'drive "' + dn + '" not found' };
  if (_manifestDebounceTimers.has(dn)) {
    clearTimeout(_manifestDebounceTimers.get(dn));
    _manifestDebounceTimers.delete(dn);
  }
  delete drives[dn];
  delete _driveCwds[dn];
  var idx = mountOrder.indexOf(dn);
  if (idx >= 0) mountOrder.splice(idx, 1);
  if (currentName === dn) currentName = mountOrder.length ? mountOrder[0] : null;
  return { success: true };
}

async function mount(source, name, options) {
  if (name && typeof name === 'object') { options = name; name = null; }
  options = options || {};
  name = name ? String(name).trim() : '';
  source = String(source == null ? '' : source).trim();
  if (!source) throw new Error('mount source required');

  var kind = null;
  var rest = source;
  var scheme = /^(ram|rom|idb|ls|host):([\s\S]*)$/i.exec(source);
  if (scheme) {
    kind = mountType(scheme[1]);
    rest = scheme[2].trim();
  }

  if (options.type != null && String(options.type).trim() !== '') {
    var wanted = mountType(options.type);
    if (!wanted) throw new Error('unknown mount type: ' + options.type + ' (use ram or rom)');
    if (kind && kind !== wanted) {
      throw new Error('source says "' + kind + ':" but the mount type is "' + wanted + '"');
    }
    kind = wanted;
  }

  if (!kind) {
    var sLower = rest.toLowerCase();
    if (sLower.endsWith('.gfx') || sLower.endsWith('.json') || rest.charAt(0) === '{' || /^https?:\/\//i.test(rest)) {
      kind = 'ram';
    } else {
      throw new Error('mount type required: ram or rom (' + source + ')');
    }
  }

  if (kind === 'idb' || kind === 'ls' || kind === 'host') {
    throw new Error('mount type "' + kind + '" is not supported on server (use ram or rom)');
  }

  var driveName = name || sourceName(rest) || (kind === 'ram' ? 'ram' : '');
  if (!driveName || !DRIVE_RE.test(driveName) || RESERVED_NAMES.indexOf(driveName.toLowerCase()) >= 0) {
    throw new Error('invalid drive name: ' + (driveName || '(empty)'));
  }
  if (drives[driveName]) {
    throw new Error('drive name already in use: ' + driveName);
  }

  var quota = options.quota || DEFAULT_QUOTA;
  var displaySource = rest
    ? (rest.charAt(0) === '{' ? '(inline)' : (kind === 'ram' && !scheme ? rest : (scheme ? source : rest)))
    : (kind + ':');

  var created = driveCreate(driveName, 'system', {
    type: kind,
    source: displaySource,
    readOnly: false, // locked after initial population
    quota: quota
  });
  if (!created.success) throw new Error(created.error);

  try {
    if (rest) {
      var rawText = await loadArchiveText(rest, options);
      if (utf8len(rawText) > MAX_ROM_BYTES) {
        throw new Error('image too large (' + formatSize(utf8len(rawText)) + ')');
      }
      if (rawText.trim().charAt(0) === '{') {
        var impRes = importDriveData(driveName, rawText, 'system', { mode: 'replace' });
        if (!impRes.success) throw new Error(impRes.error);
      } else {
        if (typeof _bigbangFn !== 'function') {
          throw new Error('bigbang loader not initialized for legacy .gfx file');
        }
        var bbRes = _bigbangFn(driveName, rest, 'system', rawText);
        if (!bbRes || !bbRes.success) {
          throw new Error((bbRes && bbRes.error) || 'failed to initialize world from ' + rest);
        }
      }
    } else if (kind === 'rom') {
      throw new Error('rom source required (URL, .gfx or .json file)');
    }
  } catch (err) {
    driveDelete(driveName);
    throw err;
  }

  drives[driveName].readOnly = (kind === 'rom') || !!options.readOnly;
  return driveName;
}

function umount(name) {
  var resolved = resolveDriveName(name);
  if (!resolved || !drives[resolved]) {
    throw new Error('drive not mounted: ' + String(name == null ? '' : name).trim().replace(/:$/, ''));
  }
  driveDelete(resolved);
  return true;
}

function mounts() {
  var rows = [];
  for (var i = 0; i < mountOrder.length; i++) {
    var name = mountOrder[i];
    var d = drives[name];
    if (!d) continue;
    var stats = calculateDriveStats(d);
    rows.push({
      name: d.name,
      type: d.type || 'ram',
      source: d.source || d.name,
      readOnly: !!d.readOnly,
      current: d.name === currentName,
      mounted: d.mounted || '',
      cwd: getDriveCwd(d.name),
      used: stats.totalSize,
      count: stats.fileCount,
      quota: d.quota || DEFAULT_QUOTA
    });
  }
  return rows;
}

function formatDrive(name) {
  var resolved = resolveDriveName(name);
  if (!resolved || !drives[resolved]) {
    throw new Error('drive not mounted: ' + name);
  }
  var drive = drives[resolved];
  if (drive.readOnly) {
    throw new Error('drive is read-only: ' + resolved);
  }
  var erased = drive.manifestMap.size;
  drive.storage.clear();
  drive.manifestMap.clear();
  drive.fileCount = 0;
  drive.totalSize = 0;
  _driveCwds[resolved] = '/';
  _saveManifest(resolved, []);
  return { name: resolved, erased: erased };
}

// ── File Operations ───────────────────────────────────────────────────────────

function fileSave(driveName, cwd, name, content, session, owner, customTs) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted here' };
  if (drive.readOnly) return { success: false, error: 'drive is read-only: ' + resolved };

  var fname = normName(name);
  if (!fname) return { success: false, error: 'invalid filename' };
  var fv = validateName(baseName(fname));
  if (!fv.ok) return { success: false, error: fv.reason };

  var canonical = resolveName(cwd, fname);
  var existing = drive.manifestMap.get(canonical);

  if (existing && isWriteProtected(existing.name)) {
    return { success: false, error: 'file is write-protected' };
  }

  var str  = String(content == null ? '' : content);
  var size = utf8len(str);

  if (size > MAX_FILE_BYTES) return { success: false, error: 'file too large (max ' + formatBytes(MAX_FILE_BYTES) + ')' };

  if (!existing && drive.fileCount >= MAX_DRIVE_FILES) return { success: false, error: 'drive full' };
  var oldSize = existing ? existing.size : 0;
  var limit = drive.quota || DEFAULT_QUOTA;
  if (drive.totalSize - oldSize + size > limit) {
    return { success: false, error: 'drive full: ' + formatSize(limit) + ' limit exceeded' };
  }

  var ts = customTs || timestamp();
  _storageSet(drive.storage, canonical, str);

  drive.manifestMap.set(canonical, {
    name:      canonical,
    size:      size,
    timestamp: ts,
    owner:     owner || session,
    session:   session
  });

  if (!existing && canonical.charAt(0) !== '<') drive.fileCount++;
  if (canonical.charAt(0) !== '<') drive.totalSize += (size - oldSize);

  _debounceSaveManifestToStorage(resolved);
  return { success: true, result: true };
}

function fileLoad(driveName, cwd, name, session) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted' };

  var fname = normName(name);
  if (!fname) return { success: false, error: 'invalid filename' };
  var canonical = resolveName(cwd, fname);

  var existing = drive.manifestMap.get(canonical);
  if (!existing) return { success: false, error: 'file not found' };

  if (isExpiredTimestamp(existing.timestamp)) {
    _expireEntry(resolved, canonical, existing);
    return { success: false, error: 'file not found' };
  }

  var content = _storageGet(drive.storage, canonical);
  if (content == null) return { success: false, error: 'file not found' };

  return { success: true, content: content };
}

function fileAppendJSON(driveName, cwd, name, element, session, owner) {
  var existing = fileLoad(driveName, cwd, name, session);
  var arr = [];
  if (existing.success) {
    try { arr = JSON.parse(existing.content); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
  }
  arr.push(element);
  return fileSave(driveName, cwd, name, JSON.stringify(arr), session, owner);
}

function fileDelete(driveName, cwd, name, session) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted' };
  if (drive.readOnly) return { success: false, error: 'drive is read-only: ' + resolved };

  var fname = normName(name);
  if (!fname) return { success: false, error: 'invalid filename' };
  var canonical = resolveName(cwd, fname);

  var existing = drive.manifestMap.get(canonical);
  if (!existing) return { success: false, error: 'file not found' };
  if (isWriteProtected(existing.name)) return { success: false, error: 'file is write-protected' };

  _storageDelete(drive.storage, canonical);
  drive.manifestMap.delete(canonical);

  if (canonical.charAt(0) !== '<') {
    drive.fileCount--;
    drive.totalSize -= existing.size;
  }

  _debounceSaveManifestToStorage(resolved);
  return { success: true, result: 'deleted' };
}

function fileRename(driveName, cwd, name, dest, session) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted' };
  if (drive.readOnly) return { success: false, error: 'drive is read-only: ' + resolved };

  var fname = normName(name);
  var dname = normName(dest);
  var srcCanonical  = resolveName(cwd, fname).replace(/\/+$/, '');
  var destCanonical = resolveName(cwd, dname).replace(/\/+$/, '');

  if (!srcCanonical || !destCanonical) return { success: false, error: 'invalid path' };
  var dv = validateName(baseName(destCanonical));
  if (!dv.ok) return { success: false, error: 'invalid destination: ' + dv.reason };

  // Check parent directory exists for destination if nested
  var destSlash = destCanonical.lastIndexOf('/');
  if (destSlash > 0) {
    var destParent = destCanonical.substring(0, destSlash);
    if (!drive.storage.has('<' + destParent + '>')) {
      return { success: false, error: 'parent directory not found' };
    }
  }

  // Case A: Directory rename
  var srcDirToken = '<' + srcCanonical + '>';
  if (drive.storage.has(srcDirToken)) {
    if (destCanonical === srcCanonical || destCanonical.indexOf(srcCanonical + '/') === 0) {
      return { success: false, error: 'cannot move a directory into itself' };
    }
    if (drive.storage.has('<' + destCanonical + '>') || drive.manifestMap.has(destCanonical)) {
      return { success: false, error: 'destination already exists' };
    }

    var prefix = srcCanonical + '/';
    var dirMoves = [{ oldKey: srcDirToken, newKey: '<' + destCanonical + '>' }];
    var fileMoves = [];

    drive.storage.forEach(function (val, k) {
      if (k.charAt(0) !== '<') return;
      var inner = k.substring(1, k.length - 1);
      if (inner.indexOf(prefix) === 0) {
        dirMoves.push({
          oldKey: k,
          newKey: '<' + destCanonical + inner.substring(srcCanonical.length) + '>'
        });
      }
    });

    drive.manifestMap.forEach(function (e) {
      if (!e || !e.name || e.name === MANIFEST_KEY || e.name.charAt(0) === '<') return;
      if (e.name.indexOf(prefix) === 0) {
        if (isWriteProtected(e.name)) throw new Error('file is write-protected: ' + e.name);
        fileMoves.push({
          entry: e,
          oldKey: e.name,
          newKey: destCanonical + e.name.substring(srcCanonical.length)
        });
      }
    });

    for (var i = 0; i < dirMoves.length; i++) {
      var dm = dirMoves[i];
      var dEntry = drive.manifestMap.get(dm.oldKey);
      _storageDelete(drive.storage, dm.oldKey);
      _storageSet(drive.storage, dm.newKey, '');
      drive.manifestMap.delete(dm.oldKey);
      drive.manifestMap.set(dm.newKey, {
        name: dm.newKey,
        size: 0,
        timestamp: dm.oldKey === srcDirToken ? timestamp() : (dEntry ? dEntry.timestamp : timestamp()),
        owner: (dEntry && dEntry.owner) || '',
        session: (dEntry && dEntry.session) || session || ''
      });
    }

    for (var j = 0; j < fileMoves.length; j++) {
      var fm = fileMoves[j];
      var content = _storageGet(drive.storage, fm.oldKey);
      _storageDelete(drive.storage, fm.oldKey);
      _storageSet(drive.storage, fm.newKey, content == null ? '' : content);
      drive.manifestMap.delete(fm.oldKey);
      drive.manifestMap.set(fm.newKey, Object.assign({}, fm.entry, { name: fm.newKey }));
    }

    var curCwd = getDriveCwd(resolved).replace(/^\/+|\/+$/g, '');
    if (curCwd === srcCanonical || curCwd.indexOf(prefix) === 0) {
      var updatedCwd = destCanonical + curCwd.substring(srcCanonical.length);
      setDriveCwd(resolved, '/' + updatedCwd + '/');
    }

    _debounceSaveManifestToStorage(resolved);
    return { success: true, result: 'renamed' };
  }

  // Case B: Single file rename
  var fv = validateName(baseName(fname));
  if (!fv.ok) return { success: false, error: fv.reason };

  var existing = drive.manifestMap.get(srcCanonical);
  var destExisting = drive.manifestMap.get(destCanonical) || drive.storage.has('<' + destCanonical + '>');

  if (!existing) return { success: false, error: 'file not found' };
  if (isWriteProtected(existing.name)) return { success: false, error: 'file is write-protected' };
  if (destExisting) return { success: false, error: 'destination already exists' };

  var content = _storageGet(drive.storage, srcCanonical);
  if (content == null) return { success: false, error: 'file not found' };

  _storageSet(drive.storage, destCanonical, content);
  _storageDelete(drive.storage, srcCanonical);

  drive.manifestMap.delete(srcCanonical);
  drive.manifestMap.set(destCanonical, {
    name:      destCanonical,
    size:      existing.size,
    timestamp: timestamp(),
    owner:     existing.owner || session,
    session:   existing.session || session
  });

  _debounceSaveManifestToStorage(resolved);
  return { success: true, result: 'renamed' };
}

function fileExists(driveName, cwd, name) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: true, exists: false };

  var fname = normName(name);
  if (!fname) return { success: true, exists: false };

  var canonical = resolveName(cwd, fname);
  var existing = drive.manifestMap.get(canonical);
  if (!existing) return { success: true, exists: false, path: canonical };

  if (isExpiredTimestamp(existing.timestamp)) {
    _expireEntry(resolved, canonical, existing);
    return { success: true, exists: false, path: canonical };
  }

  return { success: true, exists: true, path: canonical };
}

function fileSearch(driveName, pattern) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not found', results: [] };

  var results = [];
  var now = timestamp();
  var expired = [];

  drive.manifestMap.forEach(function (e) {
    if (e.name === MANIFEST_KEY || e.name.charAt(0) === '<') return;
    if (isExpiredTimestamp(e.timestamp, now)) {
      expired.push(e);
      return;
    }
    var base = baseName(e.name);
    if (matchPattern(base, pattern) || matchPattern(e.name, pattern)) {
      results.push({
        name: e.name,
        size: e.size,
        timestamp: e.timestamp
      });
    }
  });

  for (var i = 0; i < expired.length; i++) {
    _expireEntry(resolved, expired[i].name, expired[i]);
  }
  return { success: true, results: results };
}

function fileList(driveName, cwd, pattern, session) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted' };

  var dir = (cwd || '/').replace(/^\//, '').replace(/\/$/, '');
  var names = [];
  var now = timestamp();
  var expired = [];

  drive.manifestMap.forEach(function (e) {
    if (!e || !e.name) return;
    if (e.name === MANIFEST_KEY || e.name.charAt(0) === '<') return;
    var slash = e.name.lastIndexOf('/');
    var fileDir = slash >= 0 ? e.name.substring(0, slash) : '';
    if (fileDir !== dir) return;

    if (isExpiredTimestamp(e.timestamp, now)) {
      expired.push(e);
      return;
    }

    var nb = baseName(e.name);
    if (pattern && !matchPattern(nb, pattern)) return;
    names.push(nb);
  });

  for (var i = 0; i < expired.length; i++) {
    _expireEntry(resolved, expired[i].name, expired[i]);
  }

  return { success: true, listing: names.join(' ') };
}

// ── Directory Operations ──────────────────────────────────────────────────────

function dirExists(driveName, dirPath) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive || !dirPath) return false;
  var clean = String(dirPath).replace(/^\/+|\/+$/g, '');
  return drive.storage.has('<' + clean + '>');
}

function dirMake(driveName, cwd, name, session) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted' };
  if (drive.readOnly) return { success: false, error: 'drive is read-only: ' + resolved };

  var dirName = normName(name);
  if (!dirName) return { success: false, error: 'invalid directory name' };
  var fv = validateName(baseName(dirName));
  if (!fv.ok) return { success: false, error: fv.reason };

  var canonical = resolveName(cwd, dirName);
  canonical = String(canonical || '').replace(/\/+$/, '');
  var dirToken = '<' + canonical + '>';

  if (drive.storage.has(dirToken) || drive.manifestMap.has(canonical)) {
    return { success: false, error: 'directory already exists' };
  }

  var slashIdx = canonical.lastIndexOf('/');
  if (slashIdx > 0) {
    var parent = canonical.substring(0, slashIdx);
    var parentToken = '<' + parent + '>';
    if (!drive.storage.has(parentToken)) {
      return { success: false, error: 'parent directory not found' };
    }
  }

  var ts = timestamp();
  _storageSet(drive.storage, dirToken, '');

  var manifest = _readManifest(resolved);
  var newManifest = manifest.filter(function (e) { return e.name !== MANIFEST_KEY; });
  newManifest.push({ name: dirToken, size: 0, timestamp: ts, owner: '', session: session || '' });
  _saveManifest(resolved, newManifest);

  return { success: true, result: 'done' };
}

function dirChange(driveName, cwd, name, session) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted' };

  var dirName = normName(name);

  if (!dirName || dirName === '/') {
    return { success: true, cwd: '/', result: resolved + ':/' };
  }

  if (dirName === '..') {
    var parts = (cwd || '/').replace(/^\//, '').replace(/\/$/, '').split('/');
    parts.pop();
    var newCwd = '/' + parts.join('/');
    if (newCwd !== '/') newCwd += '/';
    return { success: true, cwd: newCwd, result: resolved + ':' + newCwd };
  }

  var canonical = resolveName(cwd, dirName);
  canonical = String(canonical || '').replace(/^\/+|\/+$/g, '');

  if (canonical === '') {
    return { success: true, cwd: '/', result: resolved + ':/' };
  }

  if (!drive.storage.has('<' + canonical + '>')) {
    return { success: false, error: 'directory not found' };
  }

  var newCwdPath = '/' + canonical + '/';
  return { success: true, cwd: newCwdPath, result: resolved + ':' + newCwdPath };
}

function dirRemove(driveName, cwd, name, session) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted' };
  if (drive.readOnly) return { success: false, error: 'drive is read-only: ' + resolved };

  var dirName = normName(name);
  if (!dirName) return { success: false, error: 'invalid directory name' };

  var canonical = resolveName(cwd, dirName);
  canonical = String(canonical || '').replace(/^\/+|\/+$/g, '');

  if (canonical === '') {
    return { success: false, error: 'cannot remove root directory' };
  }

  var dirToken = '<' + canonical + '>';
  if (!drive.storage.has(dirToken)) {
    return { success: false, error: 'directory not found' };
  }

  var prefix = canonical + '/';
  var notEmpty = false;
  drive.storage.forEach(function (val, k) {
    if (notEmpty) return;
    if (k === dirToken || k === MANIFEST_KEY) return;
    if (k.charAt(0) === '<') {
      var inner = k.substring(1, k.length - 1);
      if (inner.indexOf(prefix) === 0) notEmpty = true;
    } else {
      if (k.indexOf(prefix) === 0) notEmpty = true;
    }
  });
  if (notEmpty) return { success: false, error: 'directory not empty' };

  _storageDelete(drive.storage, dirToken);

  var manifest = _readManifest(resolved);
  var newManifest = manifest.filter(function (e) {
    return e.name !== MANIFEST_KEY && e.name !== dirToken;
  });
  _saveManifest(resolved, newManifest);

  return { success: true, result: 'done' };
}

function dirList(driveName, cwd, pattern, switches, session) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not mounted' };

  var showHidden = (switches || '').indexOf('a') >= 0;
  var dir = (cwd || '/').replace(/^\//, '').replace(/\/$/, '');
  var lines = [];
  var now = timestamp();
  var expired = [];

  lines.push('Directory of ' + resolved + ':' + (cwd || '/') + '\n\n');

  var dirPrefix = dir ? (dir + '/') : '';
  var storage = drive.storage;

  storage.forEach(function (val, k) {
    if (k.charAt(0) !== '<') return;
    var inner = k.substring(1, k.length - 1);
    if (inner.indexOf(dirPrefix) !== 0) return;
    var rel = inner.substring(dirPrefix.length);
    if (!rel || rel.indexOf('/') >= 0) return;
    if (!showHidden && isHidden(rel)) return;
    if (pattern && !matchPattern(rel, pattern)) return;
    lines.push('  <DIR>  ' + rel + '\n');
  });

  var entries = [];
  drive.manifestMap.forEach(function (e) {
    if (!e || !e.name) return;
    if (e.name === MANIFEST_KEY) {
      if (showHidden) entries.push(e);
      return;
    }
    if (e.name.charAt(0) === '<') return;
    if (isExpiredTimestamp(e.timestamp, now)) {
      expired.push(e);
      return;
    }
    if (!showHidden && isHidden(e.name)) return;
    var slash = e.name.lastIndexOf('/');
    var fileDir = slash >= 0 ? e.name.substring(0, slash) : '';
    if (fileDir === dir) entries.push(e);
  });

  for (var i = 0; i < expired.length; i++) {
    _expireEntry(resolved, expired[i].name, expired[i]);
  }

  for (var j = 0; j < entries.length; j++) {
    var e = entries[j];
    var nb = baseName(e.name);
    if (pattern && !matchPattern(nb, pattern)) continue;
    var ts = e.timestamp || '';
    var sz = String(e.size);
    lines.push('  ' + ts + '  ' + sz.padStart(8) + '  ' + e.name + '\n');
  }

  lines.push('\n' + entries.length + ' file(s)\n');
  return { success: true, listing: lines.join('') };
}

function getDirEntries(driveName, dirPath) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) throw new Error('drive not found: ' + driveName);

  if (dirPath) {
    if (drive.storage.has(dirPath) && !drive.storage.has('<' + dirPath + '>')) {
      throw new Error('not a directory: ' + dirPath);
    }
    if (!drive.storage.has('<' + dirPath + '>')) {
      throw new Error('directory not found: ' + dirPath);
    }
  }

  var now = timestamp();
  var expired = [];
  var subdirs = [];
  var files = [];
  var dirPrefix = dirPath ? (dirPath + '/') : '';

  drive.storage.forEach(function (val, k) {
    if (k.charAt(0) !== '<') return;
    var inner = k.substring(1, k.length - 1);
    if (inner.indexOf(dirPrefix) !== 0) return;
    var rel = inner.substring(dirPrefix.length);
    if (!rel || rel.indexOf('/') >= 0) return;
    subdirs.push(rel);
  });

  drive.manifestMap.forEach(function (e) {
    if (!e || !e.name || e.name === MANIFEST_KEY || e.name.charAt(0) === '<') return;
    var slash = e.name.lastIndexOf('/');
    var fileDir = slash >= 0 ? e.name.substring(0, slash) : '';
    if (fileDir !== dirPath) return;
    if (isExpiredTimestamp(e.timestamp, now)) {
      expired.push(e);
      return;
    }
    files.push(e);
  });

  for (var i = 0; i < expired.length; i++) {
    _expireEntry(resolved, expired[i].name, expired[i]);
  }

  subdirs.sort();
  files.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { subdirs: subdirs, files: files };
}

function copyPath(srcDriveName, srcPath, dstDriveName, dstPath, srcLabel, options) {
  options = options || {};
  var sResolved = resolveDriveName(srcDriveName);
  var dResolved = resolveDriveName(dstDriveName);
  var srcDrive = sResolved ? drives[sResolved] : null;
  var dstDrive = dResolved ? drives[dResolved] : null;
  if (!srcDrive) throw new Error('drive not found: ' + srcDriveName);
  if (!dstDrive) throw new Error('drive not found: ' + dstDriveName);
  if (dstDrive.readOnly) throw new Error('drive is read-only: ' + dResolved);
  if (!srcPath) throw new Error('invalid source path');

  sweepExpired(sResolved);
  sweepExpired(dResolved);

  var isDir = srcDrive.storage.has('<' + srcPath + '>');
  var srcEntry = isDir ? null : srcDrive.manifestMap.get(srcPath);
  if (!isDir && !srcEntry) throw new Error('file not found: ' + (srcLabel || srcPath));

  var to = dstPath;
  if (!to) {
    to = rawBaseName(srcPath);
  } else if (dstDrive.storage.has('<' + to + '>')) {
    to = to + '/' + rawBaseName(srcPath);
  } else if (dstDrive.manifestMap.has(to)) {
    throw new Error('destination already exists: ' + to);
  }

  var parentSlash = to.lastIndexOf('/');
  if (parentSlash > 0) {
    var parentDir = to.substring(0, parentSlash);
    if (!dstDrive.storage.has('<' + parentDir + '>')) {
      throw new Error('parent directory not found: ' + parentDir);
    }
  }

  if (!isDir) {
    if (sResolved === dResolved && to === srcPath) {
      throw new Error('cannot copy a file onto itself');
    }
    var loaded = fileLoad(sResolved, '/', srcPath, 'console');
    if (!loaded.success) throw new Error(loaded.error);
    var saved = fileSave(dResolved, '/', to, loaded.content, 'console', 'console');
    if (!saved.success) throw new Error(saved.error);
    return dResolved + ':/' + to;
  }

  if (sResolved === dResolved && (to === srcPath || to.indexOf(srcPath + '/') === 0)) {
    throw new Error('cannot copy a directory into itself');
  }

  var prefix = srcPath + '/';
  var copyDirs = [srcPath];
  var copyFiles = [];

  srcDrive.storage.forEach(function (val, k) {
    if (k.charAt(0) !== '<') return;
    var inner = k.substring(1, k.length - 1);
    if (inner.indexOf(prefix) === 0) copyDirs.push(inner);
  });

  srcDrive.manifestMap.forEach(function (e) {
    if (!e || !e.name || e.name === MANIFEST_KEY || e.name.charAt(0) === '<') return;
    if (e.name.indexOf(prefix) === 0) copyFiles.push(e);
  });

  copyDirs.sort(function (a, b) {
    var da = a.split('/').length, db = b.split('/').length;
    return da !== db ? da - db : (a < b ? -1 : 1);
  });

  for (var di = 0; di < copyDirs.length; di++) {
    var targetDir = to + copyDirs[di].substring(srcPath.length);
    if (dstDrive.storage.has('<' + targetDir + '>') || dstDrive.manifestMap.has(targetDir)) {
      throw new Error('destination already exists: ' + targetDir);
    }
  }
  for (var fi = 0; fi < copyFiles.length; fi++) {
    var targetFile = to + copyFiles[fi].name.substring(srcPath.length);
    if (dstDrive.manifestMap.has(targetFile) || dstDrive.storage.has('<' + targetFile + '>')) {
      throw new Error('destination already exists: ' + targetFile);
    }
  }

  for (var dj = 0; dj < copyDirs.length; dj++) {
    var mk = dirMake(dResolved, '/', to + copyDirs[dj].substring(srcPath.length), 'console');
    if (!mk.success) throw new Error(mk.error);
  }
  for (var fj = 0; fj < copyFiles.length; fj++) {
    var srcF = copyFiles[fj];
    var fLoad = fileLoad(sResolved, '/', srcF.name, 'console');
    if (!fLoad.success) throw new Error(fLoad.error);
    var destName = to + srcF.name.substring(srcPath.length);
    var fSave = fileSave(dResolved, '/', destName, fLoad.content, 'console', 'console');
    if (!fSave.success) throw new Error(fSave.error);
  }

  return dResolved + ':/' + to;
}

// ── JSON Archive Export / Import ──────────────────────────────────────────────

function exportDrive(driveName, outputFile) {
  var resolved = resolveDriveName(driveName);
  var drive = resolved ? drives[resolved] : null;
  if (!drive) return { success: false, error: 'drive not found' };

  var entries = [];
  drive.manifestMap.forEach(function (e, key) {
    if (key === MANIFEST_KEY) return;

    var isDir = key.charAt(0) === '<';
    var pathName = isDir ? key.substring(1, key.length - 1) : key;
    var content = isDir ? '' : (_storageGet(drive.storage, key) || '');

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

  var archive = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    drive: resolved,
    created: new Date().toISOString(),
    entries: entries
  };

  var json = JSON.stringify(archive, null, 2);

  if (outputFile) {
    try {
      var outPath = path.resolve(process.cwd(), outputFile);
      fs.writeFileSync(outPath, json, 'utf8');
      return { success: true, result: 'Exported ' + resolved + ':/ to ' + outputFile };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: true, json: json };
}

function importDriveData(driveName, rawText, session, options) {
  options = options || {};
  var replace = options.mode !== 'merge';

  var archive;
  try {
    archive = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
  } catch (err) {
    return { success: false, error: 'Invalid JSON format' };
  }

  if (!archive || typeof archive !== 'object') {
    return { success: false, error: 'Invalid archive' };
  }
  if (archive.format && archive.format !== ARCHIVE_FORMAT) {
    return { success: false, error: 'Unsupported archive format: ' + archive.format };
  }

  var rawEntries = null;
  if (Array.isArray(archive.entries)) {
    rawEntries = archive.entries;
  } else if (archive.files && typeof archive.files === 'object') {
    rawEntries = Object.keys(archive.files).map(function (name) {
      return { name: name, type: 'file', content: archive.files[name] };
    });
  } else {
    return { success: false, error: 'Invalid archive: entries or files required' };
  }

  var resolved = resolveDriveName(driveName) || driveName;
  if (!drives[resolved]) {
    var cr = driveCreate(resolved, session || 'console');
    if (!cr.success) return { success: false, error: 'Failed to create drive: ' + cr.error };
  }

  var drive = drives[resolved];
  if (drive.readOnly) {
    return { success: false, error: 'drive is read-only: ' + resolved };
  }

  var dirSeen = Object.create(null);
  var dirs = [];
  var files = [];

  for (var i = 0; i < rawEntries.length; i++) {
    var e = rawEntries[i];
    var rawName = String(e.name == null ? '' : e.name).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); //'
    if (!rawName) continue;
    var isDir = e.type === 'directory' || rawName.charAt(0) === '<';
    var cleanName = rawName.replace(/^<|>$/g, '');
    if (!cleanName) continue;

    var parts = cleanName.split('/');
    var limit = isDir ? parts.length : parts.length - 1;
    var cur = '';
    for (var p = 0; p < limit; p++) {
      cur = cur ? (cur + '/' + parts[p]) : parts[p];
      if (!dirSeen[cur]) {
        dirSeen[cur] = true;
        dirs.push(cur);
      }
    }

    if (!isDir) {
      files.push({
        name: cleanName,
        content: e.content == null ? '' : String(e.content),
        timestamp: e.timestamp || timestamp(),
        owner: e.owner || session || 'console',
        session: e.session || session || 'console'
      });
    }
  }

  dirs.sort(function (a, b) {
    var da = a.split('/').length, db = b.split('/').length;
    return da !== db ? da - db : (a < b ? -1 : 1);
  });

  if (replace) {
    drive.storage.clear();
    drive.manifestMap.clear();
    drive.fileCount = 0;
    drive.totalSize = 0;
    _saveManifest(resolved, []);
  }

  var importedCount = 0;
  var errors = 0;

  for (var di = 0; di < dirs.length; di++) {
    var dRes = dirMake(resolved, '/', dirs[di], session || 'console');
    if (!dRes.success && dRes.error !== 'directory already exists') {
      console.warn('  Import warning for <' + dirs[di] + '>: ' + dRes.error);
      errors++;
    } else {
      importedCount++;
    }
  }

  for (var fi = 0; fi < files.length; fi++) {
    var f = files[fi];
    var res = fileSave(resolved, '/', f.name, f.content, f.session, f.owner, f.timestamp);
    if (!res.success) {
      console.warn('  Import warning for ' + f.name + ': ' + res.error);
      errors++;
    } else {
      importedCount++;
    }
  }

  if (replace) {
    var curCwd = getDriveCwd(resolved).replace(/^\/+|\/+$/g, '');
    if (curCwd && !drive.storage.has('<' + curCwd + '>')) {
      setDriveCwd(resolved, '/');
    }
  }

  return {
    success: true,
    result: 'Imported ' + importedCount + ' items into ' + resolved +
      ' (' + (replace ? 'replace' : 'merge') + (errors ? ', ' + errors + ' skipped' : '') + ')'
  };
}

function importDrive(driveName, inputFileOrText, session, options) {
  var raw = String(inputFileOrText == null ? '' : inputFileOrText).trim();
  if (raw.charAt(0) !== '{') {
    try {
      raw = fs.readFileSync(path.resolve(process.cwd(), inputFileOrText), 'utf8');
    } catch (err) {
      return { success: false, error: 'Cannot read file: ' + err.message };
    }
  }
  return importDriveData(driveName, raw, session, options);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  MANIFEST_KEY: MANIFEST_KEY,
  ARCHIVE_FORMAT: ARCHIVE_FORMAT,
  ARCHIVE_VERSION: ARCHIVE_VERSION,
  MAX_NAME_BYTES: MAX_NAME_BYTES,
  MAX_TOTAL_DRIVE_SIZE: MAX_TOTAL_DRIVE_SIZE,
  DEFAULT_QUOTA: DEFAULT_QUOTA,
  MIN_QUOTA: MIN_QUOTA,
  MAX_QUOTA: MAX_QUOTA,
  MAX_FILE_BYTES: MAX_FILE_BYTES,
  MAX_DRIVE_FILES: MAX_DRIVE_FILES,
  VALID_NAME_RE: VALID_NAME_RE,

  injectBigBang: injectBigBang,

  drives: drives,
  resolveDriveName: resolveDriveName,
  getDrive: getDrive,
  listDrives: listDrives,
  getDriveCwd: getDriveCwd,
  setDriveCwd: setDriveCwd,
  setDrive: setDrive,
  pwd: pwd,
  sourceName: sourceName,

  mount: mount,
  umount: umount,
  mounts: mounts,
  formatDrive: formatDrive,

  timestamp: timestamp,
  futureTimestamp: futureTimestamp,
  utf8len: utf8len,
  formatBytes: formatBytes,
  formatSize: formatSize,
  parseSize: parseSize,
  normName: normName,
  rawBaseName: rawBaseName,
  baseName: baseName,
  validateName: validateName,
  isWriteProtected: isWriteProtected,
  isHidden: isHidden,
  resolveName: resolveName,
  normalizePath: normalizePath,
  extractWildcard: extractWildcard,
  matchPattern: matchPattern,
  isExpiredTimestamp: isExpiredTimestamp,
  sweepExpired: sweepExpired,

  calculateDriveStats: calculateDriveStats,
  getDriveDebugInfo: getDriveDebugInfo,
  findEntry: findEntry,

  driveCreate: driveCreate,
  driveMount: driveMount,
  driveDelete: driveDelete,

  fileSave: fileSave,
  fileLoad: fileLoad,
  fileAppendJSON: fileAppendJSON,
  fileDelete: fileDelete,
  fileRename: fileRename,
  fileExists: fileExists,
  fileSearch: fileSearch,
  fileList: fileList,

  dirExists: dirExists,
  dirMake: dirMake,
  dirChange: dirChange,
  dirRemove: dirRemove,
  dirList: dirList,
  getDirEntries: getDirEntries,
  copyPath: copyPath,

  exportDrive: exportDrive,
  importDrive: importDrive,
  importDriveData: importDriveData
};
