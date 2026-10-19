/*
 * Cylon terminal command layer.
 *
 * This file intentionally contains no IndexedDB code. It translates terminal
 * commands into calls to CylonDOS, keeping the command UI separate from the
 * filesystem backend.
 */
(function (global) {
  'use strict';

  var FLAG_ALIASES = {
    r: 'readOnly', ro: 'readOnly', readonly: 'readOnly',
    s: 'size', size: 'size',
    y: 'yes', yes: 'yes', f: 'yes', force: 'yes',
    l: 'list', k: 'keep', keep: 'keep',
    u: 'uninstall', uninstall: 'uninstall'
  };
  var VALUE_FLAGS = { size: true };
  var DRIVE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}:$/;

  function parseArgs(line) {
    var tokens = [];
    var match;
    var re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
    line = String(line || '');
    while ((match = re.exec(line)) !== null) {
      tokens.push(match[1] !== undefined ? match[1].replace(/\\([\\"'])/g, '$1') :
        match[2] !== undefined ? match[2].replace(/\\(['"])/g, '$1') : match[3]);
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

  function errorText(error) {
    return 'Error: [.4]' + (error && error.message ? error.message : String(error)+'[.4]');
  }

  function usage(text) {
    return 'Usage: ' + text;
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
      return row.map(function (cell, i) { return i === row.length - 1 ? String(cell) : pad(cell, widths[i] + 2); }).join('');
    }).join('\n');
  }

  var HELP_MAIN = [
    'Cylon DOS commands:\n',
    'Drives & Partitions',
    '  mount                          Manage mounts (type "help mount" for details)',
    '  fdisk                          Manage partitions (type "help fdisk" for details)',
    '  umount <name>                  Unmount a drive (also: eject)',
    '  <name>:                        Switch the current drive (e.g. live:)',
    '  pwd                            Show the current drive and directory',
    '  format <partition> [-y]        Erase a partition and start clean\n',
    'Files (paths may start with a drive, e.g. live:/bin/tool)',
    '  dir [path]                     Detailed directory listing',
    '  ls [path]                      List names in a directory',
    '  cd [path]                      Change directory (cd live:/ also switches drive)',
    '  mkdir <path>                   Create a directory',
    '  rmdir <path>                   Remove an empty directory',
    '  save <file> <text>             Save text to a file',
    '  load <file>                    Smart launch/execute a file based on extension',
    '  type <file>                    Dump raw text of a file to terminal',
    '  copy <src> <dst>               Copy a file or directory (across drives too)',
    '  rename <old> <new>             Rename or move within a drive',
    '  delete <file>                  Delete a file',
    '  exists <path>                  Test whether a path exists',
    '  export [drive] [filename]      Export a drive as JSON',
    '  import <file> [type] [drive]   Import JSON (creates/mounts drive if type given)',
    '  install [desktop file] [-y]    Install Cylon OS with selected desktop',
    '  uninstall [-y]                 Delete Cylon DOS from indexDB',
    '  update <file|*> [-y]           Update file on indexDB with newer version',
    '  echo [text]                    Print text to the console',
    '  cls                            Clear the terminal screen',
    '  reboot [-y]                    Reboot Cylon DOS', 
    '  help [command]                 Show help (e.g. "help mount" or "help fdisk")\n'
  ].join('\n');

  var HELP_MOUNT = [
    'Mount Command Help:\n',
    '  mount                               Show the mount table',
    '  mount <file> <where> [name] [-r]    Mount a drive. <where> says what kind:',
    '                                        idb  IndexedDB partition named <file>',
    '                                        ls   localStorage drive named <file>   (-s <size>)',
    '                                        ram  RAM drive loaded from <file|url>  (-s <size>)',
    '                                        rom  read-only image from <file|url>',
    '  mount ram:                          Blank RAM drive named "ram"\n',
    '  The drive is named after <file> unless you give a [name]. Examples:',
    '    mount cylon.json idb',
    '    mount cylon.json ram',
    '    mount https://example.com/live.json rom live\n'
  ].join('\n');

  var HELP_FDISK = [
    'Fdisk Command Help:\n',
    '  fdisk [-l]                     List the disk and its partitions',
    '  fdisk new <name> [size]        Create a partition (default 10M, allocated on demand)',
    '  fdisk resize <name> <size>     Change a partition\'s size limit',
    '  fdisk delete <name> [-y]       Delete a partition and its data',
    '  fdisk boot <name|none>         Mark the partition to boot from\n'
  ].join('\n');

  function ownedBy(part) { return part.mountedAs.length ? part.mountedAs.join(',') : '-'; }

  async function fdiskList(dos) {
    var disks = await dos.disks();
    var out = [];
    disks.forEach(function (disk) {
      var line = 'Disk ' + disk.name + ': IndexedDB "' + disk.database + '"  ' +
        dos.formatSize(disk.used) + ' used, ' + dos.formatSize(disk.allocated) + ' allocated';
      if (disk.browserQuota) line += ', browser quota ' + dos.formatSize(disk.browserQuota);
      out.push(line);
      if (!disk.partitions.length) {
        out.push('(no partitions - create one with: fdisk new <name> [size])');
        return;
      }
      var rows = [['Type', 'Partition', 'Size', 'Used', 'Entries', 'Boot', 'Mounted']];
      disk.partitions.forEach(function (p) {
        rows.push(['indexDB', p.name, dos.formatSize(p.quota), dos.formatSize(p.used), p.count, p.boot ? '*' : '', ownedBy(p)]);
      });
      out.push(table(rows));
    });
    return out.join('\n');
  }

  async function fdiskCommand(dos, args, flags) {
    if (args[0] && /^idb\d+$/i.test(args[0])) {
      var device = args.shift().toLowerCase();
      if (device !== dos.constants.DISK) throw new Error('no such device: ' + device);
    }
    var sub = (args.shift() || 'list').toLowerCase();
    var part;

    switch (sub) {
      case 'list':
      case 'l':
        return fdiskList(dos);

      case 'new':
      case 'create':
      case 'add':
        if (!args[0]) return usage('fdisk new <name> [size]');
        var size = args[1] ? dos.parseSize(args[1]) : dos.constants.DEFAULT_QUOTA;
        var created = await dos.createPartition(args[0], size);
        return ['Created ' + created.partition.device + ' "' + created.partition.name + '" (' +
          dos.formatSize(created.partition.quota) + ' limit, allocated on demand).']
          .concat(created.warnings.map(function (w) { return 'Warning: ' + w; }))
          .concat(['Mount it with: mount ' + created.partition.name]).join('\n');

      case 'resize':
        if (!args[0] || !args[1]) return usage('fdisk resize <name> <size>');
        var resized = await dos.resizePartition(args[0], dos.parseSize(args[1]));
        return ['Resized ' + resized.partition.device + ' "' + resized.partition.name + '" to ' +
          dos.formatSize(resized.partition.quota) + ' (' + dos.formatSize(resized.partition.used) + ' used).']
          .concat(resized.warnings.map(function (w) { return 'Warning: ' + w; })).join('\n');

      case 'delete':
      case 'del':
      case 'rm':
        if (!args[0]) return usage('fdisk delete <name> [-y]');
        part = await dos.getPartition(args[0]);
        if (part.count > 0 && !flags.yes) {
          return 'Partition "' + part.name + '" holds ' + part.count + ' entries (' + dos.formatSize(part.used) +
            '). This cannot be undone.\nRe-run to confirm: fdisk delete ' + part.name + ' -y';
        }
        await dos.deletePartition(part.name);
        return 'Deleted ' + part.device + ' "' + part.name + '".';

      case 'boot':
        if (!args[0]) return usage('fdisk boot <name|none>');
        var booted = await dos.setBootPartition(args[0]);
        return booted ? 'Boot partition: ' + booted : 'Boot flag cleared.';

      default:
        return usage('fdisk [-l] | new <name> [size] | resize <name> <size> | delete <name> [-y] | boot <name|none>');
    }
  }

  function wildcardToRegExp(pattern) {
    var esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + esc + '$');
  }

  function matchPages(pattern) {
    if (typeof PAGES === 'undefined') throw new Error('PAGES is not defined (cylon.htm did not load)');
    var names = [];
    PAGES.forEach(function (n) { names.push(n); });
    names.sort();
    if (pattern.indexOf('*') === -1) return PAGES.has(pattern) ? [pattern] : [];
    var re = wildcardToRegExp(pattern);
    return names.filter(function (n) { return re.test(n); });
  }

  function parseHttpDate(text) {
    if (!text) return null;
    var d = new Date(text);
    return isNaN(d.getTime()) ? null : d;
  }

  function parseLocalStamp(stamp) {
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(stamp || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }

  function formatDateShort(d) {
    if (!d) return '?';
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function checkPageUpdate(file, localEntry) {
    var localDate = localEntry ? parseLocalStamp(localEntry.timestamp) : null;
    var row = { file: file, localDate: localDate, remoteDate: null, needsUpdate: false, reason: '', error: null };

    var res;
    try {
      res = await fetch(file, { method: 'HEAD', cache: 'no-store' });
    } catch (e) {
      row.error = 'fetch failed: ' + (e && e.message ? e.message : String(e));
      return row;
    }
    if (!res.ok) {
      row.error = 'HTTP ' + res.status;
      return row;
    }
    row.remoteDate = parseHttpDate(res.headers.get('Last-Modified'));

    if (!localEntry) {
      row.needsUpdate = true;
      row.reason = 'new';
    } else if (!row.remoteDate || !localDate) {
      row.needsUpdate = true;
      row.reason = 'unknown';
    } else if (row.remoteDate.getTime() > localDate.getTime()) {
      row.needsUpdate = true;
      row.reason = 'newer';
    } else {
      row.needsUpdate = false;
      row.reason = 'current';
    }
    return row;
  }

  async function updateCommand(dos, args, flags) {
    if (!args[0]) return usage('update <file|pattern> [-y]  (e.g. update *, update gfx*)');

    var files = matchPages(args[0]);
    if (!files.length) return 'Error: no PAGES files match "' + args[0] + '"';

    var dirEntries;
    try { dirEntries = await dos.dir(''); } catch (e) { dirEntries = []; }
    var localByName = {};
    dirEntries.forEach(function (e) {
      if (e.type === 'file') localByName[e.name] = e;
    });

    var rows = [];
    for (var i = 0; i < files.length; i++) {
      rows.push(await checkPageUpdate(files[i], localByName[files[i]]));
    }

    var STATUS_TEXT = {
      new: 'new (not local)',
      newer: 'update available',
      unknown: 'unknown (will refresh)',
      current: 'up to date'
    };

    if (!flags.yes) {
      var preview = [['File', 'Status', 'Remote modified', 'Local saved']];
      var pending = 0;
      rows.forEach(function (r) {
        if (r.error) { preview.push([r.file, 'error: ' + r.error, '-', formatDateShort(r.localDate)]); return; }
        if (r.needsUpdate) pending++;
        preview.push([r.file, STATUS_TEXT[r.reason], formatDateShort(r.remoteDate), formatDateShort(r.localDate)]);
      });
      var out = [table(preview)];
      out.push('');
      out.push(pending ? (pending + ' of ' + rows.length + ' file(s) have updates available. Re-run with -y to apply.')
        : 'All ' + rows.length + ' file(s) are up to date.');
      return out.join('\n');
    }

    var results = [['File', 'Result']];
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (r.error) { results.push([r.file, 'skipped: ' + r.error]); continue; }
      if (!r.needsUpdate) { results.push([r.file, 'unchanged']); continue; }
      try {
        var res2 = await fetch(r.file, { cache: 'no-store' });
        if (!res2.ok) { results.push([r.file, 'skipped: HTTP ' + res2.status]); continue; }
        var text = await res2.text();
        await dos.save(r.file, text);
        results.push([r.file, r.reason === 'new' ? 'installed' : 'updated']);
      } catch (e) {
        results.push([r.file, 'failed: ' + (e && e.message ? e.message : String(e))]);
      }
    }
    return table(results);
  }

  var MOUNT_WHERE = {
    idb: 'idb', indexdb: 'idb', indexeddb: 'idb',
    ls: 'ls', localstorage: 'ls',
    ram: 'ram', rom: 'rom'
  };

  async function mountCommand(dos, args, flags) {
    if (!args.length) {
      var friendlyTypes = {
        'idb': 'indexDB',
        'ls': 'localStorage',
        'rom': 'rom (json)',
        'ram': 'ram'
      };

      var rows = await dos.mounts();
      if (!rows.length) return '(nothing mounted)';
      var out = [['', 'Drive', 'Type', 'Source', 'Mode', 'Used', 'Size']];
      rows.forEach(function (r) {
        var displayType = friendlyTypes[r.type] || r.type;
        out.push([r.current ? '*' : '', r.name , displayType, r.source, r.readOnly ? 'ro' : 'rw',
          dos.formatSize(r.used), r.quota ? dos.formatSize(r.quota) : '-']);
      });      
      
      return table(out) + '\n(* = current drive)';
    }
    var options = { readOnly: !!flags.readOnly };
    if (flags.size) options.quota = dos.parseSize(flags.size);

    var source = args[0];
    var where = args[1] ? MOUNT_WHERE[String(args[1]).toLowerCase()] : null;
    var driveName;
    if (where) {
      options.type = where;
      driveName = args[2];
    } else if (/^(idb|rom|ram|ls|host):/i.test(source)) {
      driveName = args[1];            
    } else if (args[1]) {
      throw new Error('unknown mount location: ' + args[1] + ' (use idb, ls, ram or rom)');
    } else {
      return usage('mount <file> <idb|ls|ram|rom> [name] [-r] [-s size]');
    }
    var name = await dos.mount(source, driveName, options);
    var rows2 = await dos.mounts();
    var info = rows2.filter(function (r) { return r.name === name; })[0];
    return 'Mounted ' + name + ':/ (' + info.type + ', ' + (info.readOnly ? 'read-only' : 'read-write') + ')';
  }

async function handleCylonCommand(line) {
    if (!global.CylonDOS) return { handled: false };

    line = String(line || '');
    var tokens = parseArgs(line);
    var rawCommand = tokens.shift() || '';
    var command = rawCommand.toLowerCase();
    var dos = global.CylonDOS;
    var result;

    if (command === 'iferror') {
        if (global.CylonLastError) {
            global.CylonLastError = ''; 
            var restOfLine = line.substring(line.toLowerCase().indexOf('iferror') + 7).trim();
            return await handleCylonCommand(restOfLine);
        } else {
            return { handled: true, output: '' };
        }
    }

    global.CylonLastError = '';

    if (!command) return { handled: true, output: '' };

    try {
      if (DRIVE_TOKEN_RE.test(rawCommand) && !tokens.length) {
        dos.setDrive(rawCommand);
        return { handled: true, output: dos.pwd() };
      }

      var parsed = splitFlags(tokens);
      var flags = parsed.flags;
      var args = parsed.rest;

      switch (command) {
        case 'help':
        case 'doshelp':
          if (args[0] === 'mount') return { handled: true, output: HELP_MOUNT };
          if (args[0] === 'fdisk') return { handled: true, output: HELP_FDISK };
          return { handled: true, output: HELP_MAIN };

        case 'mount':
          return { handled: true, output: await mountCommand(dos, args, flags) };

        case 'umount':
        case 'unmount':
        case 'unmountrom':
        case 'eject':
          if (!args[0]) return { handled: true, output: usage('umount <drive>') };
          await dos.umount(args[0]);
          return { handled: true, output: 'Unmounted: ' + args[0].replace(/:$/, '') };

        case 'fdisk':
          return { handled: true, output: await fdiskCommand(dos, args, flags) };

        case 'format':
          if (!args[0]) return { handled: true, output: usage('format <partition> [-y]') };
          var target = await dos.getPartition(args[0]);
          if (target.mountedAs.length) {
            return { handled: true, output: 'Error: ' + target.name + ' is mounted as ' + target.mountedAs.join(', ') +
              '; unmount it first (umount ' + target.mountedAs[0] + ')' };
          }
          if (target.count > 0 && !flags.yes) {
            return { handled: true, output: 'This will erase ' + target.count + ' entries (' + dos.formatSize(target.used) +
              ') on ' + target.name + '. This cannot be undone.\nRe-run to confirm: format ' + target.name + ' -y' };
          }
          result = await dos.formatPartition(target.name);
          return { handled: true, output: 'Formatted ' + target.device + ' "' + target.name + '" (' + result.erased +
            ' entries erased). Mount it with: mount ' + target.name };

        case 'uninstall':
          flags.uninstall = true; 

        case 'install':
              var parts = await dos.partitions();
              var cylonPart = parts.filter(function(p) { return p.name === 'cylon' || p.name === 'cylon.json'; })[0];
              var dtPart = parts.filter(function(p) { return p.name === 'desktop' || p.name === 'cylon-desktop.gfx'; })[0];

              if (flags.uninstall) {
                if (!cylonPart && !dtPart) {
                  return { handled: true, output: 'System is not installed.' };
                }

                var uncmds = [];
                var mnts = await dos.mounts();
        
                if (!mnts.some(function(m) { return m.name === 'ram'; })) uncmds.push('mount ram:');
                uncmds.push('ram:');
        
                if (cylonPart) {
                    if (mnts.some(function(m) { return m.name === 'cylon'; })) uncmds.push('umount cylon');
                    uncmds.push('fdisk delete ' + cylonPart.name + ' -y');
                }
                if (dtPart) {
                    if (mnts.some(function(m) { return m.name === 'desktop'; })) uncmds.push('umount desktop');
                    uncmds.push('fdisk delete ' + dtPart.name + ' -y');
                }            
        
                uncmds.push('echo Uninstallation sequence complete!');
                uncmds.push('echo Please restart the system.');
                uncmds.push('echo Run: reboot -y');

                if (!flags.yes) {
                  var unLines = [
                    'To uninstall Cylon OS, the following commands will be executed:'
                  ];
                  for (var j = 0; j < uncmds.length; j++) unLines.push('  ' + uncmds[j]);
                  unLines.push('To proceed, run: uninstall -y');
                  return { handled: true, output: unLines.join('\n') };
                }

                setTimeout(async function() {
                  try {
                    for (var i = 0; i < uncmds.length; i++) {
                       if (await global.injectAndExecute(uncmds[i]) === false) throw new Error('step failed: ' + uncmds[i]);
                    }
                  } catch (e) {
                    global.injectAndExecute('echo Uninstall macro failed: ' + e.message + '');
                  }
                }, 50);

                return { handled: true, output: 'Initializing automated uninstall script...' };
              }

              var sourceGfx = 'cylon-desktop.gfx'; 
              var profileStr = '';
              if (args[0]) {
                  profileStr = args[0] + ' ';
                  var pLower = args[0].toLowerCase();
                  if (pLower === 'cell' || pLower === 'monitor' || pLower === 'tv') {
                      sourceGfx = 'cylon-desktop-' + pLower + '.gfx';
                  } else {
                      sourceGfx = args[0]; 
                  }
              }

              if ((cylonPart || dtPart) && !flags.yes) {
                return { handled: true, output: [
                  'System already installed, input \'update\' to update or \'uninstall\' to remove.'
                ].join('\n') };
              }
      
              var mnts = await dos.mounts();
              var installcmds = [];
              
              if (!mnts.some(function(m) { return m.name === 'ram'; })) installcmds.push('mount ram:');
              installcmds.push('ram:');
      
              ['cylon', 'cylon.json', 'desktop', 'cylon-desktop.gfx', sourceGfx].forEach(function(n) {
                if (mnts.some(function(m) { return m.name === n && m.type !== 'idb'; })) installcmds.push('umount ' + n);
              });
      
              installcmds.push('import cylon.json idb cylon');
              installcmds.push('fdisk boot cylon');
              installcmds.push('import ' + sourceGfx + ' idb desktop');
              installcmds.push('cylon:');
              installcmds.push('echo Installation sequence complete!');
              installcmds.push('echo Please restart the system to boot from IndexedDB.');
              installcmds.push('echo Run: reboot -y');

              if (!cylonPart && !dtPart && !flags.yes) {
                var inLines = [
                  '',
                  'This installs Cylon OS to your browser\'s IndexedDB.',
                  'Desktop profile selected: ' + (args[0] || 'default (' + sourceGfx + ')'),
                  'To proceed, run: install ' + profileStr + '-y',
                  ''
                ];
                return { handled: true, output: inLines.join('\n') };
              }

              setTimeout(async function() {
                try {
                  for (var i = 0; i < installcmds.length; i++) {
                     if (await global.injectAndExecute(installcmds[i]) === false) throw new Error('step failed: ' + installcmds[i]);
                  }
                } catch (e) {
                  global.injectAndExecute('echo Install macro failed: ' + e.message + '');
                }
              }, 50);
              return { handled: true, output: 'Initializing automated installation script...' };

        case 'update':
          if (!args[0]) return { handled: true, output: usage('update <file|pattern> [-y]  (e.g. update *, update gfx*)') };
          return { handled: true, output: await updateCommand(dos, args, flags) };

        case 'reboot':
          if (!flags.yes) {
            return { handled: true, output: 'To confirm reboot, input reboot -y' };
          }
          setTimeout(function() {
             if (typeof window !== 'undefined') window.location.reload();
          }, 500);
          return { handled: true, output: 'Rebooting system...' };

        case 'gfx':
                  if (!args[0]) return { handled: true, output: usage('gfx <tile|fill|tele|icon|run> [data]') };
                  var gfxCmd = args[0].toLowerCase();
                  
                  // Extract raw trailing string natively to preserve all spaces/quotes
                  var matchGfx = line.match(/^\s*gfx\s+\S+\s+(.*)$/i);
                  var gfxData = matchGfx ? matchGfx[1] : '';

                  var activeFrame = document.querySelector('.page-frame.active');
                  var targetWindow = activeFrame ? activeFrame.contentWindow : window;

                  targetWindow.postMessage({
                      type: 'QANDY_GFX_CMD',
                      cmd: gfxCmd,
                      data: gfxData
                  }, '*');
                  return { handled: true, output: 'GFX Engine: ' + gfxCmd + (gfxData ? ' ' + gfxData : '') };
          
        case 'pwd':
          return { handled: true, output: dos.pwd() };

        case 'dir':
          result = await dos.dir(args[0]);
          return { handled: true, output: result.map(function (entry) {
            var bare = entry.name.replace(/^<|>$/g, '');
            var name = (bare.substring(bare.lastIndexOf('/') + 1)) + (entry.type === 'directory' ? '/' : '');
            return name + '  ' + entry.size + ' bytes  ' + (entry.timestamp || '') + (entry.readOnly ? '  [ro]' : '');
          }).join('\n') || '(empty)' };

        case 'ls':
        case 'list':
          result = await dos.list(args[0]);
          return { handled: true, output: result || '(empty)' };

        case 'cd':
        case 'chdir':
          result = await dos.chdir(args.join(' ') || '');
          return { handled: true, output: result };

        case 'mkdir':
        case 'md':
          if (!args[0]) return { handled: true, output: usage('mkdir <path>') };
          await dos.mkdir(args.join(' '));
          return { handled: true, output: 'Directory created.' };

        case 'rmdir':
        case 'rd':
          if (!args[0]) return { handled: true, output: usage('rmdir <path>') };
          await dos.rmdir(args.join(' '));
          return { handled: true, output: 'Directory removed.' };

        case 'echo':
          return { handled: true, output: args.join(' ') };

        case 'save':
        case 'write':
          if (args.length < 2) return { handled: true, output: usage('save <file> <text>') };
          await dos.save(args[0], args.slice(1).join(' '));
          return { handled: true, output: 'File saved.' };

        // === UPGRADED SMART LOAD / TYPE COMMANDS ===
        case 'load':
        case 'type':
          if (!args[0]) return { handled: true, output: usage((command === 'type' ? 'type' : 'load') + ' <file>') };
          var filePath = args.join(' ');
          result = await dos.load(filePath);
          
          if (result === null) return { handled: true, output: 'File not found.' };

          if (command === 'type') {
              return { handled: true, output: result }; // Strictly text dump
          }

          var lowerPath = filePath.toLowerCase();
          
          // Execute OS applications seamlessly
          if (lowerPath.endsWith('.htm') || lowerPath.endsWith('.html')) {
              await global.PageOpen(filePath);
              return { handled: true, output: 'Opened ' + filePath };
          } 
          // Evaluate pure JS natively
          else if (lowerPath.endsWith('.js')) {
              try {
                  var runFn = new Function(result);
                  runFn();
                  return { handled: true, output: 'Executed ' + filePath };
              } catch(e) {
                  return { handled: true, output: 'JS Error: ' + e.message };
              }
          } 
          // Pop image rendering inside a responsive OS Window
          else if (lowerPath.endsWith('.png') || lowerPath.endsWith('.jpg') || lowerPath.endsWith('.gif')) {
              var imgSrc = result.startsWith('data:image') ? result : filePath;
              if (global.CylonPopManager && typeof global.CylonPopManager.callPopHtm === 'function') {
                  global.CylonPopManager.callPopHtm('<div style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;background:var(--bg-color,#000);" onclick="hpop()"><img style="max-width:90%;max-height:90%;image-rendering:pixelated;border:2px solid var(--fg-color,#0f0);cursor:pointer;" src="' + imgSrc + '"></div>');
              }
              return { handled: true, output: 'Displayed image ' + filePath };
          }

          // Fallback, display contents
          return { handled: true, output: result };

        case 'copy':
        case 'cp':
          if (args.length < 2) return { handled: true, output: usage('copy <src> <dst> [-k]') };
          result = await dos.copy(args[0], args[1], { keepFlags: !!flags.keep });
          return { handled: true, output: 'Copied to ' + result };

        case 'delete':
        case 'del':
        case 'rm':
          if (!args[0]) return { handled: true, output: usage('delete <file>') };
          await dos.delete(args.join(' '));
          return { handled: true, output: 'File deleted.' };

        case 'rename':
        case 'ren':
        case 'move':
        case 'mv':
          if (args.length < 2) return { handled: true, output: usage('rename <old> <new>') };
          await dos.rename(args[0], args.slice(1).join(' '));
          return { handled: true, output: 'Renamed.' };

        case 'exists':
          if (!args[0]) return { handled: true, output: usage('exists <path>') };
          result = await dos.exists(args.join(' '));
          return { handled: true, output: result ? 'TRUE' : 'FALSE' };

        case 'export':
          var targetDrive = null;
          var fileName = null;

          if (args.length >= 2) {
              targetDrive = args[0];
              fileName = args[1];
          } else if (args.length === 1) {
              fileName = args[0];
          }

          result = await dos.exportDrive(targetDrive);
          
          if (fileName) {
            var blob = new Blob([result], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = fileName;
            anchor.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            return { handled: true, output: 'Drive exported to ' + fileName };
          }
          return { handled: true, output: result };

        case 'import':
          if (!args[0]) return { handled: true, output: usage('import <file> [type] [drive]') };
          var fileArg = args[0];
          var typeArg = args[1];
          var driveArg = args[2];
          
          var rawText = line.replace(/^\s*\S+\s*/, '').trim();
          
          if (fileArg.charAt(0) !== '{') {
            var isFile = false;
            try { isFile = await dos.exists(fileArg); } catch (e) {}
            
            if (isFile) {
                rawText = await dos.load(fileArg);
            } else {
                var res = await fetch(fileArg);
                if (!res.ok) throw new Error('cannot load ' + fileArg + ': HTTP ' + res.status);
                rawText = await res.text();
            }
          }
          
          var targetDrive = null;
          if (typeArg && driveArg && fileArg.charAt(0) !== '{') {
              typeArg = typeArg.toLowerCase();
              if (typeArg === 'idb') {
                  var parts = await dos.partitions();
                  if (!parts.some(function(p) { return p.name === driveArg; })) {
                      await dos.createPartition(driveArg);
                  }
              }
              var mnts = await dos.mounts();
              if (!mnts.some(function(m) { return m.name === driveArg; })) {
                  var mountSource = (typeArg === 'ram') ? 'ram:' : driveArg;
                  await dos.mount(mountSource, driveArg, { type: typeArg });
              }
              targetDrive = driveArg;
          }
          
          await dos.importDrive(rawText, { drive: targetDrive });
          return { handled: true, output: 'Drive imported' + (targetDrive ? ' to ' + targetDrive + ':/' : '.') };

        default:
          return { handled: false };
      }
    } catch (error) {
    	global.CylonLastError = errorText(error);
      return { handled: true, ok: false, output: errorText(error) };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Local application/window manager                                   */
  /* ------------------------------------------------------------------ */

  var openPages = Object.create(null);
  var activePage = null;

  function pageContainer() {
    return document.getElementById('browser-layer-container');
  }

  function pageName(filename) {
    return String(filename || '').replace(/^.*\//, '');
  }

  function pageTitle(filename, title) {
    return title || pageName(filename)
      .replace(/\.(html?|HTML?)$/, '')
      .replace(/[-_]+/g, ' ')
      .toUpperCase();
  }

function updateTaskbar() {
    var taskbar = document.getElementById('taskbar-app-list');
    if (!taskbar) return;

    taskbar.innerHTML = '';

    Object.keys(openPages).forEach(function (filename) {
      var frame = openPages[filename];
      var button = document.createElement('div');

      button.className = 'taskbar-app-tab';
      if (filename === activePage) {
        button.classList.add('active');
      }

      button.textContent = frame.dataset.title;
      
      button.onclick = function (e) {
        if (e) e.stopPropagation(); 
        
        if (filename !== activePage) {
            global.showPage(filename);
        } else {
            if (global.CylonPopManager && typeof global.CylonPopManager.showContextMenu === 'function') {
                global.CylonPopManager.showContextMenu(e, [
                    { label: 'Close ' + frame.dataset.title, action: () => global.PageClose(filename) }
                ]);
            } else {
                global.PageClose(filename);
            }
        }
      };

      taskbar.appendChild(button);
    });
  }  

global.showTerminal = function () {
    var video = document.getElementById('video-layer');
    var container = pageContainer();

    if (video) video.style.display = 'flex';
    if (container) container.style.display = 'none';

    document.body.classList.remove('app-mode');

    Object.keys(openPages).forEach(function (filename) {
      openPages[filename].classList.remove('active');
    });

    activePage = null;

    updateTaskbar();
    if (typeof global.setOSMode === 'function') global.setOSMode('terminal');
  };

  global.showPage = function (filename) {
    var video = document.getElementById('video-layer');
    var container = pageContainer();
    var frame = openPages[filename];

    if (!frame) return;

    if (video) video.style.display = 'none';
    if (container) container.style.display = 'block';

    document.body.classList.add('app-mode');

    activePage = filename;

    Object.keys(openPages).forEach(function (name) {
      var isActive = (name === filename);
      openPages[name].classList.toggle('active', isActive);
      
      if (isActive && openPages[name].contentWindow) {
          openPages[name].contentWindow.postMessage({ type: 'QANDY_PAGE_ACTIVATED' }, '*');
      }
    });
    
    if (typeof global.hideFullKeyboard === 'function') {
      global.hideFullKeyboard();
    }

    updateTaskbar();
    if (typeof global.setOSMode === 'function') global.setOSMode('app');
  };

  global.PageOpen = async function (filename, title) {
    filename = pageName(filename);

    if (!/\.html?$/i.test(filename)) {
      throw new Error('Not an HTML application: ' + filename);
    }

    if (openPages[filename]) {
      global.showPage(filename);
      return;
    }

    if (!global.CylonDOS) {
      throw new Error('CylonDOS is not available');
    }

    var html = await global.CylonDOS.load(filename);

    if (html === null) {
      throw new Error('Application not found on the mounted drive: ' + filename);
    }

    var frame = document.createElement('iframe');

    frame.className = 'page-frame';
    frame.dataset.title = pageTitle(filename, title);
    frame.srcdoc = html;

    pageContainer().appendChild(frame);
    openPages[filename] = frame;

    global.showPage(filename);
  };

  global.PageClose = function (filename) {
    filename = pageName(filename);

    var frame = openPages[filename];
    if (!frame) return;

    frame.remove();
    delete openPages[filename];

    if (activePage === filename) {
      var remaining = Object.keys(openPages);

      if (remaining.length) {
        global.showPage(remaining[remaining.length - 1]);
      } else {
        global.showTerminal();
      }
    } else {
      updateTaskbar();
    }
  };

  global.handleCylonCommand = handleCylonCommand;
  global.parseCylonArgs = parseArgs;

})(typeof window !== 'undefined' ? window : globalThis);


// ============================================================================
// cylon-command.js - Pop Function Compatibility Layer for Cylon OS
// ============================================================================

(function() {
    "use strict";

    const CylonPopManager = {
        activeContext: null,
        pendingPop: null,
        
        init: function() {
            try {
                if (window.parent && window.parent !== window) {
                    if (window.location.pathname.includes('command')) {
                        this.activeContext = 'terminal';
                    } else if (window.location.pathname.includes('desktop')) {
                        this.activeContext = 'desktop';
                    }
                }
            } catch (e) {}

            window.addEventListener('message', (e) => this.handlePopMessage(e));
            this.exposePopFunctions();
        },

        handlePopMessage: function(e) {
            if (!e.data || typeof e.data !== 'object') return;

            const { type } = e.data;

            if (type === 'CYLON_POP_HTM') {
                this.callPopHtm(e.data.html);
            } else if (type === 'CYLON_POP_HIDE') {
                this.callHpop();
            } else if (type === 'CYLON_POP_WEB') {
                this.callPopWeb(e.data.url);
            } else if (type === 'CYLON_POP_WEB_HIDE') {
                this.callHpopWeb();
            } else if (type === 'CYLON_POP_ALIGN') {
                this.setPopAlign(e.data.align);
            }
        },

        callPopHtm: function(html) {
            if (!html) return;
            if (window.parent && window.parent !== window && typeof window.parent.popHtm === 'function' && window.parent.popHtm !== window.popHtm) {
                window.parent.popHtm(html);
            } else {
                this.createSimplePop(html);
            }
        },

        callHpop: function() {
            if (window.parent && window.parent !== window && typeof window.parent.hpop === 'function' && window.parent.hpop !== window.hpop) {
                window.parent.hpop();
            } else {
                const popWrapper = document.getElementById('cylon-pop-wrapper');
                if (popWrapper) popWrapper.style.visibility = 'hidden';
            }
        },

        showContextMenu: function(e, items) {
            this.callHpop(); 

            let absX = e.clientX || 0;
            let absY = e.clientY || 0;

            if (e.view && e.view !== window && e.view !== window.parent) {
                let frames = document.querySelectorAll('iframe');
                for (let i = 0; i < frames.length; i++) {
                    if (frames[i].contentWindow === e.view) {
                        let rect = frames[i].getBoundingClientRect();
                        absX += rect.left;
                        absY += rect.top;
                        break;
                    }
                }
            }

            let wrapper = document.getElementById('cylon-context-wrapper');
            if (!wrapper) {
                wrapper = document.createElement('div');
                wrapper.id = 'cylon-context-wrapper';
                wrapper.style.cssText = `
                    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                    z-index: 100000; cursor: default;
                `;
                wrapper.addEventListener('pointerdown', (ev) => {
                    if (ev.target === wrapper) wrapper.style.display = 'none';
                });
                document.body.appendChild(wrapper);
            }
            wrapper.style.display = 'block';
            wrapper.innerHTML = '';

            let menu = document.createElement('div');
            menu.style.cssText = `
                position: absolute; background: #c0c0c0;
                border-top: 2px solid #fff; border-left: 2px solid #fff;
                border-bottom: 2px solid #555; border-right: 2px solid #555;
                box-shadow: 4px 4px 0px rgba(0,0,0,0.5);
                font-family: sans-serif; font-size: 14px; color: #000;
                min-width: 160px; display: flex; flex-direction: column;
            `;

            items.forEach((item, index) => {
                let btn = document.createElement('div');
                btn.textContent = item.label;
                btn.style.cssText = `
                    padding: 8px 12px; cursor: pointer; user-select: none;
                `;
                if (index < items.length - 1) btn.style.borderBottom = '1px solid #a0a0a0';
                
                btn.onpointerdown = (ev) => {
                    ev.stopPropagation();
                    wrapper.style.display = 'none';
                    if (item.action) item.action();
                };
                
                btn.onmouseenter = () => { btn.style.background = '#000080'; btn.style.color = '#fff'; };
                btn.onmouseleave = () => { btn.style.background = 'transparent'; btn.style.color = '#000'; };

                menu.appendChild(btn);
            });

            wrapper.appendChild(menu);

            menu.style.left = Math.max(0, absX - 12) + 'px';
            menu.style.top = Math.max(0, absY - 8) + 'px';
            
            setTimeout(() => {
               let r = menu.getBoundingClientRect();
               if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 5) + 'px';
               if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 5) + 'px';
            }, 0);
        },

        callPopWeb: function(url) {
            if (!url) return;
            if (window.parent && window.parent !== window && typeof window.parent.popWeb === 'function' && window.parent.popWeb !== window.popWeb) {
                window.parent.popWeb(url);
            } else {
                this.createSimplePopWeb(url);
            }
        },

        callHpopWeb: function() {
            if (window.parent && window.parent !== window && typeof window.parent.hpopWeb === 'function' && window.parent.hpopWeb !== window.hpopWeb) {
                window.parent.hpopWeb();
            } else {
                const webPopWrapper = document.getElementById('cylon-popWeb-wrapper');
                if (webPopWrapper) webPopWrapper.style.visibility = 'hidden';
            }
        },

        setPopAlign: function(align) {
            if (window.parent && window.parent !== window && window.parent.PopAlign !== undefined) {
                window.parent.PopAlign = align;
            } else {
                window.PopAlign = align;
            }
        },

        createSimplePop: function(html) {
            let popWrapper = document.getElementById('cylon-pop-wrapper');
            if (!popWrapper) {
                popWrapper = document.createElement('div');
                popWrapper.id = 'cylon-pop-wrapper';
                popWrapper.style.cssText = `
                    position: fixed;
                    top: 0; left: 0; width: 100vw; height: 100vh;
                    background: rgba(0,0,0,0.6);
                    z-index: 9999;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                `;
                
                popWrapper.addEventListener('click', function(e) {
                    let link = e.target.closest('a');
                    if (link) {
                        let href = link.getAttribute('href');
                        if (href && href.startsWith('gfx:')) {
                            e.preventDefault();
                            let cmd = href.substring(4);
                            let activeFrame = document.querySelector('.page-frame.active');
                            if (activeFrame && activeFrame.contentWindow) {
                                activeFrame.contentWindow.postMessage({ type: 'gfx', cmd: cmd }, '*');
                            } else {
                                window.postMessage({ type: 'gfx', cmd: cmd }, '*');
                            }
                            return; 
                        }
                    }

                    if (e.target === popWrapper) {
                        window.hpop();
                    }
                });

                let popEl = document.createElement('div');
                popEl.id = 'cylon-pop';
                popEl.style.cssText = `
                    background: #eee;
                    color: #000;
                    border: 2px solid #333;
                    border-radius: 4px;
                    padding: 16px;
                    max-width: 90vw;
                    max-height: 90vh;
                    overflow: auto;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                `;
                popWrapper.appendChild(popEl);
                document.body.appendChild(popWrapper);
            }
            
            const popEl = document.getElementById('cylon-pop');
            popEl.innerHTML = html;
            popWrapper.style.visibility = 'visible';
        },

        createSimplePopWeb: function(url) {
            let webPopWrapper = document.getElementById('cylon-popWeb-wrapper');
            if (!webPopWrapper) {
                webPopWrapper = document.createElement('div');
                webPopWrapper.id = 'cylon-popWeb-wrapper';
                webPopWrapper.style.cssText = `
                    position: fixed;
                    top: 0; left: 0; width: 100vw; height: 100vh;
                    background: rgba(0,0,0,0.8);
                    z-index: 9998;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                `;
                
                webPopWrapper.addEventListener('click', function(e) {
                    if (e.target === webPopWrapper) {
                        window.hpopWeb();
                    }
                });

                let webPopEl = document.createElement('div');
                webPopEl.id = 'cylon-popWeb';
                webPopEl.style.cssText = `
                    width: 800px;
                    height: 600px;
                    max-width: 95vw;
                    max-height: 95vh;
                    background: white;
                    border: 2px solid #333;
                    border-radius: 4px;
                    overflow: hidden;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                `;
                webPopWrapper.appendChild(webPopEl);
                document.body.appendChild(webPopWrapper);
            }
            const webPopEl = document.getElementById('cylon-popWeb');
            webPopEl.innerHTML = `<iframe src="${url}" style="width:100%; height:100%; border:none;"></iframe>`;
            webPopWrapper.style.visibility = 'visible';
        },

        exposePopFunctions: function() {
            const self = this;
            window.popHtm = function(html) { self.callPopHtm(html); };
            window.hpop = function() { self.callHpop(); };
            window.popWeb = function(url) { self.callPopWeb(url); };
            window.hpopWeb = function() { self.callHpopWeb(); };
            window.setPopAlign = function(align) { self.setPopAlign(align); };
            window.pop = window.popHtm;
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            CylonPopManager.init();
        });
    } else {
        CylonPopManager.init();
    }

    window.CylonPopManager = CylonPopManager;

})();
