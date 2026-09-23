/*
 * Cylon DOS - IndexedDB filesystem backend
 *
 * This is the storage layer for the modern (2029) Qandy Pocket Computer.
 * It intentionally does not use qandy-dos.js or localStorage.
 *
 * Public API:
 *   CylonDOS.open()
 *   CylonDOS.createDrive(name)
 *   CylonDOS.mount(name)
 *   CylonDOS.save(path, content, metadata)
 *   CylonDOS.load(path)
 *   CylonDOS.delete(path)
 *   CylonDOS.rename(path, destination)
 *   CylonDOS.exists(path)
 *   CylonDOS.mkdir(path)
 *   CylonDOS.chdir(path)
 *   CylonDOS.rmdir(path)
 *   CylonDOS.list(path)
 *   CylonDOS.dir(path)
 *   CylonDOS.exportDrive()
 *   CylonDOS.importDrive(archive, options)
 *
 * The archive format is deliberately compatible with the qandyland storage
 * model: canonical paths have no leading slash, directories are represented
 * as entries, and _dir.sys! is generated from entry metadata.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'CylonDOS';
  var DB_VERSION = 1;
  var DRIVE_STORE = 'drives';
  var ENTRY_STORE = 'entries';
  var MANIFEST_KEY = '_dir.sys!';
  var ARCHIVE_FORMAT = 'qandy-ramdrive';
  var ARCHIVE_VERSION = 2;
  var MAX_NAME_BYTES = 255;
  var MAX_FILE_BYTES = 64 * 1024;
  var MAX_DRIVE_BYTES = 10 * 1024 * 1024;
  var MAX_DRIVE_ENTRIES = 20000;
  var NAME_RE = /^(?!\.)(?!.*[\\/])[A-Za-z0-9 \-_.()+=!]+$/;
  var dbPromise = null;
  var mountedDrive = null;
  var cwd = '';

  function fail(message) { throw new Error(message); }

  function utf8Length(value) {
    value = String(value == null ? '' : value);
    if (global.TextEncoder) return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function timestamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function normalizePath(path, base) {
    path = String(path == null ? '' : path).trim().replace(/\\/g, '/');
    base = String(base == null ? cwd : base).replace(/^\/+|\/+$/g, '');
    var parts = (path.charAt(0) === '/' ? path : (base ? base + '/' : '') + path)
      .split('/');
    var result = [];
    parts.forEach(function (part) {
      if (!part || part === '.') return;
      if (part === '..') { if (result.length) result.pop(); return; }
      result.push(part);
    });
    return result.join('/');
  }

  function parentPath(path) {
    var slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.substring(0, slash);
  }

  function baseName(path) {
    var slash = path.lastIndexOf('/');
    return slash < 0 ? path : path.substring(slash + 1);
  }

  function validatePath(path, allowRoot) {
    path = normalizePath(path);
    if (!path) {
      if (allowRoot) return path;
      fail('invalid path');
    }
    path.split('/').forEach(function (part) {
      if (!part || !NAME_RE.test(part) || utf8Length(part) > MAX_NAME_BYTES) {
        fail('invalid path component: ' + part);
      }
    });
    return path;
  }

  function request(requestObject) {
    return new Promise(function (resolve, reject) {
      requestObject.onsuccess = function () { resolve(requestObject.result); };
      requestObject.onerror = function () { reject(requestObject.error || new Error('IndexedDB request failed')); };
    });
  }

  function transactionComplete(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
    });
  }

  function open() {
    if (dbPromise) return dbPromise;
    if (!global.indexedDB) return Promise.reject(new Error('IndexedDB is not available'));
    dbPromise = new Promise(function (resolve, reject) {
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        var drives = db.objectStoreNames.contains(DRIVE_STORE)
          ? req.transaction.objectStore(DRIVE_STORE)
          : db.createObjectStore(DRIVE_STORE, { keyPath: 'name' });
        if (!db.objectStoreNames.contains(ENTRY_STORE)) {
          var entries = db.createObjectStore(ENTRY_STORE, { keyPath: ['drive', 'path'] });
          entries.createIndex('drive', 'drive', { unique: false });
          entries.createIndex('driveType', ['drive', 'type'], { unique: false });
        }
        // Keep this reference so older browsers do not optimize away the upgrade.
        void drives;
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbPromise = null; reject(req.error); };
      req.onblocked = function () { reject(new Error('CylonDOS database upgrade is blocked')); };
    });
    return dbPromise;
  }

  async function getDrive(name) {
    var db = await open();
    var tx = db.transaction(DRIVE_STORE, 'readonly');
    return request(tx.objectStore(DRIVE_STORE).get(name));
  }

  async function ensureDrive(name) {
    name = String(name || '').trim();
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) fail('invalid drive name');
    var existing = await getDrive(name);
    if (existing) return existing;
    var drive = { name: name, created: new Date().toISOString(), version: 1 };
    var db = await open();
    var tx = db.transaction(DRIVE_STORE, 'readwrite');
    tx.objectStore(DRIVE_STORE).add(drive);
    await transactionComplete(tx);
    return drive;
  }

  async function mounted() {
    if (!mountedDrive) fail('no drive mounted');
    var drive = await getDrive(mountedDrive);
    if (!drive) fail('drive not found: ' + mountedDrive);
    return drive;
  }

  async function getEntry(drive, path) {
    var db = await open();
    var tx = db.transaction(ENTRY_STORE, 'readonly');
    return request(tx.objectStore(ENTRY_STORE).get([drive, path]));
  }

  async function allEntries(drive) {
    var db = await open();
    var tx = db.transaction(ENTRY_STORE, 'readonly');
    return request(tx.objectStore(ENTRY_STORE).index('drive').getAll(drive));
  }

  function manifestText(entries) {
    var lines = entries.filter(function (e) { return e.path !== MANIFEST_KEY; }).map(function (e) {
      return (e.type === 'directory' ? '<' + e.path + '>' : e.path) + '|' +
        e.size + '|' + e.timestamp + '|' + (e.owner || '') + '|' + (e.session || '');
    });
    var body = lines.length ? lines.join('\n') + '\n' : '';
    var self = MANIFEST_KEY + '|0|' + timestamp();
    var full = body + self;
    self = MANIFEST_KEY + '|' + utf8Length(full) + '|' + timestamp();
    return body + self;
  }

  function entryPath(entry) {
    return entry.type === 'directory' ? '<' + entry.path + '>' : entry.path;
  }

  async function save(path, content, metadata) {
    var drive = await mounted();
    path = validatePath(path, false);
    var value = String(content == null ? '' : content);
    if (utf8Length(value) > MAX_FILE_BYTES) fail('file too large');
    var old = await getEntry(drive.name, path);
    if (old && old.readOnly) fail('file is write-protected');
    var entries = await allEntries(drive.name);
    if (!old && entries.length >= MAX_DRIVE_ENTRIES) fail('drive is full');
    var total = entries.reduce(function (n, e) { return n + (e.type === 'file' ? e.size : 0); }, 0);
    if (total - (old && old.size || 0) + utf8Length(value) > MAX_DRIVE_BYTES) fail('drive storage limit exceeded');
    var entry = {
      drive: drive.name, path: path, type: 'file', content: value,
      size: utf8Length(value), timestamp: timestamp(),
      owner: metadata && metadata.owner || '', session: metadata && metadata.session || '',
      readOnly: !!(metadata && metadata.readOnly)
    };
    var db = await open();
    var tx = db.transaction(ENTRY_STORE, 'readwrite');
    tx.objectStore(ENTRY_STORE).put(entry);
    await transactionComplete(tx);
    return true;
  }

  async function load(path) {
    var drive = await mounted();
    path = validatePath(path, false);
    var entry = await getEntry(drive.name, path);
    return entry && entry.type === 'file' ? entry.content : null;
  }

  async function remove(path) {
    var drive = await mounted();
    path = validatePath(path, false);
    var entry = await getEntry(drive.name, path);
    if (!entry) fail('file not found');
    if (entry.readOnly) fail('file is write-protected');
    var db = await open();
    var tx = db.transaction(ENTRY_STORE, 'readwrite');
    tx.objectStore(ENTRY_STORE).delete([drive.name, path]);
    await transactionComplete(tx);
    return true;
  }

  async function rename(source, destination) {
    var drive = await mounted();
    source = validatePath(source, false); destination = validatePath(destination, false);
    var old = await getEntry(drive.name, source);
    if (!old) fail('file not found');
    if (old.readOnly) fail('file is write-protected');
    if (await getEntry(drive.name, destination)) fail('destination already exists');
    var copy = Object.assign({}, old, { path: destination, timestamp: timestamp() });
    var db = await open();
    var tx = db.transaction(ENTRY_STORE, 'readwrite');
    tx.objectStore(ENTRY_STORE).put(copy);
    tx.objectStore(ENTRY_STORE).delete([drive.name, source]);
    await transactionComplete(tx);
    return true;
  }

  async function exists(path) {
    var drive = await mounted();
    path = validatePath(path, true);
    if (!path) return true;
    return !!(await getEntry(drive.name, path));
  }

  async function mkdir(path) {
    var drive = await mounted();
    path = validatePath(path, false);
    if (await getEntry(drive.name, path)) fail('path already exists');
    var parent = parentPath(path);
    if (parent && !(await getEntry(drive.name, parent))) fail('parent directory not found');
    var db = await open();
    var tx = db.transaction(ENTRY_STORE, 'readwrite');
    tx.objectStore(ENTRY_STORE).put({ drive: drive.name, path: path, type: 'directory', size: 0, timestamp: timestamp(), owner: '', session: '' });
    await transactionComplete(tx);
    return true;
  }

  async function chdir(path) {
    var drive = await mounted();
    var target = normalizePath(path || '');
    if (target && !(await getEntry(drive.name, target))) fail('directory not found');
    cwd = target;
    return cwd ? '/' + cwd + '/' : '/';
  }

  async function rmdir(path) {
    var drive = await mounted();
    path = validatePath(path, false);
    var entries = await allEntries(drive.name);
    if (!entries.some(function (e) { return e.path === path && e.type === 'directory'; })) fail('directory not found');
    if (entries.some(function (e) { return e.path !== path && e.path.indexOf(path + '/') === 0; })) fail('directory not empty');
    var db = await open();
    var tx = db.transaction(ENTRY_STORE, 'readwrite');
    tx.objectStore(ENTRY_STORE).delete([drive.name, path]);
    await transactionComplete(tx);
    if (cwd === path || cwd.indexOf(path + '/') === 0) cwd = '';
    return true;
  }

  async function list(path) {
    var drive = await mounted();
    var dir = normalizePath(typeof path === 'undefined' ? '' : path);
    var entries = await allEntries(drive.name);
    var names = entries.filter(function (e) {
      return parentPath(e.path) === dir && e.path !== MANIFEST_KEY && !baseName(e.path).startsWith('_');
    }).map(function (e) { return e.type === 'directory' ? baseName(e.path) + '/' : baseName(e.path); });
    return names.sort().join('\n');
  }

  async function dir(path) {
    var drive = await mounted();
    var dirPath = normalizePath(typeof path === 'undefined' ? '' : path);
    var entries = await allEntries(drive.name);
    return entries.filter(function (e) { return parentPath(e.path) === dirPath; }).map(function (e) {
      return { name: entryPath(e), type: e.type, size: e.size, timestamp: e.timestamp, owner: e.owner, session: e.session };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  async function exportDrive() {
    var drive = await mounted();
    var entries = await allEntries(drive.name);
    return JSON.stringify({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, drive: drive.name, created: new Date().toISOString(), entries: entries.map(function (e) {
      return { name: e.path, type: e.type, content: e.type === 'file' ? e.content : undefined, size: e.size, timestamp: e.timestamp, owner: e.owner, session: e.session, readOnly: !!e.readOnly };
    }) });
  }

  function decodeArchive(input) {
    var archive = typeof input === 'string' ? JSON.parse(input) : input;
    if (!archive || typeof archive !== 'object') fail('invalid archive');
    if (Array.isArray(archive.entries)) return archive.entries;
    if (archive.files && typeof archive.files === 'object') return Object.keys(archive.files).map(function (name) { return { name: name, type: 'file', content: archive.files[name] }; });
    fail('invalid archive: entries or files required');
  }

  async function importDrive(input, options) {
    var drive = await mounted();
    var incoming = decodeArchive(input);
    var replacement = !(options && options.mode === 'merge');
    var parsed = [];
    incoming.forEach(function (raw) {
      var name = String(raw.name == null ? '' : raw.name).replace(/^<|>$/g, '');
      var type = raw.type === 'directory' || (String(raw.name).charAt(0) === '<') ? 'directory' : 'file';
      name = validatePath(name, false);
      if (type === 'file') {
        var content = String(raw.content == null ? '' : raw.content);
        if (utf8Length(content) > MAX_FILE_BYTES) fail('import contains an oversized file: ' + name);
        parsed.push({ drive: drive.name, path: name, type: type, content: content, size: utf8Length(content), timestamp: raw.timestamp || timestamp(), owner: raw.owner || '', session: raw.session || '', readOnly: !!raw.readOnly });
      } else {
        parsed.push({ drive: drive.name, path: name, type: type, content: '', size: 0, timestamp: raw.timestamp || timestamp(), owner: raw.owner || '', session: raw.session || '' });
      }
    });
    var existing = replacement ? [] : await allEntries(drive.name);
    var map = Object.create(null);
    existing.concat(parsed).forEach(function (e) { map[e.path] = e; });
    var finalEntries = Object.keys(map).map(function (key) { return map[key]; });
    if (finalEntries.length > MAX_DRIVE_ENTRIES) fail('import contains too many entries');
    var total = finalEntries.reduce(function (n, e) { return n + (e.type === 'file' ? e.size : 0); }, 0);
    if (total > MAX_DRIVE_BYTES) fail('import exceeds drive storage limit');
    var db = await open();
    var tx = db.transaction(ENTRY_STORE, 'readwrite');
    var store = tx.objectStore(ENTRY_STORE);
    if (replacement) existing.forEach(function (e) { store.delete([drive.name, e.path]); });
    finalEntries.forEach(function (e) { store.put(e); });
    await transactionComplete(tx);
    return true;
  }

  async function createDrive(name) {
    return (await ensureDrive(name)).name;
  }

  async function mount(name) {
    var drive = await ensureDrive(name);
    mountedDrive = drive.name;
    cwd = '';
    return mountedDrive;
  }

  global.CylonDOS = {
    open: open,
    createDrive: createDrive,
    mount: mount,
    save: save,
    load: load,
    delete: remove,
    rename: rename,
    exists: exists,
    mkdir: mkdir,
    chdir: chdir,
    rmdir: rmdir,
    list: list,
    dir: dir,
    exportDrive: exportDrive,
    importDrive: importDrive,
    get mountedDrive() { return mountedDrive; },
    get cwd() { return cwd ? '/' + cwd + '/' : '/'; },
    constants: { MANIFEST_KEY: MANIFEST_KEY, ARCHIVE_FORMAT: ARCHIVE_FORMAT, ARCHIVE_VERSION: ARCHIVE_VERSION }
  };

  // Initialize the database without creating a drive or mounting anything.
  global.CylonDOS.ready = open;
})(typeof window !== 'undefined' ? window : globalThis);
