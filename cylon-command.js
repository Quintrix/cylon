/*
 * Cylon terminal command layer.
 *
 * This file intentionally contains no IndexedDB code. It translates terminal
 * commands into calls to CylonDOS, keeping the command UI separate from the
 * filesystem backend.
 */
(function (global) {
  'use strict';

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

  function output(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  function errorText(error) {
    return 'Error: ' + (error && error.message ? error.message : String(error));
  }

  function usage(text) {
    return 'Usage: ' + text;
  }

  async function handleCylonCommand(line) {
    if (!global.CylonDOS) return { handled: false };

    var tokens = parseArgs(line);
    var command = (tokens.shift() || '').toLowerCase();
    var args = tokens;
    var dos = global.CylonDOS;
    var result;

    if (!command) return { handled: true, output: '' };

    try {
      switch (command) {
        case 'help':
          return {
            handled: true,
            output: [
              'Cylon DOS commands:',
              '  mount <drive>              Mount or create an IndexedDB drive',
              '  dir [path]                 Detailed directory listing',
              '  ls [path]                  List names in a directory',
              '  cd [path]                  Change directory',
              '  mkdir <path>               Create a directory',
              '  rmdir <path>               Remove an empty directory',
              '  save <file> <text>         Save text to a file',
              '  load <file>                Display a file',
              '  delete <file>              Delete a file',
              '  rename <old> <new>         Rename a file',
              '  exists <path>              Test whether a path exists',
              '  export [filename]          Export the mounted drive as JSON',
              '  import <json>              Import a JSON archive',
              '  pwd                        Show the current directory',
              '  doshelp                    Show this help'
            ].join('\n')
          };

        case 'doshelp':
          return handleCylonCommand('help');

        case 'mount':
          if (!args[0]) return { handled: true, output: usage('mount <drive>') };
          result = await dos.mount(args[0]);
          return { handled: true, output: 'Mounted: ' + result + '/\n' };

        case 'pwd':
          return { handled: true, output: (dos.mountedDrive ? dos.mountedDrive + ':' : '(no drive)') + dos.cwd };

        case 'dir':
          result = await dos.dir(args[0]);
          return { handled: true, output: result.map(function (entry) {
            var name = entry.type === 'directory' ? entry.name + '/' : entry.name;
            return name + '  ' + entry.size + ' bytes  ' + (entry.timestamp || '');
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
          if (!args[0]) return { handled: true, output: usage('save <file> <text>') };
          if (args.length < 2) return { handled: true, output: usage('save <file> <text>') };
          await dos.save(args[0], args.slice(1).join(' '));
          return { handled: true, output: 'File saved.' };

        case 'load':
        case 'type':
          if (!args[0]) return { handled: true, output: usage('load <file>') };
          result = await dos.load(args.join(' '));
          return { handled: true, output: result === null ? 'File not found.' : result };

        case 'delete':
        case 'del':
        case 'rm':
          if (!args[0]) return { handled: true, output: usage('delete <file>') };
          await dos.delete(args.join(' '));
          return { handled: true, output: 'File deleted.' };

        case 'rename':
        case 'ren':
          if (args.length < 2) return { handled: true, output: usage('rename <old> <new>') };
          await dos.rename(args[0], args.slice(1).join(' '));
          return { handled: true, output: 'File renamed.' };

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
          if (!args[0]) return { handled: true, output: usage('import <json>') };
          result = args.join(' ');
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
