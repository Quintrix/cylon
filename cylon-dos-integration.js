/*
 * Cylon terminal integration.
 *
 * Load this file after cylon-dos.js and cylon-command.js. It installs the
 * IndexedDB command path without changing the legacy Qandy command layer.
 */
(function (global) {
  'use strict';

  var previousCommand = typeof global.command === 'function' ? global.command : null;
  var defaultDrive = 'main';
  var initialized = false;

  function write(text) {
    if (typeof global.print === 'function') {
      global.print(String(text == null ? '' : text).replace(/\n/g, '<br>'));
    } else if (global.console) {
      global.console.log(text);
    }
  }

  function errorText(error) {
    return 'Error: ' + (error && error.message ? error.message : String(error));
  }

  async function initialize() {
    if (initialized) return;
    if (!global.CylonDOS) throw new Error('CylonDOS is not loaded');
    await global.CylonDOS.ready();
    await global.CylonDOS.mount(defaultDrive);
    initialized = true;
  }

  async function run(commandLine) {
    await initialize();
    var result = await global.handleCylonCommand(commandLine);
    if (result && result.handled) {
      write(result.output || '');
      return true;
    }
    return false;
  }

  global.cylonDOSInitialize = initialize;
  global.cylonDOSCommand = run;

  // Install only once. The original command remains available for app names,
  // JavaScript evaluation, and other non-DOS commands.
  if (!global.__cylonDOSCommandInstalled) {
    global.__cylonDOSCommandInstalled = true;
    global.command = async function (commandLine) {
      var line = String(commandLine || '').trim();
      if (!line) return;

      try {
        var handled = await run(line);
        if (handled) return;
      } catch (error) {
        write(errorText(error));
        return;
      }

      if (previousCommand) return previousCommand(commandLine);
      write('Unknown command: ' + line);
    };
  }

  // Start IndexedDB initialization after the page has loaded. A drive is
  // created automatically on first mount, so first boot requires no setup.
  function boot() {
    initialize().catch(function (error) {
      write(errorText(error));
    });
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
