/*
 * Cylon update command.
 *
 * This is layered over the normal command handler so the storage and command
 * implementations remain separate. An explicit file is fetched directly;
 * wildcard patterns update files already present in the current directory.
 */
(function (global) {
  'use strict';

  var previousHandler = global.handleCylonCommand;
  if (typeof previousHandler !== 'function') return;

  function usage() {
    return 'Usage: update <file|pattern> [destination]\n' +
      '  update file.htm              Fetch and replace file.htm\n' +
      '  update file.htm copy.htm     Fetch file.htm as copy.htm\n' +
      '  update *                     Update all files in the current directory\n' +
      '  update gfx*                  Update files beginning with gfx';
  }

  function hasWildcard(value) {
    return /[*?]/.test(value);
  }

  function wildcardRegExp(pattern) {
    var source = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp('^' + source + '$', 'i');
  }

  function baseName(path) {
    path = String(path || '').replace(/\\/g, '/');
    var slash = path.lastIndexOf('/');
    return slash < 0 ? path : path.substring(slash + 1);
  }

  function joinPath(directory, name) {
    directory = String(directory || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return directory ? directory + '/' + name : name;
  }

  function destinationPath(destination, source, wildcard) {
    if (!destination) return source;
    if (wildcard || /\/$/.test(destination)) return joinPath(destination, baseName(source));
    return destination;
  }

  async function fetchText(file) {
    var url;
    try {
      url = new URL(file, global.location && global.location.href ? global.location.href : undefined).href;
    } catch (error) {
      throw new Error('invalid source: ' + file);
    }
    var response;
    try {
      response = await global.fetch(url, { cache: 'no-store' });
    } catch (error) {
      throw new Error('cannot load ' + file + ': ' + (error.message || error));
    }
    if (!response.ok) throw new Error('cannot load ' + file + ': HTTP ' + response.status);
    return response.text();
  }

  async function updateCommand(dos, args) {
    if (!args[0] || args.length > 2) return usage();

    var source = args[0];
    var wildcard = hasWildcard(source);
    var files;

    if (wildcard) {
      if (args[1] && !args[1].endsWith('/')) {
        return 'For wildcard updates, destination must be a directory: update ' + source + ' <directory>/';
      }
      var entries = await dos.dir();
      var matcher = wildcardRegExp(baseName(source));
      files = entries.filter(function (entry) {
        return entry.type === 'file' && matcher.test(baseName(entry.name));
      }).map(function (entry) { return baseName(entry.name); });
      if (!files.length) return 'No files matched: ' + source;
    } else {
      files = [source];
    }

    var destination = args[1] || '';
    var output = ['Updating ' + files.length + ' file' + (files.length === 1 ? '' : 's') +
      ' to ' + dos.pwd()];
    var succeeded = 0;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var target = destinationPath(destination, file, wildcard);
      try {
        var content = await fetchText(file);
        await dos.save(target, content);
        succeeded++;
        output.push('  ' + file + '  OK (' + content.length + ' characters)');
      } catch (error) {
        output.push('  ' + file + '  FAILED: ' + (error.message || error));
      }
    }

    output.push('Updated ' + succeeded + ' of ' + files.length + ' file' + (files.length === 1 ? '.' : 's.'));
    return output.join('\n');
  }

  global.handleCylonCommand = async function (line) {
    var tokens = String(line || '').trim().split(/\s+/);
    if (tokens[0] && tokens[0].toLowerCase() === 'update') {
      var dos = global.CylonDOS;
      if (!dos) return { handled: true, output: 'Error: CylonDOS is not available.' };
      try {
        return { handled: true, output: await updateCommand(dos, tokens.slice(1)) };
      } catch (error) {
        return { handled: true, output: 'Error: ' + (error.message || error) };
      }
    }
    return previousHandler(line);
  };
})(typeof window !== 'undefined' ? window : globalThis);
