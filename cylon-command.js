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
    l: 'list', k: 'keep', keep: 'keep'
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

  // Separates -x / --flag tokens from positional arguments.
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
    return 'Error: ' + (error && error.message ? error.message : String(error));
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
    '  load <file>                    Display a file',
    '  copy <src> <dst>               Copy a file or directory (across drives too)',
    '  rename <old> <new>             Rename or move within a drive',
    '  delete <file>                  Delete a file',
    '  exists <path>                  Test whether a path exists',
    '  export [filename]              Export the current drive as JSON',
    '  import <json|url>              Import a JSON archive into the current drive',
    '  install                        Install LiveCD to IndexedDB (creates "cylon" drive)',
    '  cls                            Clear the terminal screen',
    '  help [command]                 Show help (e.g. "help mount" or "help fdisk")\n'
  ].join('\n');

  var HELP_MOUNT = [
    'Mount Command Help:\n',
    '  mount                          Show the mount table',
    '  mount <source> [name] [-r]     Mount a device. Sources:',
    '                                   main, idb0p1     an IndexedDB partition',
    '                                   rom:<url|.json>  a read-only JSON image (LiveCD)',
    '                                   ram:[url|.json]  volatile RAM drive  (-s <size>)',
    '                                   ls:<name>        localStorage drive  (-s <size>)\n'
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
      var rows = [['Device', 'Label', 'Size', 'Used', 'Entries', 'Boot', 'Mounted']];
      
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
    var name = await dos.mount(args[0], args[1], options);
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

    if (!command) return { handled: true, output: '' };

    try {
      // "live:" on its own switches the current drive, like DOS.
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

        case 'mountrom': // legacy: mountrom <drive> [url]
          if (!args[0]) return { handled: true, output: usage('mountrom <drive> [url]') };
          var romOptions = { readOnly: true };
          var romRaw = line.replace(/^\s*\S+\s+\S+\s*/, '');
          if (/^\{/.test(romRaw)) romOptions.data = romRaw;
          await dos.mount('rom:' + (args[1] || args[0] + '.json'), args[0], romOptions);
          return { handled: true, output: 'ROM Mounted: ' + args[0] + ':/ (Read-Only)' };

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

        case 'install':
          // We are officially allowed to touch IDB now
          var parts = await dos.partitions(); 
          var cylonPart = parts.filter(function(p) { return p.name === 'cylon'; })[0];

          if (cylonPart) {
            // Unmount if it's currently mounted so we can format it cleanly
            try { await dos.umount('cylon'); } catch (e) {}
            await dos.formatPartition('cylon');
          } else {
            // Create the primary partition
            await dos.createPartition('cylon', dos.constants.DEFAULT_QUOTA);
          }

          // Mark it as the boot drive and mount it
          await dos.setBootPartition('cylon');
          await dos.mount('cylon');

          // Fetch the JSON and unpack it onto the new drive
          try {
            var res = await fetch('cylon.json');
            if (res.ok) {
              var jsonText = await res.text();
              await dos.importDrive(jsonText, { drive: 'cylon' });
              return { handled: true, output: 'Installation complete! System copied to "cylon:". Type "cylon:" to switch drives.' };
            } else {
              return { handled: true, output: 'Partition created, but cylon.json could not be loaded (HTTP ' + res.status + ').' };
            }
          } catch (e) {
            return { handled: true, output: 'Partition "cylon:" created, but failed to load cylon.json: ' + (e.message || e) };
          }

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

        case 'save':
        case 'write':
          if (args.length < 2) return { handled: true, output: usage('save <file> <text>') };
          await dos.save(args[0], args.slice(1).join(' '));
          return { handled: true, output: 'File saved.' };

        case 'load':
        case 'type':
          if (!args[0]) return { handled: true, output: usage('load <file>') };
          result = await dos.load(args.join(' '));
          return { handled: true, output: result === null ? 'File not found.' : result };

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
        case 'backup':
          result = await dos.exportDrive();
          if (args[0]) {
            var blob = new Blob([result], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = args[0];
            anchor.click();
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
            return { handled: true, output: 'Drive exported to ' + args[0] };
          }
          return { handled: true, output: result };

        case 'import':
          if (!args[0]) return { handled: true, output: usage('import <json|url>') };
          // Use the raw text: tokenizing would strip the quotes out of inline JSON.
          result = line.replace(/^\s*\S+\s*/, '').trim();
          if (result.charAt(0) !== '{') {
            var res = await fetch(result);
            if (!res.ok) throw new Error('cannot load ' + result + ': HTTP ' + res.status);
            result = await res.text();
          }
          await dos.importDrive(result);
          return { handled: true, output: 'Drive imported.' };

        default:
          return { handled: false };
      }
    } catch (error) {
      return { handled: true, output: errorText(error) };
    }
  }

  global.handleCylonCommand = handleCylonCommand;
  global.parseCylonArgs = parseArgs;
})(typeof window !== 'undefined' ? window : globalThis);