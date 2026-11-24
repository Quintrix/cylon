'use strict';

//
// ──── Qandyland Server Console (CLI) ─────────────────────────────────────────
//
// Translates terminal commands into calls to qandyland-dos.js using the same
// command grammar, mount table, flags, and output formatting as cylon-command.js.
//

var fs       = require('fs');
var path     = require('path');
var readline = require('readline');

var TYPE_MAX_BYTES = 65536; // 64 KB display limit
var DRIVE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}:$/;
var REF_RE         = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,63}):([\s\S]*)$/;

var FLAG_ALIASES = {
  r: 'readOnly', ro: 'readOnly', readonly: 'readOnly',
  s: 'size', size: 'size',
  y: 'yes', yes: 'yes', f: 'yes', force: 'yes',
  l: 'list', k: 'keep', keep: 'keep',
  m: 'merge', merge: 'merge'
};
var VALUE_FLAGS = { size: true };

// ── Secure terminal output sanitization ───────────────────────────────────────

function sanitizeForTerminal(content) {
  var s = (content == null) ? '' : String(content);

  s = s.replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '');
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  s = s.replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '');
  s = s.replace(/\x1b[()][A-Za-z0-9]/g, '');
  s = s.replace(/\x1b./g, '');

  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');

  return s;
}

// ── Parsing & formatting helpers (mirrors cylon-command.js) ───────────────────

function parseArgs(line) {
  var tokens = [];
  var match;
  var re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  line = String(line || '');
  while ((match = re.exec(line)) !== null) {
    tokens.push(
      match[1] !== undefined ? match[1].replace(/\\([\\"'])/g, '$1') :
      match[2] !== undefined ? match[2].replace(/\\(['"])/g, '$1') : match[3]
    );
  }
  return tokens;
}

function splitFlags(args) {
  var flags = {};
  var rest = [];
  for (var i = 0; i < args.length; i++) {
    var t = args[i];
    var m = /^--?([A-Za-z]+)$/.exec(t);
    var key = m && FLAG_ALIASES[m[1].toLowerCase()];
    if (!key) { rest.push(t); continue; }
    if (VALUE_FLAGS[key]) {
      if (i + 1 >= args.length) throw new Error('option ' + t + ' needs a value');
      flags[key] = args[++i];
    } else {
      flags[key] = true;
    }
  }
  return { flags: flags, rest: rest };
}

function pad(value, width) {
  value = String(value);
  while (value.length < width) value += ' ';
  return value;
}

function table(rows) {
  var widths = [];
  rows.forEach(function (row) {
    row.forEach(function (cell, i) { widths[i] = Math.max(widths[i] || 0, String(cell).length); });
  });
  return rows.map(function (row) {
    return row.map(function (cell, i) {
      return i === row.length - 1 ? String(cell) : pad(cell, widths[i] + 2);
    }).join('');
  }).join('\n');
}

function usage(text) {
  return 'Usage: ' + text;
}

function _formatTimestampHuman(ts) {
  if (ts && ts.charAt(0) === 'X') ts = ts.substring(1);
  if (!ts || ts.length < 14) return (ts || '(unknown)');
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
  var mo = parseInt(ts.slice(4, 6), 10) - 1;
  var dy = parseInt(ts.slice(6, 8), 10);
  var yr = ts.slice(0, 4);
  var hr = parseInt(ts.slice(8, 10), 10);
  var mn = parseInt(ts.slice(10, 12), 10);
  var sc = parseInt(ts.slice(12, 14), 10);
  if (mo < 0 || mo > 11 || isNaN(dy) || isNaN(hr) || isNaN(mn) || isNaN(sc)) return ts;
  var ampm = hr >= 12 ? 'PM' : 'AM';
  var hr12 = hr % 12 || 12;
  return (MONTHS[mo] || '?') + ' ' + dy + ', ' + yr + ' at ' +
         hr12 + ':' + String(mn).padStart(2, '0') + ':' + String(sc).padStart(2, '0') + ' ' + ampm;
}

// ── Help Text (mirrors cylon-command.js) ──────────────────────────────────────

var HELP_MAIN = [
  'Qandy / Cylon DOS commands:\n',
  'Drives & Mounts',
  '  mount                          Show mounted drives (type "help mount" for details)',
  '  umount <name>                  Unmount a drive (also: unmount, eject)',
  '  <name>:                        Switch the current drive (e.g. cylon-capflag:)',
  '  pwd                            Show the current drive and directory',
  '  format <drive> [-y]            Erase a mounted drive and start clean\n',
  'Files (paths may start with a drive, e.g. cylon-capflag:/w/Aa)',
  '  dir [path|pattern]             Detailed directory listing (e.g. dir *.txt)',
  '  ls [path|pattern]              List names in a directory',
  '  cd [path]                      Change directory (cd drive:/ also switches drive)',
  '  mkdir <path>                   Create a directory',
  '  rmdir <path>                   Remove an empty directory',
  '  save <file> <text>             Save text to a file',
  '  load <file>                    Display contents of a file',
  '  type <file>                    Dump raw text of a file to terminal',
  '  copy <src> <dest> [-k]         Copy a file or directory (across drives too)',
  '  rename <old> <new>             Rename or move a file or directory within a drive',
  '  delete <file|pattern> [-y]     Delete a file or files',
  '  exists <path>                  Test whether a path exists',
  '  alpha [path]                   List variables and their contents',
  '  echo [text]                    Print text to the console',
  '  cls                            Clear the terminal screen',
  '  help [command]                 Show help (e.g. "help mount" or "help krystals")\n',
  'Sysop & Server Admin',
  '  export [drive] [file.json]     Save a RAM drive snapshot as a .json file',
  '  import <file> [type] [drive]   Import JSON snapshot into RAM/ROM (-m to merge)',
  '  exam <file>                    Examine file metadata in detail',
  '  search <pattern>               Search across the current drive',
  '  serverstorage [drive]          Inspect raw drive storage & manifest',
  '  devteam [user|-user]           Manage DevTeam list in /a/playerDevTeam',
  '  upstash [cmd]                  Manage Upstash player files (type "help upstash")',
  '  krystals [list]                List WebSocket krystal frequencies on server',
  '  players                        List active connected player sessions',
  '  exit                           Shutdown the server (also: shutdown, quit)\n'
].join('\n');

var HELP_MOUNT = [
  'Mount Command Help:\n',
  '  mount                               Show the mount table',
  '  mount <file> <where> [name] [-r]    Mount a drive. <where> says what kind:',
  '                                        ram  RAM drive loaded from <file|url>  (-s <size>)',
  '                                        rom  read-only image from <file|url>',
  '  mount ram: [name]                   Blank RAM drive (default name: "ram")\n',
  '  The drive is named after <file> (without .gfx/.json) unless you give a [name].',
  '  Examples:',
  '    mount cylon-capflag.gfx ram',
  '    mount cylon-capflag.gfx ram capflag2',
  '    mount capflag.json ram',
  '    mount https://example.com/live.json rom live\n'
].join('\n');

var HELP_KRYSTALS = [
  'Krystals Server Help:\n',
  '  krystals                       List all WebSocket krystal frequencies on server',
  '  krystals list                  List public WebSocket krystal frequencies\n'
].join('\n');

var HELP_UPSTASH = [
  'Upstash Player Server Help (requires CWD on a .gfx drive):\n',
  '  upstash                        List all player files',
  '  upstash list [pattern]         List player files (e.g. upstash list j*)',
  '  upstash view <player>          View a player file',
  '  upstash ban <player> [dur]     Ban player (e.g. 30m, 12h, 7d, 0=unban, omit=perm)',
  '  upstash mute <player> [dur]    Mute player (e.g. 10m, 2h, 0=unmute, omit=perm)',
  '  upstash del <player> -y        Delete a player file from Upstash\n'
].join('\n');

// ── Command Executor ──────────────────────────────────────────────────────────

function createExecutor(opts) {
  opts = opts || {};
  var dos        = opts.dos;
  var krystals   = opts.krystals || null;
  var getPlayers = opts.getPlayers || null;
  var shutdown   = opts.shutdown || function () { process.exit(0); };
  var upstash = opts.upstash || null;

  if (!dos) throw new Error('qandyland-command: dos dependency is required');

  function resolveRef(input, fallbackDrive) {
    input = String(input == null ? '' : input).trim();
    var match = REF_RE.exec(input);
    var driveName, rest = input;
    if (match) {
      driveName = dos.resolveDriveName(match[1]);
      if (!driveName) throw new Error('drive not mounted: ' + match[1]);
      rest = match[2];
    } else {
      var curPwd = dos.pwd();
      if (fallbackDrive) {
        driveName = dos.resolveDriveName(fallbackDrive);
      } else if (curPwd !== '(no drive)') {
        driveName = curPwd.substring(0, curPwd.indexOf(':'));
      }
      if (!driveName || !dos.getDrive(driveName)) {
        throw new Error('no drive mounted');
      }
    }
    var cwdNorm = dos.getDriveCwd(driveName).replace(/^\/+|\/+$/g, '');
    return {
      driveName: driveName,
      drive: dos.getDrive(driveName),
      path: dos.normalizePath(rest, cwdNorm),
      qualified: !!match
    };
  }

  function formatMountTable() {
    var rows = dos.mounts();
    if (!rows.length) return '(nothing mounted)';
    var out = [['', 'Drive', 'Type', 'Source', 'Mode', 'Used', 'Size']];
    rows.forEach(function (r) {
      out.push([
        r.current ? '*' : '',
        r.name,
        r.type,
        r.source,
        r.readOnly ? 'ro' : 'rw',
        dos.formatSize(r.used),
        r.quota ? dos.formatSize(r.quota) : '-'
      ]);
    });
    return table(out) + '\n(* = current drive)';
  }

  return async function execute(line) {
    line = String(line || '').trim();
    if (!line) return { handled: true, ok: true, output: '' };

    var tokens = parseArgs(line);
    var rawCmd = tokens.shift() || '';
    var cmd = rawCmd.toLowerCase();

    try {
      // Bare "<drive>:" switches current drive (matches cylon-command.js)
      if (DRIVE_TOKEN_RE.test(rawCmd) && tokens.length === 0) {
        dos.setDrive(rawCmd);
        return { handled: true, ok: true, output: dos.pwd() };
      }

      var parsed = splitFlags(tokens);
      var flags = parsed.flags;
      var args = parsed.rest;

      switch (cmd) {
        case 'help':
        case 'doshelp':
          if (args[0] === 'mount') return { handled: true, ok: true, output: HELP_MOUNT };
          if (args[0] === 'krystals' || args[0] === 'krystal') return { handled: true, ok: true, output: HELP_KRYSTALS };
          if (args[0] === 'upstash') return { handled: true, ok: true, output: HELP_UPSTASH };
          return { handled: true, ok: true, output: HELP_MAIN };

        case 'mount': {
          if (!args.length) {
            return { handled: true, ok: true, output: formatMountTable() };
          }
          var options = { readOnly: !!flags.readOnly };
          if (flags.size) options.quota = dos.parseSize(flags.size);

          var source = args[0];
          var where = args[1] ? String(args[1]).toLowerCase() : null;
          var driveName;

          if (where && /^(ram|rom|idb|ls|host)$/i.test(where)) {
            options.type = where;
            driveName = args[2];
          } else if (/^(ram|rom|idb|ls|host):/i.test(source)) {
            driveName = args[1];
          } else if (!args[1] && (source.toLowerCase().endsWith('.gfx') || source.toLowerCase().endsWith('.json') || /^https?:\/\//i.test(source))) {
            options.type = 'ram';
          } else if (args[1]) {
            throw new Error('unknown mount location: ' + args[1] + ' (use ram or rom)');
          } else {
            return { handled: true, ok: true, output: usage('mount <file> <ram|rom> [name] [-r] [-s size]') };
          }

          var mountedName = await dos.mount(source, driveName, options);
          var info = dos.mounts().filter(function (r) { return r.name === mountedName; })[0];
          return {
            handled: true,
            ok: true,
            output: 'Mounted ' + mountedName + ':/ (' + info.type + ', ' + (info.readOnly ? 'read-only' : 'read-write') + ')'
          };
        }

        case 'drives':
          return { handled: true, ok: true, output: formatMountTable() };

        case 'umount':
        case 'unmount':
        case 'eject':
          if (!args[0]) return { handled: true, ok: true, output: usage('umount <drive>') };
          dos.umount(args[0]);
          return { handled: true, ok: true, output: 'Unmounted: ' + args[0].replace(/:$/, '') };

        case 'pwd':
          return { handled: true, ok: true, output: dos.pwd() };

        case 'format': {
          if (!args[0]) return { handled: true, ok: true, output: usage('format <drive> [-y]') };
          var targetName = dos.resolveDriveName(args[0]);
          if (!targetName) throw new Error('drive not mounted: ' + args[0]);
          var info = dos.mounts().filter(function (m) { return m.name === targetName; })[0];
          if (info && info.count > 0 && !flags.yes) {
            return {
              handled: true,
              ok: true,
              output: 'This will erase ' + info.count + ' entries (' + dos.formatSize(info.used) +
                ') on ' + targetName + '. This cannot be undone.\nRe-run to confirm: format ' + targetName + ' -y'
            };
          }
          var fmtRes = dos.formatDrive(targetName);
          return { handled: true, ok: true, output: 'Formatted "' + fmtRes.name + '" (' + fmtRes.erased + ' entries erased).' };
        }

        case 'dir': {
          var wcDir = dos.extractWildcard(args[0] || '');
          var dirRef = resolveRef(wcDir.path);
          var dirRes = dos.getDirEntries(dirRef.driveName, dirRef.path);
          var lines = [];

          dirRes.subdirs.forEach(function (d) {
            if (!wcDir.regex || wcDir.regex.test(d)) {
              lines.push(d + '/  0 bytes');
            }
          });
          dirRes.files.forEach(function (f) {
            var fn = dos.rawBaseName(f.name);
            if (!wcDir.regex || wcDir.regex.test(fn)) {
              lines.push(
                fn + '  ' + (f.size || 0) + ' bytes  ' + (f.timestamp || '') +
                (dos.isWriteProtected(f.name) ? '  [ro]' : '')
              );
            }
          });

          return { handled: true, ok: true, output: lines.join('\n') || '(empty)' };
        }

        case 'ls':
        case 'list': {
          var wcLs = dos.extractWildcard(args[0] || '');
          var lsRef = resolveRef(wcLs.path);
          var lsRes = dos.getDirEntries(lsRef.driveName, lsRef.path);
          var outLines = [];

          lsRes.subdirs.forEach(function (d) {
            if ((!wcLs.regex || wcLs.regex.test(d)) && !dos.isHidden(d)) outLines.push(d + '/');
          });
          lsRes.files.forEach(function (f) {
            var fn = dos.rawBaseName(f.name);
            if ((!wcLs.regex || wcLs.regex.test(fn)) && !dos.isHidden(fn)) outLines.push(fn);
          });

          return { handled: true, ok: true, output: outLines.join('\n') || '(empty)' };
        }

        case 'cd':
        case 'chdir': {
          var cdRef = resolveRef(args.join(' ') || '/');
          if (cdRef.path && !dos.dirExists(cdRef.driveName, cdRef.path)) {
            throw new Error('directory not found');
          }
          dos.setDrive(cdRef.driveName);
          var newCwd = cdRef.path ? ('/' + cdRef.path + '/') : '/';
          dos.setDriveCwd(cdRef.driveName, newCwd);
          return { handled: true, ok: true, output: cdRef.driveName + ':' + newCwd };
        }

        case 'mkdir':
        case 'md': {
          if (!args[0]) return { handled: true, ok: true, output: usage('mkdir <path>') };
          var mkRef = resolveRef(args.join(' '));
          var mkr = dos.dirMake(mkRef.driveName, '/', mkRef.path, 'console');
          if (!mkr.success) throw new Error(mkr.error);
          return { handled: true, ok: true, output: 'Directory created.' };
        }

        case 'rmdir':
        case 'rd': {
          if (!args[0]) return { handled: true, ok: true, output: usage('rmdir <path>') };
          var rmRef = resolveRef(args.join(' '));
          var rmr = dos.dirRemove(rmRef.driveName, '/', rmRef.path, 'console');
          if (!rmr.success) throw new Error(rmr.error);
          var curC = dos.getDriveCwd(rmRef.driveName).replace(/^\/+|\/+$/g, '');
          if (curC === rmRef.path || curC.indexOf(rmRef.path + '/') === 0) {
            dos.setDriveCwd(rmRef.driveName, '/');
          }
          return { handled: true, ok: true, output: 'Directory removed.' };
        }

        case 'echo':
          return { handled: true, ok: true, output: args.join(' ') };

        case 'cls':
        case 'clear':
          if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
          return { handled: true, ok: true, output: '' };

        case 'alpha': {
          var aRef = resolveRef(args[0] || '');
          var aRes = dos.getDirEntries(aRef.driveName, aRef.path);
          if (!aRes.files.length) return { handled: true, ok: true, output: '(no variables found)' };
          var alphaOut = [];
          for (var ai = 0; ai < aRes.files.length; ai++) {
            var ae = aRes.files[ai];
            var aName = dos.rawBaseName(ae.name);
            var aLoaded = dos.fileLoad(aRef.driveName, '/', ae.name, 'console');
            var aVal = aLoaded.success ? String(aLoaded.content == null ? '' : aLoaded.content) : '';
            aVal = sanitizeForTerminal(aVal).trim().replace(/\r?\n/g, '\\n');
            alphaOut.push(aName + ' = ' + aVal);
          }
          return { handled: true, ok: true, output: alphaOut.join('\n') };
        }

        case 'save':
        case 'write': {
          if (args.length < 2) return { handled: true, ok: true, output: usage('save <file> <text>') };
          var svRef = resolveRef(args[0]);
          if (!svRef.path) throw new Error('invalid path');
          var svRes = dos.fileSave(svRef.driveName, '/', svRef.path, args.slice(1).join(' '), 'console', 'console');
          if (!svRes.success) throw new Error(svRes.error);
          return { handled: true, ok: true, output: 'File saved.' };
        }

        case 'load':
        case 'type': {
          if (!args[0]) return { handled: true, ok: true, output: usage(cmd + ' <file>') };
          var tyRef = resolveRef(args.join(' '));
          if (!tyRef.path) throw new Error('invalid path');
          var tyRes = dos.fileLoad(tyRef.driveName, '/', tyRef.path, 'console');
          if (!tyRes.success) return { handled: true, ok: true, output: 'File not found.' };
          var rawText = tyRes.content == null ? '' : String(tyRes.content);
          var fullLen = rawText.length;
          var truncated = false;
          if (rawText.length > TYPE_MAX_BYTES) {
            rawText = rawText.slice(0, TYPE_MAX_BYTES);
            truncated = true;
          }
          var safe = sanitizeForTerminal(rawText);
          if (truncated) {
            safe += '\n(Output truncated at ' + TYPE_MAX_BYTES + ' bytes. Full size: ' + fullLen + ' bytes)';
          }
          return { handled: true, ok: true, output: safe };
        }

        case 'copy':
        case 'cp': {
          if (args.length < 2) return { handled: true, ok: true, output: usage('copy <src> <dst> [-k]') };
          var cpSrc = resolveRef(args[0]);
          var cpDst = resolveRef(args[1]);
          var copiedTo = dos.copyPath(cpSrc.driveName, cpSrc.path, cpDst.driveName, cpDst.path, args[0], { keepFlags: !!flags.keep });
          return { handled: true, ok: true, output: 'Copied to ' + copiedTo };
        }

        case 'rename':
        case 'ren':
        case 'move':
        case 'mv': {
          var rnSrcArg, rnDstArg;
          if (args.length >= 2) {
            rnSrcArg = args[0];
            rnDstArg = args.slice(1).join(' ');
          } else if (args.length === 1 && args[0].indexOf('=') !== -1) {
            var eqIdx = args[0].indexOf('=');
            rnSrcArg = args[0].slice(0, eqIdx).trim();
            rnDstArg = args[0].slice(eqIdx + 1).trim();
          } else {
            return { handled: true, ok: true, output: usage('rename <old> <new>') };
          }
          var rnSrc = resolveRef(rnSrcArg);
          var rnDst = resolveRef(rnDstArg, rnSrc.driveName);
          if (rnSrc.driveName !== rnDst.driveName) {
            throw new Error('cannot rename across drives (use copy)');
          }
          var rnr = dos.fileRename(rnSrc.driveName, '/', rnSrc.path, rnDst.path, 'console');
          if (!rnr.success) throw new Error(rnr.error);
          return { handled: true, ok: true, output: 'Renamed.' };
        }

        case 'delete':
        case 'del':
        case 'rm': {
          if (!args[0]) return { handled: true, ok: true, output: usage('delete <file|pattern> [-y]') };
          var delInput = args.join(' ');
          var wcDel = dos.extractWildcard(delInput);
          if (!wcDel.regex) {
            var delRef = resolveRef(delInput);
            if (!delRef.path) throw new Error('invalid path');
            var fdr = dos.fileDelete(delRef.driveName, '/', delRef.path, 'console');
            if (!fdr.success) throw new Error(fdr.error);
            return { handled: true, ok: true, output: 'File deleted.' };
          }
          var delDirRef = resolveRef(wcDel.path);
          var delList = dos.getDirEntries(delDirRef.driveName, delDirRef.path);
          var targets = delList.files.filter(function (f) {
            return !dos.isWriteProtected(f.name) && wcDel.regex.test(dos.rawBaseName(f.name));
          });
          if (!targets.length) throw new Error('no matching writable files found');
          if (targets.length > 1 && !flags.yes) {
            return {
              handled: true,
              ok: true,
              output: 'This will delete ' + targets.length + ' files. Re-run to confirm: delete ' + delInput + ' -y'
            };
          }
          var delCount = 0;
          for (var ti = 0; ti < targets.length; ti++) {
            if (dos.fileDelete(delDirRef.driveName, '/', targets[ti].name, 'console').success) delCount++;
          }
          return { handled: true, ok: true, output: 'Deleted ' + delCount + ' file(s).' };
        }

        case 'exists': {
          if (!args[0]) return { handled: true, ok: true, output: usage('exists <path>') };
          var exRef = resolveRef(args.join(' '));
          if (!exRef.path) return { handled: true, ok: true, output: 'TRUE' };
          var found = dos.dirExists(exRef.driveName, exRef.path) ||
                      dos.fileExists(exRef.driveName, '/', exRef.path).exists;
          return { handled: true, ok: true, output: found ? 'TRUE' : 'FALSE' };
        }

        case 'export': {
          var targetDrive = null;
          var fileName = null;

          if (args.length >= 2) {
            targetDrive = args[0];
            fileName = args[1];
          } else if (args.length === 1) {
            if (dos.resolveDriveName(args[0])) {
              targetDrive = args[0];
            } else {
              fileName = args[0];
            }
          }

          if (!targetDrive) {
            var p = dos.pwd();
            if (p === '(no drive)') throw new Error('no drive mounted');
            targetDrive = p.substring(0, p.indexOf(':'));
          }

          var resolvedTarget = dos.resolveDriveName(targetDrive);
          if (!resolvedTarget) throw new Error('drive not mounted: ' + targetDrive);

          if (!fileName) fileName = resolvedTarget + '.json';
          if (!/\.json$/i.test(fileName)) fileName += '.json';

          var expRes = dos.exportDrive(resolvedTarget, fileName);
          if (!expRes.success) throw new Error(expRes.error);
          return { handled: true, ok: true, output: expRes.result };
        }

        case 'import': {
          if (!args[0]) return { handled: true, ok: true, output: usage('import <file> [ram|rom] [drive] [-m]') };
          var fileArg = args[0];
          var typeArg = args[1];
          var driveArg = args[2];
          var targetImpDrive = null;
          var lockAsRom = false;

          if (typeArg && driveArg) {
            targetImpDrive = driveArg.replace(/:$/, '');
            var kind = String(typeArg).toLowerCase();
            if (!/^(ram|rom)$/.test(kind)) {
              throw new Error('invalid drive type "' + typeArg + '" (use ram or rom)');
            }
            if (!dos.getDrive(targetImpDrive)) {
              await dos.mount('ram:', targetImpDrive, { type: 'ram' });
              if (kind === 'rom') lockAsRom = true;
            }
          } else if (args[1] && !args[2]) {
            // Backward-compatible: import <file> <drive>
            targetImpDrive = args[1].replace(/:$/, '');
          } else {
            var pwdStr = dos.pwd();
            if (pwdStr === '(no drive)') throw new Error('no drive mounted');
            targetImpDrive = pwdStr.substring(0, pwdStr.indexOf(':'));
          }

          var rawText = fileArg;
          if (fileArg.charAt(0) !== '{') {
            var resolved = path.resolve(process.cwd(), fileArg);
            if (!fs.existsSync(resolved)) throw new Error('cannot read file: ' + fileArg);
            rawText = fs.readFileSync(resolved, 'utf8');
          }

          var impRes = dos.importDriveData(targetImpDrive, rawText, 'console', { mode: flags.merge ? 'merge' : 'replace' });
          if (!impRes.success) throw new Error(impRes.error);

          if (lockAsRom) {
            var importedDrive = dos.getDrive(targetImpDrive);
            if (importedDrive) {
              importedDrive.type = 'rom';
              importedDrive.readOnly = true;
            }
          }

          return { handled: true, ok: true, output: impRes.result };
        }

        case 'exam':
        case 'examine': {
          if (!args[0]) return { handled: true, ok: true, output: usage('exam <filename>') };
          var exmRef = resolveRef(args.join(' '));
          var exEntry = dos.findEntry(exmRef.driveName, exmRef.path) || dos.findEntry(exmRef.driveName, args.join(' '));
          if (!exEntry) throw new Error('file "' + args.join(' ') + '" not found');
          return {
            handled: true,
            ok: true,
            output: [
              'File: ' + dos.rawBaseName(exEntry.name),
              'Path: ' + exmRef.driveName + ':/' + exEntry.name,
              'Size: ' + (exEntry.size || 0) + ' bytes',
              'Created: ' + _formatTimestampHuman(exEntry.timestamp),
              'Owner Token: ' + (exEntry.session || '(none)') + ' (' + (exEntry.owner || '(none)') + ')'
            ].join('\n')
          };
        }

        case 'search': {
          if (!args[0]) return { handled: true, ok: true, output: usage('search <pattern>') };
          var cur = dos.pwd();
          if (cur === '(no drive)') throw new Error('no drive mounted');
          var sDrive = cur.substring(0, cur.indexOf(':'));
          var srRes = dos.fileSearch(sDrive, args[0]);
          if (!srRes.success) throw new Error(srRes.error);
          if (!srRes.results.length) return { handled: true, ok: true, output: 'No matching files found.' };
          var rows = srRes.results.map(function (sr) {
            return '  ' + sr.name.padEnd(30) + ' | ' + String(sr.size).padStart(6) + ' bytes | ' + sr.timestamp;
          });
          return {
            handled: true,
            ok: true,
            output: 'Search results for "' + args[0] + '":\n' + rows.join('\n') +
                    '\n\nTotal: ' + srRes.results.length + ' match(es) found.'
          };
        }

        case 'serverstorage': {
          var driveArg2 = args[0];
          if (!driveArg2) {
            var curPwd2 = dos.pwd();
            if (curPwd2 !== '(no drive)') driveArg2 = curPwd2.substring(0, curPwd2.indexOf(':'));
          }
          if (!driveArg2) return { handled: true, ok: true, output: usage('serverstorage [drive-name]') };

          var info2 = dos.getDriveDebugInfo(driveArg2);
          if (!info2) {
            var available = dos.listDrives();
            return {
              handled: true,
              ok: false,
              output: 'Error: drive "' + driveArg2 + '" not found.' +
                (available.length ? '\nAvailable drives: ' + available.join(', ') : '')
            };
          }

          var out2 = [];
          out2.push('='.repeat(60));
          out2.push('DRIVE STORAGE DEBUG: ' + info2.driveName);
          out2.push('='.repeat(60));
          out2.push('Type: ' + info2.type + ' (' + (info2.readOnly ? 'ro' : 'rw') + ')');
          out2.push('Source: ' + info2.source);
          out2.push('Owner: ' + info2.owner);
          out2.push('Created: ' + info2.created);
          out2.push('Files: ' + info2.stats.fileCount + ' (' + dos.formatBytes(info2.stats.totalSize) + ')');
          out2.push('Directories: ' + info2.dirTokens.length);
          out2.push('Storage entries: ' + info2.storageSize);
          out2.push('');

          if (info2.dirTokens.length) {
            out2.push('DIRECTORIES (' + info2.dirTokens.length + '):');
            info2.dirTokens.forEach(function (dt) {
              var n = dt.key || '';
              out2.push('  ' + (n.length > 50 ? n.substring(0, 47) + '...' : n));
            });
            out2.push('');
          }

          if (info2.fileEntries.length) {
            out2.push('FILES (' + info2.fileEntries.length + '):');
            info2.fileEntries.forEach(function (fe) {
              var k = fe.key.length > 35 ? fe.key.substring(0, 32) + '...' : fe.key;
              var val = fe.val || '';
              var c = (val.length > 40 ? val.substring(0, 37) + '...' : val)
                .replace(/[\r\n\t]/g, function (ch) { return ch === '\r' ? '\\r' : ch === '\n' ? '\\n' : '\\t'; });
              out2.push('  ' + k.padEnd(35) + ' | ' + String(dos.utf8len(val)).padStart(6) + 'b | ' + c);
            });
            out2.push('');
          }
          out2.push('='.repeat(60));
          return { handled: true, ok: true, output: out2.join('\n') };
        }

        case 'krystals':
        case 'krystal': {
          if (!krystals) return { handled: true, ok: true, output: 'Krystals module not attached.' };
          var kList = krystals.getList();
          if (!kList || !kList.length) return { handled: true, ok: true, output: 'No krystals transmitting on this server.' };
          var kRows = [['Frequency', 'Device', 'Secure']];
          kList.forEach(function (k) { kRows.push([k.frequency, k.device, k.secure ? 'YES' : 'NO']); });
          return { handled: true, ok: true, output: table(kRows) };
        }

        case 'players': {
          if (!getPlayers) return { handled: true, ok: true, output: 'Player index not available.' };
          var map = getPlayers();
          if (!map || map.size === 0) return { handled: true, ok: true, output: 'No active players.' };
          var pRows = [['Session', 'User', 'Drive', 'Sector', 'Z', 'Item']];
          map.forEach(function (p, sess) {
            pRows.push([
              sess,
              p.username || ('guest-' + (p.pubId || '?')),
              p.drive || '-',
              p.map || '-',
              String(p.z != null ? p.z : '-'),
              p.item || '-'
            ]);
          });
          return { handled: true, ok: true, output: table(pRows) };
        }

        case 'devteam': {
          var dtDrive = null;
          if (args[0] && DRIVE_TOKEN_RE.test(args[0])) {
            dtDrive = dos.resolveDriveName(args.shift());
            if (!dtDrive) throw new Error('drive not mounted');
          } else {
            var dtPwd = dos.pwd();
            if (dtPwd === '(no drive)') throw new Error('no drive mounted');
            dtDrive = dtPwd.substring(0, dtPwd.indexOf(':'));
          }

          var dtDriveObj = dos.getDrive(dtDrive);
          if (!dtDriveObj) throw new Error('drive not mounted: ' + dtDrive);

          if (!dos.dirExists(dtDrive, 'a')) {
            return {
              handled: true,
              ok: false,
              output: 'Error: /a/ directory does not exist on ' + dtDrive + ':/ (devteam not authorized).'
            };
          }

          if (dtDriveObj.readOnly) {
            return {
              handled: true,
              ok: false,
              output: 'Error: drive ' + dtDrive + ':/ is read-only (ROM mode).'
            };
          }

          var dtLoad = dos.fileLoad(dtDrive, '/', 'a/playerDevTeam', 'console');
          var dtMembers = [];
          if (dtLoad.success && dtLoad.content) {
            dtMembers = dtLoad.content
              .split(/\r?\n/)
              .map(function (s) { return s.trim().toLowerCase(); })
              .filter(Boolean);
          }

          // Bare `devteam` -> list current members
          if (!args.length) {
            if (!dtMembers.length) {
              return { handled: true, ok: true, output: '(no devteam members on ' + dtDrive + ':/)' };
            }
            return {
              handled: true,
              ok: true,
              output: 'DevTeam (' + dtDrive + ':/):\n  ' + dtMembers.join('\n  ')
            };
          }

          var dtArg = args[0].trim();

          // `devteam -<username>` -> remove member
          if (dtArg.charAt(0) === '-') {
            var remUser = dtArg.substring(1).trim().toLowerCase();
            if (!remUser) {
              return { handled: true, ok: false, output: usage('devteam [drive:] <username | -username>') };
            }
            var remIdx = dtMembers.indexOf(remUser);
            if (remIdx === -1) {
              return { handled: true, ok: false, output: 'User "' + remUser + '" is not on the devteam.' };
            }
            dtMembers.splice(remIdx, 1);
            if (dtMembers.length === 0) {
              dos.fileDelete(dtDrive, '/', 'a/playerDevTeam', 'console');
            } else {
              var remSave = dos.fileSave(dtDrive, '/', 'a/playerDevTeam', dtMembers.join('\n') + '\n', 'console', 'console');
              if (!remSave.success) throw new Error(remSave.error);
            }
            return {
              handled: true,
              ok: true,
              output: 'Removed "' + remUser + '" from devteam on ' + dtDrive + ':/'
            };
          }

          // `devteam <username>` -> add member
          if (!/^[A-Za-z0-9]{3,15}$/.test(dtArg) || /^guest/i.test(dtArg)) {
            return {
              handled: true,
              ok: false,
              output: 'Error: invalid username "' + dtArg + '" (3-15 alphanumeric chars, cannot start with guest).'
            };
          }
          var addUser = dtArg.toLowerCase();
          if (dtMembers.indexOf(addUser) !== -1) {
            return { handled: true, ok: true, output: 'User "' + addUser + '" is already on the devteam.' };
          }
          dtMembers.push(addUser);
          var addSave = dos.fileSave(dtDrive, '/', 'a/playerDevTeam', dtMembers.join('\n') + '\n', 'console', 'console');
          if (!addSave.success) throw new Error(addSave.error);

          var warnNote = '';
          if (!dos.fileExists(dtDrive, '/', 'u/' + addUser).exists) {
            warnNote = ' (note: user account not yet registered in u/)';
          }
          return {
            handled: true,
            ok: true,
            output: 'Added "' + addUser + '" to devteam on ' + dtDrive + ':/' + warnNote
          };
        }

        case 'upstash': {
          if (!upstash) {
            return { handled: true, ok: false, output: 'Error: Upstash module not attached.' };
          }
          if (!upstash.isConfigured()) {
            return { handled: true, ok: false, output: 'Error: Upstash is not configured (.env missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).' };
          }

          var uPwd = dos.pwd();
          if (uPwd === '(no drive)') {
            return { handled: true, ok: false, output: 'Change directory to a .gfx drive to access user files.' };
          }
          var uDrive = uPwd.substring(0, uPwd.indexOf(':'));
          var uDriveObj = dos.getDrive(uDrive);
          var isGfx = uDriveObj && ((uDriveObj.source && /\.gfx$/i.test(uDriveObj.source)) || dos.dirExists(uDrive, 'w'));
          if (!isGfx) {
            return { handled: true, ok: false, output: 'Change directory to a .gfx drive to access user files.' };
          }
          if (uDriveObj.readOnly) {
            return { handled: true, ok: false, output: 'Error: drive ' + uDrive + ':/ is read-only (ROM mode).' };
          }
          if (!upstash.getNamespace(uDrive)) {
            return { handled: true, ok: false, output: 'Error: Upstash is not enabled on ' + uDrive + ':/ (missing or disabled a/gfxUpstash).' };
          }

          var sub = (args[0] || 'list').toLowerCase();

          if (sub === 'list' || sub === 'ls') {
            var pat = args[1] || '*';
            var lRes = await upstash.list(uDrive, pat);
            if (!lRes.ok) return { handled: true, ok: false, output: 'Error: ' + lRes.error };
            if (!lRes.names.length) {
              return { handled: true, ok: true, output: '(no player files matching "' + pat + '" in ' + lRes.gfx + ')' };
            }
            return {
              handled: true,
              ok: true,
              output: 'Players (' + lRes.gfx + ', ' + lRes.names.length + '):\n  ' + lRes.names.join('\n  ')
            };
          }

          if (sub === 'view') {
            if (!args[1]) return { handled: true, ok: true, output: usage('upstash view <player>') };
            var vRes = await upstash.view(uDrive, args[1]);
            if (!vRes.ok) return { handled: true, ok: false, output: 'Error: ' + vRes.error };
            var rec = vRes.record;
            var statusDisp = rec.status || 'player';
            if (vRes.statusInfo && vRes.statusInfo.expired) {
              statusDisp += ' (expired -> reverts to player on next login)';
            }
            var lines = [
              'Player File (' + vRes.gfx + '):',
              '  Username:   ' + sanitizeForTerminal(rec.username),
              '  Password:   ' + (rec.password ? '[hashed]' : '(none)'),
              '  Status:     ' + sanitizeForTerminal(statusDisp),
              '  Server:     ' + (rec.server ? sanitizeForTerminal(rec.server) : '(offline)'),
              '  Location:   sector ' + sanitizeForTerminal(rec.sector) + ', z ' + sanitizeForTerminal(rec.z),
              '  Item/Avat:  ' + sanitizeForTerminal(rec.item || '') + ' / ' + sanitizeForTerminal(rec.avatar || '(none)'),
              '  Created:    ' + _formatTimestampHuman(rec.created),
              '  Last Login: ' + _formatTimestampHuman(rec.lastLogin),
              '  Inventory:  ' + sanitizeForTerminal(rec.inventory || '')
            ];
            return { handled: true, ok: true, output: lines.join('\n') };
          }

          if (sub === 'ban' || sub === 'mute') {
            if (!args[1]) return { handled: true, ok: true, output: usage('upstash ' + sub + ' <player> [duration]') };
            var sRes = await upstash.setStatus(uDrive, args[1], sub, args[2]);
            if (!sRes.ok) return { handled: true, ok: false, output: 'Error: ' + sRes.error };
            var extra = sRes.kicked ? ' (kicked active session)' : '';
            return {
              handled: true,
              ok: true,
              output: 'Updated ' + sRes.username + ' status -> ' + sRes.status + extra
            };
          }

          if (sub === 'del' || sub === 'delete' || sub === 'rm') {
            if (!args[1]) return { handled: true, ok: true, output: usage('upstash del <player> -y') };
            if (!flags.yes) {
              return {
                handled: true,
                ok: true,
                output: 'This will permanently delete player "' + args[1] + '" from Upstash.\nRe-run to confirm: upstash del ' + args[1] + ' -y'
              };
            }
            var dRes = await upstash.del(uDrive, args[1]);
            if (!dRes.ok) return { handled: true, ok: false, output: 'Error: ' + dRes.error };
            return {
              handled: true,
              ok: true,
              output: 'Deleted player "' + dRes.username + '" from Upstash' + (dRes.kicked ? ' (kicked active session)' : '') + '.'
            };
          }

          return { handled: true, ok: true, output: HELP_UPSTASH };
        }

        case 'exit':
        case 'shutdown':
        case 'quit':
          process.stdout.write('\nGracefully shutting down Qandyland Server...\n');
          shutdown();
          return { handled: true, ok: true, exit: true, output: '' };

        default:
          return { handled: false, ok: false, output: 'Error: Unknown command: ' + rawCmd };
      }
    } catch (err) {
      return { handled: true, ok: false, output: 'Error: ' + (err && err.message ? err.message : String(err)) };
    }
  };
}

// ── Console initialization ────────────────────────────────────────────────────

function init(opts) {
  if (!process.stdin.isTTY) return null;

  opts = opts || {};
  var dos = opts.dos;
  var execute = opts.execute || createExecutor(opts);

  function getPrompt() {
    var p = dos.pwd();
    if (p !== '(no drive)' && !p.endsWith('/')) p += '/';
    return p + ' ';
  }

  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: getPrompt()
  });

  rl.prompt();

  // Queue lines sequentially so async mount/import commands never race
  var queue = Promise.resolve();

  rl.on('line', function (line) {
    queue = queue.then(async function () {
      var trimmed = line.trim();
      if (trimmed) {
        var res = await execute(trimmed);
        if (res && res.exit) return;
        if (res && res.output) {
          process.stdout.write(res.output + (res.output.endsWith('\n') ? '' : '\n'));
        }
      }
      rl.setPrompt(getPrompt());
      rl.prompt();
    }).catch(function (err) {
      process.stdout.write('Error: ' + (err && err.message ? err.message : String(err)) + '\n');
      rl.setPrompt(getPrompt());
      rl.prompt();
    });
  }).on('close', function () {
    process.exit(0);
  });

  return rl;
}

module.exports = {
  init: init,
  createExecutor: createExecutor,
  sanitizeForTerminal: sanitizeForTerminal,
  parseArgs: parseArgs
};
