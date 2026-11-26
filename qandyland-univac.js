'use strict';

//
// ──── UNIVAC – Qandyland Punch Card Processor ────────────────────────────────
//
// UNIVAC(driveName, itemfile, objfile)
//
//   driveName – the drive the world lives on (e.g. 'capflag.gfx')
//   itemfile  – full canonical path to the player-item file being processed
//               e.g. 'w/F2/Sa25B1D3J0'
//               filename anatomy: [team][slot][z-padded-2][avatar-string]
//   objfile   – full canonical path to the static object file whose punch code
//               will be run against the item
//               e.g. 'w/F2/Yj44sa'
//               filename anatomy: [obj-id-2][z-padded-2][data-2]
//               file content: punch code string, e.g. 'VtA1' or '[log]'
//

// ── Dependency injection ──────────────────────────────────────────────────────

var _deps = null;

function inject(deps) {
  _deps = deps;
}

// ── Qandy Punch Code (QPC) Tag Validation & Loader ────────────────────────────

var VALID_QPC_TAG_RE = /^[a-z0-9]{3,}$/;

function loadPunchCode(driveName, objfile) {
  var raw = '';
  if (objfile && objfile.substring(0, 4) === 'RAM:') {
    raw = objfile.substring(4);
  } else {
    var objLoad = _deps.fileLoad(driveName, '/', objfile, 'UNIVAC');
    if (!objLoad.success || !objLoad.content) {
      return null;
    }
    raw = objLoad.content;
  }

  // Single-pass expansion of [tag] macros from /q/<tag>.
  // Tags must be >= 3 chars and contain only lowercase letters and numerals.
  var expanded = String(raw).replace(/\[([^\]]*)\]/g, function (fullMatch, tagName) {
    if (!VALID_QPC_TAG_RE.test(tagName)) {
      return '';
    }
    var tagLoad = _deps.fileLoad(driveName, '/', 'q/' + tagName, 'UNIVAC');
    if (tagLoad && tagLoad.success && tagLoad.content) {
      return tagLoad.content;
    }
    return '';
  });

  // Strip whitespace and line markers so UNIVAC only sees packed 2-char opcodes
  return expanded
    .replace(/_NL_/g, '')
    .replace(/\\n|\\r/g, '')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, '');
}

// ── Z-Coordinate Engine Encoders ──────────────────────────────────────────────

const QANDY_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const QANDY_LOWER = "abcdefghijklmnopqrstuvwxyz";
const QANDY_SYM   = "0123456789_()[]{}^,:;+-=%@";

function encodeZ(z, base) {
  if (base === 52) {
    if (z < 0 || z >= 1352) return "Aa";
    if (z < 676) {
      return QANDY_UPPER[Math.floor(z / 26)] + QANDY_LOWER[z % 26];
    } else {
      var z2 = z - 676;
      return QANDY_UPPER[Math.floor(z2 / 26)] + QANDY_SYM[z2 % 26];
    }
  }
  return z.toString(base).toUpperCase().padStart(2, '0');
}

function decodeZ(zStr, base) {
  if (base === 52) {
    if (!zStr || zStr.length !== 2) return 0;
    var first = QANDY_UPPER.indexOf(zStr.charAt(0));
    if (first === -1) return 0;

    var secondLower = QANDY_LOWER.indexOf(zStr.charAt(1));
    if (secondLower !== -1) return (first * 26) + secondLower;

    var secondSym = QANDY_SYM.indexOf(zStr.charAt(1));
    if (secondSym !== -1) return 676 + (first * 26) + secondSym;

    return 0;
  }
  var val = parseInt(zStr, base);
  return isNaN(val) ? 0 : val;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _parseItemPath(itemfile, zBase) {
  if (!itemfile) return null;

  var p = itemfile.replace(/^\//, '');
  var parts = p.split('/');
  if (parts.length < 3 || parts[0] !== 'w') return null;

  var sector   = parts[1];
  var filename = parts[2];

  if (filename.length < 4) return null;

  var base = zBase || 10;

  var id   = filename.substring(0, 2);
  var zRaw = filename.substring(2, 4);

  if (base === 52) {
    if (encodeZ(decodeZ(zRaw, 52), 52) !== zRaw) return null;
  } else if (isNaN(parseInt(zRaw, base))) {
    return null;
  }

  var z    = decodeZ(zRaw, base);
  var zStr = encodeZ(z, base);

  var playerid = '';
  var avatar = '';

  if (id >= 'Sa' && id < 'Ua' && filename.length >= 8) {
    playerid = filename.substring(4, 8);
    avatar = filename.substring(8);
  } else {
    avatar = filename.length > 4 ? filename.substring(4) : '';
  }

  return { sector: sector, filename: filename, id: id, z: z, zStr: zStr, playerid: playerid, avatar: avatar };
}

function _parseObjPath(objfile, zBase) {
  if (!objfile || objfile.substring(0, 4) === 'RAM:') return null;
  var p = objfile.replace(/^\//, '');
  var parts = p.split('/');
  if (parts.length < 3 || parts[0] !== 'w') return null;
  var filename = parts[2];
  if (filename.length < 4) return null;
  return {
    sector: parts[1],
    id: filename.substring(0, 2),
    zStr: filename.substring(2, 4),
    data: filename.length >= 6 ? filename.substring(4, 6) : 'Za'
  };
}

function _isValidExit(driveName, currentSector, targetSector) {
  var eLoad = _deps.fileLoad(driveName, '/', 'w/' + currentSector + '/e', 'UNIVAC');
  if (!eLoad.success) return true;
  if (!eLoad.content) return false;
  return eLoad.content.indexOf(targetSector) > -1;
}

var _CITY_CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789_()[]{}^,:;+-=%@";

function _cityCharFromWorld(worldChar) {
  var idx = _CITY_CHARSET.indexOf(worldChar);
  if (idx < 0 || idx > 25) return null;
  return _CITY_CHARSET.charAt(idx + 26);
}

function _worldCharFromCity(cityChar) {
  var idx = _CITY_CHARSET.indexOf(cityChar);
  if (idx < 26) return null;
  return _CITY_CHARSET.charAt(idx - 26);
}

function _isCitySector(sector) {
  if (!sector || sector.length < 2) return false;
  return _CITY_CHARSET.indexOf(sector.charAt(1)) >= 26;
}

function _updatePFile(driveName, id, newSector, zStr, avatar) {
  _deps.fileSave(driveName, '/', 'p/' + id, newSector + zStr + avatar, 'UNIVAC', 'UNIVAC');
}

function _canWalkTerrain(tileCode, inv) {
  if (!tileCode || tileCode.length < 2) return false;
  var t = tileCode.charAt(0);

  if (t >= 'A' && t <= 'K') return true;

  var has = function(item) { return inv.indexOf(item) !== -1; };
  var master = has('Aa');

  switch (t) {
    case 'M': return master || has('Ae');
    case 'R': return master || has('Ab');
    case 'S': return master || has('Ad') || has('Ae');
    case 'T': return master || has('Ac');
    default:  return false;
  }
}

function _getMoveCost(w5Value, tileCode) {
  if (!tileCode || tileCode.length < 2) return 1;
  var t = tileCode.charAt(0);

  var tier = 0;
  if (t === 'R' || t === 'T') tier = 1;
  if (t === 'S' || t === 'M') tier = 2;

  switch (w5Value) {
    case 'Ab':
      return (tier === 0) ? 0 : 1;
    case 'Ac':
      return (tier >= 1) ? 2 : 1;
    case 'Ad':
    case 'Ae':
      if (tier >= 2) return 3;
      if (tier === 1) return 2;
      return 1;
    case 'Aa':
      return 1;
    default:
      return 1;
  }
}


// ── UNIVAC ────────────────────────────────────────────────────────────────────
function UNIVAC(driveName, itemfile, objfile, sessionToken, options) {
  sessionToken = sessionToken || 'UNIVAC';

  if (!_deps) {
    console.error('UNIVAC: dependencies not injected – call UNIVAC.inject(deps) at startup');
    return;
  }

  var zBase = 10;
  var baseLoad = _deps.fileLoad(driveName, '/', 'a/gfxZBase', 'UNIVAC');
  if (baseLoad.success && baseLoad.content) {
    var b = parseInt(baseLoad.content, 10);
    if (!isNaN(b) && ((b >= 2 && b <= 36) || b === 52)) zBase = b;
  }

  var driveReg = getDriveRegisters(driveName);
  var register = Object.create(driveReg);

  // ── 1. Parse the item file path ───────────────────────────────────────────
  var parsedItem = null;
  var content = '';
  var oldPath = itemfile || null;

  if (itemfile) {
    parsedItem = _parseItemPath(itemfile, zBase);
    var itemLoad = _deps.fileLoad(driveName, '/', itemfile, 'UNIVAC');
    if (!itemLoad.success) {
      console.error('UNIVAC: cannot load item file: ' + itemfile);
      return;
    }
    content = itemLoad.content;
  }

  var _userRegMatches = content.match(/W[a-z][0-9A-Za-z][0-9A-Za-z_()[\]{}^,:;+\-=%@]/g) || [];
  _userRegMatches.forEach(function(m) {
    register[m.substring(0, 2)] = m.substring(2, 4);
  });

  register['W@'] = (options && options.opt != null && String(options.opt).length >= 2)
    ? String(options.opt).substring(0, 2)
    : '00';

  var state = {
    id       : parsedItem ? parsedItem.id       : 'Za',
    sector   : parsedItem ? parsedItem.sector   : 'A1',
    z        : parsedItem ? parsedItem.z        : 0,
    zStr     : parsedItem ? parsedItem.zStr     : encodeZ(0, zBase),
    avatar   : parsedItem ? parsedItem.avatar   : '',
    playerid : parsedItem ? parsedItem.playerid : '',
    content  : content || ''
  };

  var originalId       = state.id;
  var originalPlayerId = state.playerid;

  var playerStatus = (options && options.playerStatus)
    ? String(options.playerStatus).toLowerCase()
    : 'player';

  // ── 2. Load the object's punch code (resolving /q/[tag] & whitespace) ─────
  var tape = loadPunchCode(driveName, objfile);
  if (tape === null) {
    console.error('UNIVAC: cannot load object file: ' + driveName + objfile);
    return;
  }
  if (!tape) return;

  var column = 0;
  var output = "";

  // ── Helpers ───────────────────────────────────────────────────────────────

  function findItemZ(sectorCode, token) {
    if (typeof _deps.fileList === 'function') {
      var listRes = _deps.fileList(driveName, 'w/' + sectorCode, null, 'UNIVAC');
      if (listRes && listRes.success && listRes.listing) {
        var paddedList = ' ' + listRes.listing;
        var searchToken = ' ' + token;
        var idx = paddedList.indexOf(searchToken);
        if (idx !== -1) {
          var zStart = idx + searchToken.length;
          return paddedList.substring(zStart, zStart + 2);
        }
      }
    }
    return null;
  }

  function findCityExitZ(sectorCode) {
    if (typeof _deps.fileList === 'function') {
      var listRes = _deps.fileList(driveName, 'w/' + sectorCode, null, 'UNIVAC');
      if (listRes && listRes.success && listRes.listing) {
        var files = listRes.listing.trim().split(/\s+/);
        for (var i = 0; i < files.length; i++) {
          var fname = files[i];
          if (fname.length !== 6) continue;

          // Ignore runtime markers (Vx, Vy, Xz, Xt, Vb, etc.)
          var prefix = fname.charAt(0);
          if (prefix === 'V' || prefix === 'X') continue;

          var data = fname.substring(4, 6);
          if (data !== 'Za' && /^[0-9A-Za-z_()[\]{}^,:;+\-=%@]{2}$/.test(data)) {
            return data;
          }
        }
      }
    }
    return null;
  }

  function getRegValue(valStr) {
    if (!valStr || valStr.length !== 2) return 0;
    if (valStr.charAt(0) === 'W') {
      return resolveToValue(register[valStr] || "00");
    }
    return resolveToValue(valStr);
  }

  function resolveToValue(str) {
    if (/^\d{2}$/.test(str)) {
      return parseInt(str, 10);
    }
    return (str.charCodeAt(0) * 100) + str.charCodeAt(1);
  }

  function resolveZToken(token) {
    var str = (token.charAt(0) === 'W') ? (register[token] || "00") : token;
    return decodeZ(str, zBase);
  }

  var _mapCache = {};
  function getTileAt(sec, zIdx) {
    if (zIdx < 0) return 'Ga';
    if (!_mapCache[sec]) {
      var mLoad = _deps.fileLoad(driveName, '/', 'w/' + sec + '/m', 'UNIVAC');
      _mapCache[sec] = (mLoad.success && mLoad.content) ? mLoad.content : null;
    }
    var data = _mapCache[sec];
    if (!data) return 'Ga';
    var charIdx = zIdx * 2;
    if (charIdx + 2 > data.length) return 'Ga';
    return data.substring(charIdx, charIdx + 2);
  }

  // ── 3. Process punch code ─────────────────────────────────────────────────

  var switchopen = false;
  var ifnot = false;
  var linkOpt = null;

  while (column < tape.length) {
    var word = tape.slice(column, column + 2);
    column += 2;

    switch (word) {
      case 'Xn':
        ifnot = true;
        break;

      case 'Xc':
        ifnot = false;
        switchopen = false;
        linkOpt = null;
        break;

      case 'Xa': {
        var newId = tape.slice(column, column + 2); column += 2;
        var inventoryString = "";
        var endCol = tape.indexOf('--', column);
        if (endCol !== -1) {
          inventoryString = tape.slice(column, endCol);
          column = endCol + 2;
        } else {
          inventoryString = tape.slice(column);
          column = tape.length;
        }

        if (!switchopen) {
          var appliedXa = false;
          if (!state.playerid) {
            state.id = newId;
            loadconfig(driveName);
            state.playerid = tickOdometer(driveName);

            var spawnSecLoad = _deps.fileLoad(driveName, '/', 'a/gfxSpawn', 'UNIVAC');
            if (spawnSecLoad.success && spawnSecLoad.content && spawnSecLoad.content.trim().length === 2) {
              state.sector = spawnSecLoad.content.trim();
            } else { 
              state.sector = register['Aa'];
            }

            var spawnZLoad = _deps.fileLoad(driveName, '/', 'a/gfxSpawnZ', 'UNIVAC');
            if (spawnZLoad.success && spawnZLoad.content) {
              state.z = decodeZ(spawnZLoad.content.trim(), zBase);
              state.zStr = encodeZ(state.z, zBase);
            } else {
              state.z = decodeZ(0, zBase);
              state.zStr = encodeZ(state.z, zBase);
            }

            state.avatar = '';
            state.content = inventoryString;
            appliedXa = true;
          } else if (state.id === 'Za') {
            state.id = newId;
            state.avatar = '';
            state.content = inventoryString;
            output += "S^Va--^S";
            appliedXa = true;
          }

          if (appliedXa) {
            state.content = state.content.replace(/(W[a-z])([0-9A-Za-z][0-9A-Za-z_()[\]{}^,:;+\-=%@])?/g, function(match, rk, val) {
              if (val) {
                register[rk] = val;
                return match;
              } else {
                register[rk] = '01';
                return rk + '01';
              }
            });
          }
        }
        break;
      }

      case 'Va': {
        var avatarStr = "";
        var endCol = tape.indexOf('--', column);
        if (endCol !== -1) {
          avatarStr = tape.slice(column, endCol);
          column = endCol + 2;
        } else {
          avatarStr = tape.slice(column, column + 2);
          column += 2;
        }

        if (!switchopen && state.playerid && /^[ABEF][0-9][CDGH][0-9]$/.test(avatarStr)) {
          state.avatar = avatarStr;          
        }
        break;
      }

      case 'Vu': {
        var noun = tape.slice(column, column + 2); column += 2;
        if (!switchopen && state.playerid && /^[LMN][a-z0-9_()[\]{}^,:;+\-=%@]$/.test(noun)) {
          if (state.content.indexOf(noun) > -1) {
            var re = new RegExp(noun.charAt(0) + '.');
            if (state.avatar.indexOf(noun) > -1) {
              state.avatar = state.avatar.replace(noun, '');
            } else if (re.test(state.avatar)) {
              state.avatar = state.avatar.replace(re, noun);
            } else {
              state.avatar += noun;
            }
          }
        }
        break;
      }

      case 'Xi': {
        var noun = tape.slice(column, column + 2); column += 2;
        var ifinv = false;
        if (state.content.indexOf(noun) === -1) { ifinv = true; }
        if (ifnot) ifinv = !ifinv;
        if (ifinv) { switchopen = true; }
        ifnot = false;
        break;
      }

      case 'Xg': {
        var isGuest = (playerStatus === 'guest');
        if (ifnot) isGuest = !isGuest;
        if (!isGuest) { switchopen = true; }
        ifnot = false;
        break;
      }

      case 'Vg': {
        if (!switchopen) {
          output += "S^Vg^S";
        }
        ifnot = false;
        break;
      }

      case 'Xs': {
        var regKey = tape.slice(column, column + 2); column += 2;
        var val = tape.slice(column, column + 2); column += 2;
        if (!switchopen && /^W[a-z@]$/.test(regKey)) {
          register[regKey] = (val.charAt(0) === 'W') ? (register[val] || "00") : val;
        }
        break;
      }

      case 'Xd': {
        var value1 = tape.slice(column, column + 2); column += 2;
        var target = value1;
        var value2 = tape.slice(column, column + 2); column += 2;

        if (!switchopen && target.charAt(0) === "W") {
          var v1 = parseInt(getRegValue(value1), 10);
          var v2 = parseInt(getRegValue(value2), 10);
          var min = Math.min(v1, v2);
          var max = Math.max(v1, v2);
          var roll = Math.floor(Math.random() * (max - min + 1)) + min;
          if (roll < 0) roll = 0;
          if (roll > 99) roll = 99;
          register[target] = roll.toString().padStart(2, '0');
        }
        break;
      }

      case 'Xm': {
        var value1 = tape.slice(column, column + 2); column += 2;
        var target = value1;
        var value2 = tape.slice(column, column + 2); column += 2;

        if (!switchopen && target.charAt(0) === "W") {
          var v1 = parseInt(getRegValue(value1), 10);
          var v2 = parseInt(getRegValue(value2), 10);
          if (ifnot) {
            var result = v1 - v2;
            if (result < 0) { result = 0; }
          } else {
            var result = v1 + v2;
            if (result > 99) { result = 99; }
          }
          register[target] = result.toString().padStart(2, '0');
        }
        ifnot = false;
        break;
      }

      case 'Xl': {
        var value1 = tape.slice(column, column + 2); column += 2;
        var value2 = tape.slice(column, column + 2); column += 2;
        var v1 = getRegValue(value1);
        var v2 = getRegValue(value2);

        var result = (v1 < v2);
        if (ifnot) result = !result;
        if (!result) { switchopen = true; }
        ifnot = false;
        break;
      }

      case 'Xe': {
        var value1 = tape.slice(column, column + 2); column += 2;
        var value2 = tape.slice(column, column + 2); column += 2;
        var v1 = getRegValue(value1);
        var v2 = getRegValue(value2);
        var result = (v1 == v2);
        if (ifnot) result = !result;
        if (!result) { switchopen = true; }
        ifnot = false;
        break;
      }

      case 'Xh': {
        var xhOpt = tape.slice(column, column + 2); column += 2;
        if (!switchopen) {
          linkOpt = (xhOpt.charAt(0) === 'W') ? (register[xhOpt] || '00') : xhOpt;
        }
        break;
      }

      case 'Vh': {
        var textStr = "";
        var endCol = tape.indexOf('--', column);
        if (endCol !== -1) {
          textStr = tape.slice(column, endCol);
          column = endCol + 2;
        } else {
          textStr = tape.slice(column);
          column = tape.length;
        }

        if (!switchopen && (endCol !== -1 || textStr)) {
          if (linkOpt !== null) {
            var objMeta = _parseObjPath(objfile, zBase);
            var targetId = objMeta ? objMeta.id : state.id;
            var targetZ  = objMeta ? objMeta.zStr : state.zStr;
            output += "S^Xh" + targetId + targetZ + linkOpt + textStr + "--^S";
            linkOpt = null;
          } else {
            output += "S^Vh" + textStr + "--^S";
          }
        } else {
          linkOpt = null;
        }
        ifnot = false;
        break;
      }

      case 'Vi': {
        if (!switchopen) {
          var cleanInv = state.content.replace(/\s+/g, '');
          output += "S^Vi" + cleanInv + "--^S";
        }
        break;
      }

      case 'Vh': {
        var textStr = "";
        var endCol = tape.indexOf('--', column);
        if (endCol !== -1) {
          textStr = tape.slice(column, endCol);
          column = endCol + 2;
        } else {
          textStr = tape.slice(column);
          column = tape.length;
        }

        if (!switchopen && textStr) {
          output += "Vh" + textStr + "--";
        }
        ifnot = false;
        break;
      }

      case 'Vp': {
        var noun = tape.slice(column, column + 2); column += 2;
        if (!switchopen) {
          if (noun.charAt(0) === 'W') {
            state.avatar += '-' + register[noun];
          } else {
            state.avatar += '-' + noun;
          }
        }
        break;
      }

      case 'Xr': {
        var noun1 = tape.slice(column, column + 2); column += 2;
        var noun2 = tape.slice(column, column + 2); column += 2;
        if (!switchopen) {
          state.content = state.content.replace(noun1, noun2);
        }
        break;
      }

      case 'Vm': {
        var noun = tape.slice(column, column + 2); column += 2;

        if (!switchopen) {
          var resolvedZ = state.zStr;
          var targetPath = 'w/' + state.sector + '/' + noun + resolvedZ;

          if (ifnot) {
            _deps.fileDelete(driveName, '/', targetPath, sessionToken);
          } else {
            let ts = 'X' + _deps.futureTimestamp(1);
            _deps.fileSave(driveName, '/', targetPath, '', sessionToken, sessionToken, ts);
          }
        }
        break;
      }

      case 'Vr': {
        var noun = tape.slice(column, column + 2); column += 2;
        if (!switchopen) {
          output += "S^Vr" + noun + state.zStr + "^S";
        }
        break;
      }

      case 'Vd': {
        var noun = tape.slice(column, column + 2); column += 2;
        if (!switchopen) {
          if (ifnot) {
            if (state.content.indexOf('Za') > -1) {
              var targetPath = 'w/' + state.sector + '/' + noun + state.zStr;
              var checkLoad = _deps.fileLoad(driveName, '/', targetPath, sessionToken);
              if (checkLoad.success) {
                state.content = state.content.replace('Za', noun);
                _deps.fileDelete(driveName, '/', targetPath, sessionToken);
              }
            }
          } else {
            if (state.content.indexOf(noun) > -1) {
              state.content = state.content.replace(noun, 'Za');
              var targetPath = 'w/' + state.sector + '/' + noun + state.zStr;
              let ts = 'X' + _deps.futureTimestamp(1);
              _deps.fileSave(driveName, '/', targetPath, '', sessionToken, sessionToken, ts);
            }
          }
          output += "S^Vi" + state.content.replace(/\s+/g, '') + "--^S";
        }
        break;
      }

      case 'Vn':
      case 'Vs':
      case 'Ve':
      case 'Vw': {
        if (!switchopen) {
          var GFX_COLS = 8;
          var GFX_ROWS = 12;

          var aWideLoad = _deps.fileLoad(driveName, '/', 'a/gfxGridWide', 'UNIVAC');
          if (!aWideLoad.success) aWideLoad = _deps.fileLoad(driveName, '/', 'a/mapx', 'UNIVAC');
          if (aWideLoad.success && aWideLoad.content) {
            GFX_COLS = parseInt(aWideLoad.content, 10) || GFX_COLS;
          }

          var aTallLoad = _deps.fileLoad(driveName, '/', 'a/gfxGridTall', 'UNIVAC');
          if (!aTallLoad.success) aTallLoad = _deps.fileLoad(driveName, '/', 'a/mapy', 'UNIVAC');
          if (aTallLoad.success && aTallLoad.content) {
            GFX_ROWS = parseInt(aTallLoad.content, 10) || GFX_ROWS;
          }

          var airLock = true;
          var aAirLockLoad = _deps.fileLoad(driveName, '/', 'a/gfxAirLock', 'UNIVAC');
          if (aAirLockLoad.success && aAirLockLoad.content) {
            airLock = (aAirLockLoad.content.trim().toLowerCase() === 'true');
          }

          var roundWorld = true;
          var aRoundLoad = _deps.fileLoad(driveName, '/', 'a/gfxRoundWorld', 'UNIVAC');
          if (aRoundLoad.success && aRoundLoad.content) {
            roundWorld = (aRoundLoad.content.trim().toLowerCase() === 'true');
          }

          var maxMapBounds = register['W4'] || 'Hh';
          var aBoundLoad = _deps.fileLoad(driveName, '/', 'a/gfxLowerBound', 'UNIVAC');
          if (aBoundLoad.success && aBoundLoad.content && aBoundLoad.content.trim().length === 2) {
            maxMapBounds = aBoundLoad.content.trim();
          }

          var currentZ   = state.z;
          var currentMap = state.sector;
          var newAvatar  = state.avatar;

          var col = currentZ % GFX_COLS;
          var row = Math.floor(currentZ / GFX_COLS);

          var tempZ       = currentZ;
          var targetMap   = currentMap;
          var isEdge      = false;
          var dirChar     = '';
          var moveBlocked = false;
          var noScroll = !!(options && options.noScroll);

          if (airLock) {
            if (word === 'Vn') {
              dirChar = 'N';
              if (row === 0) moveBlocked = true;
              else {
                tempZ = currentZ - GFX_COLS;
                if (!noScroll && Math.floor(tempZ / GFX_COLS) === 0) isEdge = true;
              }
            } else if (word === 'Vs') {
              dirChar = 'S';
              if (row === GFX_ROWS - 1) moveBlocked = true;
              else {
                tempZ = currentZ + GFX_COLS;
                if (!noScroll && Math.floor(tempZ / GFX_COLS) === GFX_ROWS - 1) isEdge = true;
              }
            } else if (word === 'Ve') {
              dirChar = 'E';
              if (col === GFX_COLS - 1) moveBlocked = true;
              else {
                tempZ = currentZ + 1;
                if (!noScroll && tempZ % GFX_COLS === GFX_COLS - 1) isEdge = true;
              }
            } else if (word === 'Vw') {
              dirChar = 'W';
              if (col === 0) moveBlocked = true;
              else {
                tempZ = currentZ - 1;
                if (!noScroll && tempZ % GFX_COLS === 0) isEdge = true;
              }
            }
          } else {
            if (word === 'Vn') {
              dirChar = 'N';
              if (row === 0) { if (noScroll) moveBlocked = true; else isEdge = true; }
              else tempZ = currentZ - GFX_COLS;
            } else if (word === 'Vs') {
              dirChar = 'S';
              if (row === GFX_ROWS - 1) { if (noScroll) moveBlocked = true; else isEdge = true; }
              else tempZ = currentZ + GFX_COLS;
            } else if (word === 'Ve') {
              dirChar = 'E';
              if (col === GFX_COLS - 1) { if (noScroll) moveBlocked = true; else isEdge = true; }
              else tempZ = currentZ + 1;
            } else if (word === 'Vw') {
              dirChar = 'W';
              if (col === 0) { if (noScroll) moveBlocked = true; else isEdge = true; }
              else tempZ = currentZ - 1;
            }
          }

          var w5Active = (register['W5'] && register['W5'] !== '00');
          var w6Active = (register['W6'] && register['W6'] !== '00');

          var localTile = 'Ga';
          if (isEdge) {
            localTile = getTileAt(currentMap, currentZ);
          } else if (!moveBlocked) {
            localTile = getTileAt(currentMap, tempZ);
          }

          if (w5Active && !moveBlocked) {
            if (!_canWalkTerrain(localTile, state.content)) {
              column = tape.length;
              break;
            }
          }

          if (moveBlocked) {
            column = tape.length;
            break;
          }

          if (w6Active && /^W[a-z]$/.test(register['W6'])) {
            var poolReg = register['W6'];
            var currentPoints = parseInt(register[poolReg] || '00', 10);
            if (isNaN(currentPoints)) currentPoints = 0;

            var moveCost = _getMoveCost(register['W5'], localTile);

            if (currentPoints < moveCost) {
              column = tape.length;
              break;
            }

            currentPoints -= moveCost;
            if (currentPoints < 0) currentPoints = 0;
            register[poolReg] = currentPoints.toString().padStart(2, '0');
          }

          var targetZ = tempZ;

          if (isEdge) {
            var nextSector = null;
            var cityWorldChar = _isCitySector(currentMap) ? _worldCharFromCity(currentMap.charAt(1)) : null;

            if (cityWorldChar !== null) {
              nextSector = currentMap.charAt(0) + cityWorldChar;
            } else {
              nextSector = calculateTargetSector(currentMap, dirChar, maxMapBounds, roundWorld);
            }

            if (nextSector && (cityWorldChar !== null || _isValidExit(driveName, currentMap, nextSector))) {
              targetMap = nextSector;

              if (cityWorldChar !== null) {
                var exitZ = findCityExitZ(nextSector);
                if (exitZ !== null) {
                  targetZ = decodeZ(exitZ, zBase);
                } else {
                  targetZ = currentZ;
                }
              } else if (airLock) {
                if (word === 'Vn') targetZ = tempZ + ((GFX_ROWS - 1) * GFX_COLS);
                if (word === 'Vs') targetZ = tempZ - ((GFX_ROWS - 1) * GFX_COLS);
                if (word === 'Ve') targetZ = tempZ - (GFX_COLS - 1);
                if (word === 'Vw') targetZ = tempZ + (GFX_COLS - 1);
              } else {
                if (word === 'Vn') targetZ = ((GFX_ROWS - 1) * GFX_COLS) + col;
                if (word === 'Vs') targetZ = col;
                if (word === 'Ve') targetZ = (row * GFX_COLS);
                if (word === 'Vw') targetZ = (row * GFX_COLS) + (GFX_COLS - 1);
              }
            } else if (!airLock) {
              column = tape.length;
              break;
            }
          }

          if (word === 'Ve' || word === 'Vw') {
            if (_deps && typeof _deps.flipAvatarDirection === 'function') {
              newAvatar = _deps.flipAvatarDirection(newAvatar, word);
            } else if (typeof flipAvatarDirection === 'function') {
              newAvatar = flipAvatarDirection(newAvatar, word);
            }
          }

          state.sector = targetMap;
          state.z      = targetZ;
          state.zStr   = encodeZ(targetZ, zBase);
          state.avatar = newAvatar;
        }
        break;
      }

      case 'Vt': {
        var targetSector = tape.slice(column, column + 2); column += 2;
        var zToken       = tape.slice(column, column + 2); column += 2;

        if (!switchopen) {
          var targetZStr = state.zStr;
          if (!ifnot) {
            if (!_isValidExit(driveName, state.sector, targetSector)) {
              break;
            }
          }

          var isValidZ = false;
          if (zBase === 10) {
            isValidZ = /^\d{2}$/.test(zToken);
          } else if (zBase === 52) {
            isValidZ = zToken.length === 2 && encodeZ(decodeZ(zToken, 52), 52) === zToken;
          } else {
            var zNum = parseInt(zToken, zBase);
            isValidZ = !isNaN(zNum) && zToken.toUpperCase() === encodeZ(zNum, zBase);
          }

          var normZToken = (zBase === 52) ? zToken : zToken.toUpperCase();

          if (isValidZ && !/^[A-Z][a-z0-9]$/.test(zToken)) {
            targetZStr = normZToken;
          } else if (/^[A-Z]/.test(zToken)) {
            var foundZ = findItemZ(targetSector, zToken);
            if (foundZ !== null) {
              targetZStr = (zBase === 52) ? foundZ : foundZ.toUpperCase();
            } else if (isValidZ) {
              targetZStr = normZToken;
            }
          }

          state.sector = targetSector;
          state.zStr   = targetZStr;
          state.z      = decodeZ(targetZStr, zBase);
        }
        ifnot = false;
        break;
      }

      case 'Vc': {
        if (!switchopen) {
          if (!ifnot) {
            var cityChar = _cityCharFromWorld(state.sector.charAt(1));
            if (cityChar !== null) {
              var targetSector = state.sector.charAt(0) + cityChar;
              var targetZStr = state.zStr;

              var exitZ = findCityExitZ(targetSector);
              if (exitZ !== null) {
                targetZStr = (zBase === 52) ? exitZ : exitZ.toUpperCase();
              }

              state.sector = targetSector;
              state.zStr   = targetZStr;
              state.z      = decodeZ(targetZStr, zBase);
            }
          } else {
            var worldChar = _worldCharFromCity(state.sector.charAt(1));
            if (worldChar !== null) {
              var targetSector = state.sector.charAt(0) + worldChar;
              var targetZStr = state.zStr;
              var exitZ = findCityExitZ(targetSector);
              if (exitZ !== null) {
                targetZStr = (zBase === 52) ? exitZ : exitZ.toUpperCase();
              }
              state.sector = targetSector;
              state.zStr   = targetZStr;
              state.z      = decodeZ(targetZStr, zBase);
            }
          }
          ifnot = false;
        } else {
          if (ifnot) ifnot = false;
        }
        break;
      }

      case 'Vl': {
        if (!switchopen) {
          var activeSectors = {};

          var pListRes = _deps.fileList(driveName, 'p/', null, sessionToken);
          if (pListRes && pListRes.success && pListRes.listing) {
            var pFiles = pListRes.listing.trim().split(/\s+/);
            for (var i = 0; i < pFiles.length; i++) {
              if (!pFiles[i]) continue;
              var pLoad = _deps.fileLoad(driveName, '/', 'p/' + pFiles[i], 'UNIVAC');
              if (pLoad.success && pLoad.content && pLoad.content.length >= 2) {
                var sec = pLoad.content.substring(0, 2);
                activeSectors[sec] = true;
              }
            }
          }

          activeSectors[state.sector] = true;

          var pCSVArr = [];
          var knownSectorsArr = [];
          var myTeam = state.id;

          for (var sec in activeSectors) {
            var secListRes = _deps.fileList(driveName, 'w/' + sec, null, sessionToken);
            if (secListRes && secListRes.success && secListRes.listing) {
              var wFiles = secListRes.listing.trim().split(/\s+/);
              var secPlayers = [];
              var teammateInSector = false;

              for (var j = 0; j < wFiles.length; j++) {
                var fname = wFiles[j];
                if (fname && fname.length >= 8) {
                  var fid = fname.substring(0, 2);
                  if (fid >= 'Sa' && fid < 'Ua') {
                    var fz = fname.substring(2, 4);
                    secPlayers.push(fid + sec + fz);
                    if (fid === myTeam) {
                      teammateInSector = true;
                    }
                  }
                }
              }

              if (teammateInSector) {
                knownSectorsArr.push(sec);
                pCSVArr = pCSVArr.concat(secPlayers);
              }
            }
          }

          var pCSV = pCSVArr.join('~');
          var knownSectorsStr = knownSectorsArr.join('');
          output += "Vl" + state.sector + state.zStr + pCSV + "|" + knownSectorsStr;
        }
        break;
      }

      case 'Xt': {
        var targetId = tape.slice(column, column + 4);
        column += 4;

        if (!switchopen && !ifnot) {
          var w7 = register['W7'];
          if (w7 && w7 !== '00') {
            var attackVal = getRegValue(w7).toString().padStart(2, '0');
            var myTeamId = state.id;

            var listRes = typeof _deps.fileList === 'function' ? _deps.fileList(driveName, 'w/' + state.sector, null, sessionToken) : {success: false, listing: ''};
            if (listRes.success && listRes.listing) {
              var files = listRes.listing.trim().split(/\s+/);
              var targetTeamId = null;

              for (var i = 0; i < files.length; i++) {
                var fname = files[i];
                if (fname.length >= 8 && fname.substring(4, 8) === targetId) {
                  targetTeamId = fname.substring(0, 2);
                  break;
                }
              }

              if (targetTeamId && targetTeamId !== myTeamId) {
                var tagPath = 'w/' + state.sector + '/Xt' + targetId;
                var tagContent = state.playerid + attackVal;
                var tsTag = _deps.futureTimestamp(1);
                _deps.fileSave(driveName, '/', tagPath, tagContent, sessionToken, sessionToken, 'X' + tsTag);
              }
            }
          }
        }
        ifnot = false;
        break;
      }

      case 'Xz': {
        var secToken = tape.slice(column, column + 2); column += 2;
        var zToken   = tape.slice(column, column + 2); column += 2;
        var tileCode = tape.slice(column, column + 2); column += 2;

        if (!switchopen) {
          var targetSector = (secToken.charAt(0) === 'W') ? (register[secToken] || secToken) : secToken;
          var targetZ = resolveZToken(zToken);
          if (isNaN(targetZ)) targetZ = 0;
          var targetZStr = encodeZ(targetZ, zBase);

          var listRes = typeof _deps.fileList === 'function' ? _deps.fileList(driveName, 'w/' + targetSector, null, sessionToken) : {success: false, listing: ''};
          var files = (listRes.success && listRes.listing) ? listRes.listing.trim().split(/\s+/) : [];
          var markerToDelete = null;

          for (var i = 0; i < files.length; i++) {
            if (files[i].length === 6 && files[i].substring(0, 2) === 'Xz' && files[i].substring(2, 4) === targetZStr) {
              markerToDelete = files[i];
              break;
            }
          }

          if (markerToDelete) {
            _deps.fileDelete(driveName, '/', 'w/' + targetSector + '/' + markerToDelete, sessionToken);
          }

          var markerFile = 'Xz' + targetZStr + tileCode;
          var tsMarker = _deps.futureTimestamp(1);
          _deps.fileSave(driveName, '/', 'w/' + targetSector + '/' + markerFile, '', sessionToken, sessionToken, tsMarker);

          var mPath = 'w/' + targetSector + '/m';
          var mLoad = _deps.fileLoad(driveName, '/', mPath, 'UNIVAC');
          var mContent = (mLoad.success && mLoad.content) ? mLoad.content : '';

          var charIdx = targetZ * 2;
          while (mContent.length < charIdx + 2) {
            mContent += 'Ga';
          }

          mContent = mContent.substring(0, charIdx) + tileCode + mContent.substring(charIdx + 2);
          _deps.fileSave(driveName, '/', mPath, mContent, sessionToken, sessionToken);
          _mapCache[targetSector] = mContent;
        }
        break;
      }

      case 'Vx': {
        var token = tape.slice(column, column + 2); column += 2;

        if (!switchopen) {
          if (ifnot) {
            if (token.charAt(0) === 'W') {
              if (objfile && objfile.substring(0, 4) !== "RAM:") {
                var oParts = objfile.replace(/^\//, '').split('/');
                if (oParts.length >= 3 && oParts[0] === 'w' && oParts[2].length >= 6) {
                  var oId = oParts[2].substring(0, 2);
                  register[token] = oId;
                }
              }
            }
          } else {
            if (objfile && objfile.substring(0, 4) !== "RAM:") {
              var oParts = objfile.replace(/^\//, '').split('/');
              if (oParts.length >= 3 && oParts[0] === 'w') {
                var oSector = oParts[1];
                var oFilename = oParts[2];

                if (oFilename.length >= 6) {
                  var oId = oFilename.substring(0, 2);
                  var oZ = oFilename.substring(2, 4);
                  var oData = oFilename.substring(4);

                  var newId = (token.charAt(0) === 'W') ? (register[token] || token) : token;

                  if (oId !== newId) {
                    var newFilename = newId + oZ + oData;
                    var newObjFile = 'w/' + oSector + '/' + newFilename;

                    var listRes = typeof _deps.fileList === 'function' ? _deps.fileList(driveName, 'w/' + oSector, null, sessionToken) : {success: false, listing: ''};
                    var files = (listRes.success && listRes.listing) ? listRes.listing.split(' ') : [];
                    var originalId = oId;
                    var markerToDelete = null;

                    for (var i = 0; i < files.length; i++) {
                      if (files[i].length === 6 && files[i].substring(0, 2) === 'Vx' && files[i].substring(4, 6) === oId) {
                        originalId = files[i].substring(2, 4);
                        markerToDelete = files[i];
                        break;
                      }
                    }

                    if (markerToDelete) {
                      _deps.fileDelete(driveName, '/', 'w/' + oSector + '/' + markerToDelete, sessionToken);
                    }
                    if (originalId !== newId) {
                      var markerFile = 'Vx' + originalId + newId;
                      var tsMarker = _deps.futureTimestamp(1);
                      _deps.fileSave(driveName, '/', 'w/' + oSector + '/' + markerFile, '', sessionToken, sessionToken, tsMarker);
                    }

                    if (typeof _deps.fileRename === 'function') {
                      _deps.fileRename(driveName, '/', objfile, newObjFile, sessionToken);
                    } else {
                      _deps.fileDelete(driveName, '/', objfile, sessionToken);
                      var tsObj = _deps.futureTimestamp(1);
                      _deps.fileSave(driveName, '/', newObjFile, tape, sessionToken, sessionToken, tsObj);
                    }
                    objfile = newObjFile;
                  }
                }
              }
            }
          }
        }

        ifnot = false;
        break;
      }

      case 'Vy': {
        var token = tape.slice(column, column + 2); column += 2;

        if (!switchopen) {
          if (ifnot) {
            if (token.charAt(0) === 'W') {
              if (objfile && objfile.substring(0, 4) !== "RAM:") {
                var oParts = objfile.replace(/^\//, '').split('/');
                if (oParts.length >= 3 && oParts[0] === 'w' && oParts[2].length >= 6) {
                  var oZ = oParts[2].substring(2, 4);
                  register[token] = oZ;
                }
              }
            }
          } else {
            if (objfile && objfile.substring(0, 4) !== "RAM:") {
              var oParts = objfile.replace(/^\//, '').split('/');
              if (oParts.length >= 3 && oParts[0] === 'w') {
                var oSector = oParts[1];
                var oFilename = oParts[2];

                if (oFilename.length >= 6) {
                  var oId = oFilename.substring(0, 2);
                  var oZ = oFilename.substring(2, 4);
                  var oData = oFilename.substring(4);

                  var targetZ = resolveZToken(token);
                  if (isNaN(targetZ)) targetZ = 0;
                  var targetZStr = encodeZ(targetZ, zBase);

                  if (oZ !== targetZStr) {
                    var newFilename = oId + targetZStr + oData;
                    var newObjFile = 'w/' + oSector + '/' + newFilename;

                    var listRes = typeof _deps.fileList === 'function' ? _deps.fileList(driveName, 'w/' + oSector, null, sessionToken) : {success: false, listing: ''};
                    var files = (listRes.success && listRes.listing) ? listRes.listing.split(' ') : [];
                    var originalId = oId;
                    var markerToDelete = null;

                    for (var i = 0; i < files.length; i++) {
                      if (files[i].length === 6 && files[i].substring(0, 2) === 'Vx' && files[i].substring(4, 6) === oId) {
                        originalId = files[i].substring(2, 4);
                        break;
                      }
                    }

                    for (var i = 0; i < files.length; i++) {
                      if (files[i].length === 6 && files[i].substring(0, 2) === 'Vy' && files[i].substring(2, 4) === originalId) {
                        markerToDelete = files[i];
                        break;
                      }
                    }

                    if (markerToDelete) {
                      _deps.fileDelete(driveName, '/', 'w/' + oSector + '/' + markerToDelete, sessionToken);
                    }

                    var markerFile = 'Vy' + originalId + targetZStr;
                    var tsMarker = _deps.futureTimestamp(1);
                    _deps.fileSave(driveName, '/', 'w/' + oSector + '/' + markerFile, '', sessionToken, sessionToken, tsMarker);

                    if (typeof _deps.fileRename === 'function') {
                      _deps.fileRename(driveName, '/', objfile, newObjFile, sessionToken);
                    } else {
                      _deps.fileDelete(driveName, '/', objfile, sessionToken);
                      var tsObj = 'X' + _deps.futureTimestamp(1);
                      _deps.fileSave(driveName, '/', newObjFile, tape, sessionToken, sessionToken, tsObj);
                    }
                    objfile = newObjFile;
                  }
                }
              }
            }
          }
        }

        ifnot = false;
        break;
      }

      case 'Vz': {
        var zToken = tape.slice(column, column + 2); column += 2;
        if (!switchopen) {
          if (ifnot) {
            if (zToken.charAt(0) === 'W' && LOWER_NUM.indexOf(zToken.charAt(1)) !== -1) {
              register[zToken] = state.zStr;
            }
          } else {
            var targetZ = resolveZToken(zToken);
            if (isNaN(targetZ)) targetZ = 0;
            state.z = targetZ;
            state.zStr = encodeZ(targetZ, zBase);
          }
        }
        ifnot = false;
        break;
      }

      case 'Xx': {
        if (!switchopen) {
          column = tape.length;
          switchopen = false;
          ifnot = false;
          break;
        }
        switchopen = false;
        ifnot = false;
        break;
      }

      case 'S^': {
        var endCol = tape.indexOf('^S', column);
        var plugContent = "";

        if (endCol !== -1) {
          plugContent = tape.slice(column, endCol);
          column = endCol + 2;
        } else {
          plugContent = tape.slice(column);
          column = tape.length;
        }

        if (!switchopen) {
          output += 'S^' + plugContent + '^S';
        }
        break;
      }

      default: {
        break;
      }
    }
  }

  // ── 4. Save and Cleanup ───────────────────────────────────────────────────

  for (var _rk in register) {
    if (!/^W[a-z@]$/.test(_rk)) continue;
    var _rv = register[_rk];
    var _re = new RegExp(_rk + '[0-9A-Za-z][0-9A-Za-z_()\\[\\]{}^,:;+\\-=%@]');
    if (!_rv || _rv === '00') {
      state.content = state.content.replace(_re, '');
    } else if (_re.test(state.content)) {
      state.content = state.content.replace(_re, _rk + _rv);
    } else {
      state.content += _rk + _rv;
    }
  }

  var newPath = 'w/' + state.sector + '/' + state.id + state.zStr + state.playerid + state.avatar;
  var saveRes = _deps.fileSave(driveName, '/', newPath, state.content, sessionToken, sessionToken);

  if (!saveRes.success) {
    console.error('UNIVAC: Failed to save to path ' + newPath + ': ' + saveRes.error);
    return;
  }

  var pName = state.playerid ? state.playerid : state.id;

  if (oldPath && oldPath !== newPath) {
    _deps.fileDelete(driveName, '/', oldPath, sessionToken);

    if (!originalPlayerId && state.playerid) {
      _deps.fileDelete(driveName, '/', 'p/' + originalId, sessionToken);
    }

    _deps.fileSave(driveName, '/', 'p/' + pName, state.sector + state.zStr + state.avatar, sessionToken, sessionToken);
  } else if (!oldPath && pName) {
    _deps.fileSave(driveName, '/', 'p/' + pName, state.sector + state.zStr + state.avatar, sessionToken, sessionToken);
  }

  return {
    sector:   state.sector,
    id:       state.id,
    z:        state.z,
    avatar:   state.avatar,
    playerid: state.playerid,
    fullPath: newPath,
    item:     state.id,
    output:   output
  };
}

function getDriveRegisters(driveName) {
  var _global = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this);
  if (!_global.registers) _global.registers = {};

  if (!_global.registers[driveName]) {
    _global.registers[driveName] = { W4: 'Dd' };
    loadconfig(driveName);
  }
  return _global.registers[driveName];
}

function saveconfig(drive) {
  const reg = getDriveRegisters(drive);
  let newconfig = "";
  for (let i = 0; i <= 9; i++) {
    const key = 'W' + i;
    if (reg[key]) {
      newconfig += key + reg[key];
    }
  }
  _deps.fileSave(drive, '/', 'w/a', newconfig, 'UNIVAC', 'UNIVAC');
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER_NUM = "abcdefghijklmnopqrstuvwxyz0123456789%()+,-:;=[]^_{}@";

function loadconfig(drive) {
  var _global = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this);
  if (!_global.registers) _global.registers = {};
  if (!_global.registers[drive]) _global.registers[drive] = { W4: 'Dd' };
  const reg = _global.registers[drive];

  const configfile = _deps.fileLoad(drive, '/', 'w/a', 'UNIVAC');
  if (!configfile || !configfile.success || typeof configfile.content !== 'string') return;

  let config = configfile.content;

  for (let column = 0; column < config.length; column += 4) {
    const code = config.substring(column, column + 2);
    const value = config.substring(column + 2, column + 4);
    if (code.startsWith('W')) { reg[code] = value; }
  }
}

function _incrementTwoCharCode(code) {
  const U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const L = 'abcdefghijklmnopqrstuvwxyz0123456789%()+,-:;=@[]^_{}';
  if (!code || code.length !== 2 || code === 'Zz') return 'Aa';

  const first  = U.indexOf(code[0]);
  const second = L.indexOf(code[1]);
  if (first === -1 || second === -1) return 'Aa';

  if (second < L.length - 1) return code[0] + L[second + 1];
  if (first < U.length - 1)  return U[first + 1] + L[0];
  return 'Aa';
}

function tickOdometer(driveName) {
  var odoLoad = _deps.fileLoad(driveName, '/', 'a/gfxOdometer', 'UNIVAC');
  var raw = (odoLoad && odoLoad.success && odoLoad.content) ? odoLoad.content.trim() : 'AaAa';
  if (raw.length < 4) raw = 'AaAa';

  var high = raw.substring(0, 2);
  var low  = raw.substring(2, 4);
  if (!/^[A-Z].$/.test(high) || !/^[A-Z].$/.test(low)) {
    high = 'Aa';
    low  = 'Aa';
  }

  var attempts = 0;
  var maxAttempts = 676 * 676;
  while (_deps.fileLoad(driveName, '/', 'p/' + high + low, 'UNIVAC').success && attempts < maxAttempts) {
    if (low === 'Zz') {
      low = 'Aa';
      high = _incrementTwoCharCode(high);
    } else {
      low = _incrementTwoCharCode(low);
    }
    attempts++;
  }

  var assignedId = high + low;

  // Store the NEXT player ID to assign in a/gfxOdometer
  var nextLow = low;
  var nextHigh = high;
  if (nextLow === 'Zz') {
    nextLow = 'Aa';
    nextHigh = _incrementTwoCharCode(nextHigh);
  } else {
    nextLow = _incrementTwoCharCode(nextLow);
  }
  _deps.fileSave(driveName, '/', 'a/gfxOdometer', nextHigh + nextLow, 'UNIVAC', 'UNIVAC');

  return assignedId;
}

function registeradd(regObj, reg) {
  const val = regObj[reg];

  if (/^\d{2}$/.test(val)) {
    const n = parseInt(val, 10);
    if (n < 99) regObj[reg] = String(n + 1).padStart(2, '0');
    return;
  }

  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789%()+,-:;=@[]^_{}';

  const first = UPPER.indexOf(val[0]);
  const second = LOWER.indexOf(val[1]);

  if (second < LOWER.length - 1) {
    regObj[reg] = val[0] + LOWER[second + 1];
  } else if (first < UPPER.length - 1) {
    regObj[reg] = UPPER[first + 1] + LOWER[0];
  } else {
    regObj[reg] = 'Aa';
  }
}

function registersub(regObj, reg) {
  const val = regObj[reg];

  if (/^\d{2}$/.test(val)) {
    const n = parseInt(val, 10);
    if (n > 0) regObj[reg] = String(n - 1).padStart(2, '0');
    return;
  }

  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789%()+,-:;=@[]^_{}';

  const first = UPPER.indexOf(val[0]);
  const second = LOWER.indexOf(val[1]);

  if (second > 0) {
    regObj[reg] = val[0] + LOWER[second - 1];
  } else if (first > 0) {
    regObj[reg] = UPPER[first - 1] + LOWER[LOWER.length - 1];
  } else {
    regObj[reg] = 'Z9';
  }
}

function calculateTargetSector(currentSector, dirChar, maxMapBounds, roundWorld) {
  if (!currentSector || currentSector.length < 2) return null;

  if (!maxMapBounds || maxMapBounds.length !== 2) {
    maxMapBounds = 'Hh';
  }
  if (roundWorld === undefined) roundWorld = true;

  let minY = 65;
  let minX = 97;

  let maxY = maxMapBounds.charCodeAt(0);
  let maxX = maxMapBounds.charCodeAt(1);

  let yCode = currentSector.charCodeAt(0);
  let xCode = currentSector.charCodeAt(1);

  if (dirChar === 'N') yCode -= 1;
  else if (dirChar === 'S') yCode += 1;
  else if (dirChar === 'E') xCode += 1;
  else if (dirChar === 'W') xCode -= 1;

  let wrapped = false;
  if (xCode < minX) { xCode = maxX; wrapped = true; }
  else if (xCode > maxX) { xCode = minX; wrapped = true; }

  if (yCode < minY) { yCode = maxY; wrapped = true; }
  else if (yCode > maxY) { yCode = minY; wrapped = true; }

  if (wrapped && !roundWorld) return null;

  return String.fromCharCode(yCode) + String.fromCharCode(xCode);
}


function flipAvatarDirection(avatarStr, cmd) {
  if (!avatarStr || (cmd !== 'Ve' && cmd !== 'Vw')) return avatarStr;

  var headBody = avatarStr.slice(0, 4);
  var rest = avatarStr.slice(4);

  if (cmd === 'Ve') {
    headBody = headBody.replace(/[ACEG]/g, function(c) {
      return String.fromCharCode(c.charCodeAt(0) + 1);
    });
  } else {
    headBody = headBody.replace(/[BDFH]/g, function(c) {
      return String.fromCharCode(c.charCodeAt(0) - 1);
    });
  }
  return headBody + rest;
}

// ── Exports ───────────────────────────────────────────────────────────────────

UNIVAC.inject        = inject;
UNIVAC.loadPunchCode = loadPunchCode;
UNIVAC.encodeZ       = encodeZ;
UNIVAC.decodeZ       = decodeZ;
UNIVAC.tickOdometer  = tickOdometer;

if (typeof window !== 'undefined') { window.UNIVAC = UNIVAC; }
if (typeof globalThis !== 'undefined') { globalThis.UNIVAC = UNIVAC; }

if (typeof module !== 'undefined' && module.exports) { module.exports = UNIVAC; }
