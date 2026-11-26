// ============================================================================
// Cylon Graphics & Physics Co-Processor (cylon-gfx.js)
// Dual-mode:
//   1. Local Desktop / Terminal Mode (CylonDOS-backed spatial filesystem)
//   2. Multiplayer Ping/Pong Mode (qandyland.js + UNIVAC packet relay)
// ============================================================================

// --- Unification with multiplayer gfx.js state variables ---
window.playerItem = "Za";
window.playerZ = -1;
window.lastClickZ = -1;
window.playerAvatar = "";
window.playerInven = "";
window.playerId = "";
window.playerWalk = -1;
window.playerDo = "";
window.map = "A1";

// --- Multiplayer Networking Context ---
window.remoteQandylandUrl = null;
window.desktopDrive = null;
window.gfxDrive = null;
window.cylonGfxSession = null;
window.gfxDo = "RF";
window.movingItems = {};

if (typeof UNIVAC !== 'undefined' && window.GfxSyncFS) {
    UNIVAC.inject(window.GfxSyncFS);
}

const QANDY_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const QANDY_LOWER = "abcdefghijklmnopqrstuvwxyz";
const QANDY_SYM   = "0123456789_()[]{}^,:;+-=%@";

window.CylonGFX = {
    // --- GFX Configuration Defaults ---
    gfxTileSize: 32,
    gfxTileDir: 't/',
    gfxIconDir: 'i/',
    gfxCharDir: 'c/',
    gfxMapsDir: 'm/',
    gridWide: 8,
    gridTall: 4,
    gfxGridStretch: true,

    // --- Spatial Navigation Defaults ---
    gfxRoundWorld: false,
    gfxLowerBound: 'Hh',
    gfxAirLock: false,
    gfxCommandLog: false,
    fillTileCode: null,
    gfxZBase: 10,

    // --- Tick & Animation Variables ---
    gfxCycle: 200,
    gfxTickRate: 1000,
    cursorInterval: null,
    networkInterval: null,

    // Backwards compatibility aliases
    get mapx() { return this.gridWide; },
    set mapx(v) { this.gridWide = v; },
    get mapy() { return this.gridTall; },
    set mapy(v) { this.gridTall = v; },
    get targetCursorZ() { return window.playerWalk; },
    set targetCursorZ(v) { window.playerWalk = v; },
    get pendingCursorAction() { return window.playerDo; },
    set pendingCursorAction(v) { window.playerDo = v; },

    currentPath: '',
    gfxGrid: false,
    lastRenderedItems: null,
    isSyncing: false,
    isLooking: false,
    terrainCache: null,
    itemIDOverrides: {},
    lastKnownSectors: "",
    lastKnownOpponents: {},
    lookCanvas: null,
    _afterTickQueue: [],

    // Cached static sector data for multiplayer mode (loaded once per sector)
    mapTiles: {},
    mapObjs: {},
    _loadedSector: null,

    // --- Z-Coordinate Encoders ---
    encodeZ: function(z, base) {
        if (base === 52) {
            if (z < 0 || z >= 1352) return "Aa";
            if (z < 676) {
                return QANDY_UPPER[Math.floor(z / 26)] + QANDY_LOWER[z % 26];
            } else {
                let z2 = z - 676;
                return QANDY_UPPER[Math.floor(z2 / 26)] + QANDY_SYM[z2 % 26];
            }
        }
        return z.toString(base).toUpperCase().padStart(2, '0');
    },

    decodeZ: function(zStr, base) {
        if (base === 52) {
            if (!zStr || zStr.length !== 2) return 0;
            let first = QANDY_UPPER.indexOf(zStr.charAt(0));
            if (first === -1) return 0;

            let secondLower = QANDY_LOWER.indexOf(zStr.charAt(1));
            if (secondLower !== -1) return (first * 26) + secondLower;

            let secondSym = QANDY_SYM.indexOf(zStr.charAt(1));
            if (secondSym !== -1) return 676 + (first * 26) + secondSym;

            return 0;
        }
        let val = parseInt(zStr, base);
        return isNaN(val) ? 0 : val;
    },

    getDOS: function() {
        return window.parent && window.parent.CylonDOS ? window.parent.CylonDOS : window.CylonDOS;
    },

    persistState: async function(path, data) {
        // Never write local OS state while running as a multiplayer client
        if (window.remoteQandylandUrl) return;
        let safeData = String(data || "\\n");
        if (this.gfxCommandLog && typeof window.CylonCommand === 'function') {
            let cliData = safeData.replace(/\n/g, '\\n');
            if (cliData.trim() === '') cliData = '\\n';
            await window.CylonCommand(`save ${path} ${cliData}`);
        } else {
            let dosObj = this.getDOS();
            if (dosObj) await dosObj.save(path, safeData);
        }
    },

    qdosLoadSafe: async function(dos, path) {
        try { return await dos.load(path); } catch (e) { return null; }
    },

    loadConfigFromDrive: async function(drive) {
        let dosObj = this.getDOS();
        let hostOrigin = '';

        if (dosObj) {
            try {
                let savedOrigin = await dosObj.load('cylon:/a/cylonHostOrigin');
                if (savedOrigin) hostOrigin = savedOrigin.trim();
            } catch (e) {}
        }
        if (hostOrigin && !hostOrigin.endsWith('/')) hostOrigin += '/';
        window.cylonHostOrigin = hostOrigin;

        if (window.CylonSDK && window.CylonSDK.injectDesktopStyles) {
            window.CylonSDK.injectDesktopStyles();
        }

        if (!dosObj) return;

        let tDir = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxTileDir`);
        let iDir = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxIconDir`);
        let cDir = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxCharDir`);
        let mDir = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxMapsDir`);
        let tSize = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxTileSize`);

        let zBaseLoad = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxZBase`);
        this.gfxZBase = zBaseLoad ? (parseInt(zBaseLoad, 10) || 10) : 10;

        let gWide = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxGridWide`) || await this.qdosLoadSafe(dosObj, `${drive}:/a/mapx`);
        let gTall = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxGridTall`) || await this.qdosLoadSafe(dosObj, `${drive}:/a/mapy`);
        let gStretch = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxGridStretch`);

        let cz = await this.qdosLoadSafe(dosObj, `${drive}:/a/playerZ`)
              || await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxCursorZ`)
              || await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxSpawnZ`);
        let pItem = await this.qdosLoadSafe(dosObj, `${drive}:/a/playerItem`);

        let rWorld = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxRoundWorld`);
        let lBound = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxLowerBound`);
        let aLock = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxAirLock`);
        let cLog = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxCommandLog`);
        let tickRate = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxTickRate`);
        let cycleStr = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxCycle`);

        if (tDir) this.gfxTileDir = tDir.trim();
        if (iDir) this.gfxIconDir = iDir.trim();
        if (cDir) this.gfxCharDir = cDir.trim();
        if (mDir) this.gfxMapsDir = mDir.trim();
        if (tSize) this.gfxTileSize = parseInt(tSize, 10);

        if (hostOrigin) {
            if (!this.gfxTileDir.match(/^https?:\/\//i) && !this.gfxTileDir.startsWith('data:')) this.gfxTileDir = hostOrigin + this.gfxTileDir;
            if (!this.gfxIconDir.match(/^https?:\/\//i) && !this.gfxIconDir.startsWith('data:')) this.gfxIconDir = hostOrigin + this.gfxIconDir;
            if (!this.gfxCharDir.match(/^https?:\/\//i) && !this.gfxCharDir.startsWith('data:')) this.gfxCharDir = hostOrigin + this.gfxCharDir;
            if (!this.gfxMapsDir.match(/^https?:\/\//i) && !this.gfxMapsDir.startsWith('data:')) this.gfxMapsDir = hostOrigin + this.gfxMapsDir;
        }

        if (gWide) { let n = parseInt(gWide, 10); if (!isNaN(n) && n > 0) this.gridWide = n; }
        if (gTall) { let n = parseInt(gTall, 10); if (!isNaN(n) && n > 0) this.gridTall = n; }
        if (gStretch) this.gfxGridStretch = (gStretch.trim().toLowerCase() === 'true');

        if (rWorld) this.gfxRoundWorld = (rWorld.trim().toLowerCase() === 'true');
        if (lBound) this.gfxLowerBound = lBound.trim();
        if (aLock) this.gfxAirLock = (aLock.trim().toLowerCase() === 'true');
        if (cLog) this.gfxCommandLog = (cLog.trim().toLowerCase() === 'true');

        if (tickRate !== null && tickRate !== undefined && tickRate.trim() !== '') {
            this.gfxTickRate = Math.max(0, parseInt(tickRate, 10) || 0);
        }

        if (cycleStr) {
            let val = parseFloat(cycleStr.trim());
            if (!isNaN(val)) this.gfxCycle = Math.floor(val * 1000);
        }
        
        this.itemIDOverrides = {};
        let rawItemMods = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxItemID`);
        if (rawItemMods && rawItemMods.trim()) {
            try {
                let parsedMods = JSON.parse(rawItemMods);
                if (parsedMods && typeof parsedMods === 'object' && !Array.isArray(parsedMods)) {
                    this.itemIDOverrides = parsedMods;
                }
            } catch (e) {
                console.warn('Invalid gfxItemID JSON on drive ' + drive, e);
            }
        }


        if (!window.remoteQandylandUrl) {
            if (pItem) window.playerItem = pItem.trim();
            window.playerZ = cz ? this.decodeZ(cz, this.gfxZBase) : 0;
        }
    },

    init: async function(startPath) {
        this.setupListeners();
        this.currentPath = startPath;
        let parts = startPath.replace(/\/$/, '').split('/');
        window.map = parts[parts.length - 1] || "A1";
        let drive = startPath.split(':')[0];

        await this.loadConfigFromDrive(drive);

        this.startCursorTick();
        window.dispatchEvent(new Event('resize'));

        if (!window.remoteQandylandUrl) {
            await this.renderScreen();
        }
    },

    setupListeners: function() {
        if (!this._listenersAdded) {
            window.addEventListener('message', async (e) => {
                if (window.location.origin !== "null" && e.origin !== window.location.origin) return;
                if (e.source !== window && e.source !== window.parent) return;

                if (e.data.type === 'QANDY_GFX_CMD') {
                    await this.handleGfxCommand(e.data.cmd, e.data.data);
                } else if (e.data.type === 'gfx' && !window.remoteQandylandUrl) {
                    // Only interpret popup "gfx:" links locally when NOT in multiplayer mode;
                    // in multiplayer mode, the game client handles popup links -> window.gfxDo.
                    let fullCmd = String(e.data.cmd).trim();
                    let spaceIdx = fullCmd.indexOf(' ');
                    if (spaceIdx > -1) {
                        await this.handleGfxCommand(fullCmd.substring(0, spaceIdx), fullCmd.substring(spaceIdx + 1));
                    } else {
                        await this.handleGfxCommand(fullCmd, "");
                    }
                }
            });
            this._listenersAdded = true;
        }

        const wrapper = document.getElementById('screen-wrapper') || document.getElementById('desktop-wrapper');

        if (wrapper && !this._bgClickBound) {
            wrapper.addEventListener('pointerup', (e) => {
                if (e.button !== 0 && e.pointerType === 'mouse') return;
                window.focus();

                if (window.parent && window.parent.CylonPopManager) {
                    let contextWrapper = window.parent.document.getElementById('cylon-context-wrapper');
                    if (contextWrapper && contextWrapper.style.display !== 'none') {
                        if (typeof window.parent.CylonPopManager.hideContextMenu === 'function') {
                            window.parent.CylonPopManager.hideContextMenu();
                        } else {
                            contextWrapper.style.display = 'none';
                        }
                        return;
                    }
                }

                let rect = wrapper.getBoundingClientRect();
                let pctX = (e.clientX - rect.left) / rect.width;
                let pctY = (e.clientY - rect.top) / rect.height;
                let x = Math.floor(pctX * this.gridWide);
                let y = Math.floor(pctY * this.gridTall);

                x = Math.max(0, Math.min(x, this.gridWide - 1));
                y = Math.max(0, Math.min(y, this.gridTall - 1));
                let z = y * this.gridWide + x;

                window.lastClickZ = z;
                if (window.parent && window.parent !== window) {
                    window.parent.lastClickZ = z;
                }

                if (wrapper.id === 'desktop-wrapper') {
                    if (!window.remoteQandylandUrl && this.enableFileMove && this.pendingMovePath) {
                        const pendingPath = this.pendingMovePath;
                        this.pendingMovePath = null;
                        window.playerWalk = -1;
                        this.setCursorZ(z);
                        this.moveObjectToZ(pendingPath, z).then(() => this.showTargetMenu(z, e.clientX, e.clientY));
                        return;
                    }
                    if (!window.remoteQandylandUrl && this.clickMovesCursor) {
                        window.playerWalk = -1;
                        this.setCursorZ(z);
                    }
                    this.showTargetMenu(z, e.clientX, e.clientY);
                }
            });

            wrapper.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                window.focus();
                if (window.parent && window.parent.document) window.parent.document.dispatchEvent(new Event('click'));

                let rect = wrapper.getBoundingClientRect();
                let pctX = (e.clientX - rect.left) / rect.width;
                let pctY = (e.clientY - rect.top) / rect.height;
                let x = Math.floor(pctX * this.gridWide);
                let y = Math.floor(pctY * this.gridTall);

                x = Math.max(0, Math.min(x, this.gridWide - 1));
                y = Math.max(0, Math.min(y, this.gridTall - 1));
                let z = y * this.gridWide + x;

                window.lastClickZ = z;
                if (window.parent && window.parent !== window) { window.parent.lastClickZ = z; }

                if (wrapper.id === 'desktop-wrapper') {
                    if (!window.remoteQandylandUrl) {
                        window.playerWalk = -1;
                        this.setCursorZ(z);
                    }
                    this.showTargetMenu(z, e.clientX, e.clientY);
                }
            });
            this._bgClickBound = true;
        }
    },
    
    getItemName: function(iconId) {
        if (this.itemIDOverrides && Object.prototype.hasOwnProperty.call(this.itemIDOverrides, iconId)) {
            let custom = this.itemIDOverrides[iconId];
            if (custom !== undefined && custom !== null && String(custom).trim() !== '') {
                return String(custom);
            }
        }
        return typeof window.gfxItemID === 'function' ? window.gfxItemID(iconId) : iconId;
    },

    getBaseItemName: async function(dos, itemId) {
        if (dos) {
            try {
                if (await dos.exists('cylon:/cylon-gfx-itemid.js')) {
                    let code = await dos.load('cylon:/cylon-gfx-itemid.js');
                    if (code) {
                        let parsedFn = new Function('window', code + '\nreturn window.gfxItemID;')({});
                        if (typeof parsedFn === 'function') {
                            return parsedFn(itemId);
                        }
                    }
                }
            } catch (e) {}
        }
        if (typeof window.baseGfxItemID === 'function') return window.baseGfxItemID(itemId);
        if (typeof window.gfxItemID === 'function') return window.gfxItemID(itemId);
        return 'Unknown';
    },

    resolveGfxDrive: async function(dos, driveName) {
        if (!dos) return null;
        let mounts = await dos.mounts();

        if (driveName !== undefined && driveName !== null && String(driveName).trim() !== '') {
            let clean = String(driveName).trim().replace(/:$/, '');
            let exact = mounts.find(m => m.name === clean);
            if (!exact && clean.toLowerCase().endsWith('.gfx')) {
                let base = clean.slice(0, -4);
                exact = mounts.find(m => m.name === base);
            }
            return exact || null;
        }

        let isGfxMount = (m) => {
            if (!m) return false;
            let src = String(m.source || '').toLowerCase();
            let name = String(m.name || '').toLowerCase();
            return src.endsWith('.gfx') || name.endsWith('.gfx') || name === 'desktop';
        };

        // 1. Drive of the active GFX engine (e.g. desktop:/w/Aa)
        if (this.currentPath && this.currentPath.indexOf(':') !== -1) {
            let pathDrive = this.currentPath.split(':')[0];
            let pathMount = mounts.find(m => m.name === pathDrive);
            if (isGfxMount(pathMount)) return pathMount;
        }

        // 2. Current DOS working drive if it is a .gfx drive
        let pwd = dos.pwd ? dos.pwd() : '';
        if (pwd && pwd !== '(no drive)' && pwd.indexOf(':') !== -1) {
            let pwdDrive = pwd.split(':')[0];
            let pwdMount = mounts.find(m => m.name === pwdDrive);
            if (isGfxMount(pwdMount)) return pwdMount;
        }

        // 3. Fallback to mounted desktop or first mounted .gfx drive
        return mounts.find(m => m.name === 'desktop') || mounts.find(isGfxMount) || null;
    },

    handleGfxId: async function(rawData, driveName) {
        let dos = this.getDOS();
        let trimmed = String(rawData == null ? '' : rawData).trim();
        if (!trimmed) {
            return { ok: false, output: 'Usage: gfx [drive] <mod|id> <item> [description]' };
        }

        let spaceIdx = trimmed.search(/\s/);
        let itemId = (spaceIdx === -1) ? trimmed : trimmed.substring(0, spaceIdx);
        let hasDesc = (spaceIdx !== -1);
        let descRaw = hasDesc ? trimmed.substring(spaceIdx + 1).trim() : '';

        if (!/^[A-Z][a-z0-9]$/.test(itemId)) {
            return { ok: false, output: 'Error: [.4]Invalid item ID "' + itemId + '" (expected 2 chars: A-Z followed by a-z or 0-9).[.]' };
        }

        let hasExplicitDrive = (driveName !== undefined && driveName !== null && String(driveName).trim() !== '');
        let cleanDrive = hasExplicitDrive ? String(driveName).trim().replace(/:$/, '') : '';

        if (hasExplicitDrive && !dos) {
            return { ok: false, output: 'Error: [.4]CylonDOS is not available.[.]' };
        }

        let baseName = await this.getBaseItemName(dos, itemId);
        let gfxMount = await this.resolveGfxDrive(dos, hasExplicitDrive ? cleanDrive : null);

        if (hasExplicitDrive) {
            if (!gfxMount) {
                return { ok: false, output: 'Error: [.4]Drive "' + cleanDrive + '" is not mounted.[.]' };
            }
            if (gfxMount.type === 'idb' || gfxMount.name === 'cylon') {
                return { ok: false, output: 'Error: [.4]Drive ' + gfxMount.name + ':/ is not a .gfx drive.[.]' };
            }
        }

        // Display mode: gfx [drive] <mod|id> <item>
        if (!hasDesc) {
            let modName = null;
            if (gfxMount && dos) {
                try {
                    let modPath = gfxMount.name + ':/a/gfxItemID';
                    if (await dos.exists(modPath)) {
                        let raw = await dos.load(modPath);
                        if (raw && raw.trim()) {
                            let parsed = JSON.parse(raw);
                            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                let v = parsed[itemId];
                                if (v !== undefined && v !== null && String(v).trim() !== '') {
                                    modName = String(v).trim();
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
            let prefix = gfxMount ? (gfxMount.name + ':/ ') : '';
            let out = prefix + itemId + ' = ' + baseName;
            if (modName !== null) out += ', mod = ' + modName;
            return { ok: true, output: out };
        }

        // Modify mode: gfx [drive] <mod|id> <item> <description>
        if (!dos) {
            return { ok: false, output: 'Error: [.4]CylonDOS is not available.[.]' };
        }
        if (!gfxMount) {
            return { ok: false, output: 'Error: [.4]No .gfx drive mounted.[.]' };
        }
        if (gfxMount.readOnly || gfxMount.type === 'idb') {
            return { ok: false, output: 'Error: [.4]Drive ' + gfxMount.name + ':/ is read-only.[.]' };
        }

        // Strip matching outer quotes (supports "Magic Slippers" or "" to clear)
        let desc = descRaw;
        if (desc.length >= 2 &&
            ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'")))) {
            desc = desc.slice(1, -1);
        }
        desc = desc.trim();

        if (/[\x00-\x1F\x7F]/.test(desc) || desc.length > 64) {
            return { ok: false, output: 'Error: [.4]Invalid description (max 64 printable characters).[.]' };
        }

        let modPath = gfxMount.name + ':/a/gfxItemID';
        let mods = {};
        try {
            if (await dos.exists(modPath)) {
                let raw = await dos.load(modPath);
                if (raw && raw.trim()) {
                    let parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        mods = parsed;
                    }
                }
            }
        } catch (e) {
            mods = {};
        }

        if (desc === '') {
            delete mods[itemId];
        } else {
            mods[itemId] = desc;
        }

        try {
            if (Object.keys(mods).length === 0) {
                if (await dos.exists(modPath)) {
                    await dos.delete(modPath);
                }
            } else {
                let aDir = gfxMount.name + ':/a';
                if (!(await dos.exists(aDir))) {
                    await dos.mkdir(aDir);
                }
                await dos.save(modPath, JSON.stringify(mods));
            }
        } catch (e) {
            return { ok: false, output: 'Error: [.4]' + (e && e.message ? e.message : String(e)) + '[.]' };
        }

        // Refresh live engine state if currently attached to this drive
        let curDrive = (this.currentPath && this.currentPath.indexOf(':') !== -1) ? this.currentPath.split(':')[0] : null;
        if (curDrive === gfxMount.name || window.desktopDrive === gfxMount.name) {
            this.itemIDOverrides = mods;
            if (typeof window.reloadItemIDMods === 'function') {
                await window.reloadItemIDMods();
            }
            if (window.remoteQandylandUrl) {
                if (window.map) this.renderSectorStaticObjects(window.map);
                this.lastRenderedItems = null;
                if (!this.isSyncing) await this.networkTick();
            } else if (document.getElementById('icons-layer')) {
                await this.renderScreen();
            }
        }

        let out = gfxMount.name + ':/ ' + itemId + ' = ' + baseName;
        if (desc !== '') out += ', mod = ' + desc;
        return { ok: true, output: out };
    },

    // ========================================================================
    // MULTIPLAYER PING / PONG ENGINE (1984 Architecture)
    // ========================================================================

    resolveServerDrive: async function(url, worldHint) {
        let candidate = worldHint || window.gfxDrive || window.desktopDrive || 'cylon-capflag.gfx';
        let stripped = candidate.replace(/^cylon-/i, '');
        let strippedBase = stripped.replace(/\.gfx$/i, '');
        try {
            let res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'c=SYS:DRIVES'
            });
            if (res.ok) {
                let text = await res.text();
                let drives = text.split(',').map(s => s.trim()).filter(Boolean);
                if (drives.length > 0) {
                    let tries = [
                        candidate,
                        candidate + '.gfx',
                        stripped,
                        strippedBase + '.gfx',
                        'cylon-' + strippedBase,
                        'cylon-' + strippedBase + '.gfx',
                        window.desktopDrive,
                        window.desktopDrive ? window.desktopDrive + '.gfx' : null
                    ].filter(Boolean);
                    for (let t of tries) {
                        if (drives.includes(t)) return t;
                    }
                }
            }
        } catch (e) {}
        return candidate.endsWith('.gfx') ? candidate : candidate + '.gfx';
    },

    gfxConnect: async function(url, localDrive, serverDriveHint, startSector) {
        window.remoteQandylandUrl = url;
        window.desktopDrive = localDrive;
        window.cylonGfxSession = null;
        window.playerItem = "Za";
        window.playerZ = 0;
        window.playerAvatar = "";
        window.playerInven = "";
        window.playerId = "";
        window.playerWalk = -1;
        window.playerDo = "";
        window.movingItems = {};
        this.mapTiles = {};
        this.mapObjs = {};
        this._loadedSector = null;
        this.lastRenderedItems = null;
        this.isLooking = false;
        if (this.lookCanvas) this.lookCanvas.style.display = 'none';

        window.gfxDrive = await this.resolveServerDrive(url, serverDriveHint || localDrive);

        let sec = startSector || 'Fb';
        await this.init(`${localDrive}:/w/${sec}`);

        // Initial ST handshake ping -> pong
        let stPong = await this.gfxPing("ST");
        await this.processPong(stPong);

        // Immediately fetch initial PI + RF state
        window.gfxDo = "RF";
        this.startNetworkTick();
    },

    gfxPing: async function(commandString) {
        if (!window.remoteQandylandUrl) throw new Error('gfxPing: no server URL');
        if (!commandString || commandString.length < 2) throw new Error('gfxPing: invalid command');

        let drive = window.gfxDrive || window.desktopDrive || 'cylon-capflag.gfx';
        if (!drive.endsWith('.gfx')) drive += '.gfx';

        let formData = new URLSearchParams();
        formData.append('c', commandString);
        formData.append('d', drive);
        if (window.cylonGfxSession) {
            formData.append('s', window.cylonGfxSession);
        }

        let res = await fetch(window.remoteQandylandUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString()
        });
        if (!res.ok) throw new Error('Server error: ' + res.status);
        return await res.text();
    },

    startNetworkTick: function() {
        if (this.networkInterval) clearInterval(this.networkInterval);
        this.networkInterval = null;
        this.networkTick();
        const rate = Number.isFinite(this.gfxTickRate) ? this.gfxTickRate : 1000;
        if (rate > 0) this.networkInterval = setInterval(() => this.networkTick(), rate);
    },

    networkTick: async function() {
        if (this.isSyncing || !window.remoteQandylandUrl) return;
        this.isSyncing = true;
        let afterThisTick = this._afterTickQueue ? this._afterTickQueue.splice(0) : [];

        try {
            let plugs = window.gfxDo || "RF";
            window.gfxDo = "";

            if (this.isLooking && plugs === "RF") {
                plugs = "Vl";
            } else if (this.isLooking && plugs.indexOf("Vl") === -1 && plugs === "") {
                plugs = "Vl";
            }
            if (!plugs) plugs = "RF";

            let pong = await this.gfxPing(plugs);
            if (pong) {
                await this.processPong(pong);
            }
        } catch (e) {
            console.error("Network tick error:", e);
        } finally {
            try {
                for (let q of afterThisTick) {
                    await this.handleGfxCommand(q.cmd, q.data);
                }
            } finally {
                this.isSyncing = false;
            }
            if (window.gfxDo && window.gfxDo !== "RF") {
                this.networkTick();
            }
        }
    },
    
        stopNetworkTick: function() {
        if (this.networkInterval) {
            clearInterval(this.networkInterval);
            this.networkInterval = null;
        }
    },

    resetSession: function() {
        this.stopNetworkTick();
        window.cylonGfxSession = null;
        window.playerItem = "Za";
        window.playerZ = 0;
        window.playerAvatar = "";
        window.playerInven = "";
        window.playerId = "";
        window.playerWalk = -1;
        window.playerDo = "";
        window.gfxDo = "RF";
        window.movingItems = {};
        this.lastRenderedItems = null;
        this.fillTileCode = null;
        this.isLooking = false;
        if (this.lookCanvas) this.lookCanvas.style.display = 'none';
    },

    ensureSession: async function() {
        if (window.cylonGfxSession) return window.cylonGfxSession;
        if (!window.remoteQandylandUrl) return null;
        let stPong = await this.gfxPing("ST");
        await this.processPong(stPong);
        return window.cylonGfxSession;
    },

    processPong: async function(response) {
        if (!response || typeof response !== 'string') return;

        let col = 0;
        let serverPlayerZ = null;
        let sPlugsBuffer = "";

        const flushServerPlugs = () => {
            if (!sPlugsBuffer) return;
            let batch = sPlugsBuffer;
            sPlugsBuffer = "";
            if (typeof window.serverdown === 'function') {
                window.serverdown(batch);
            }
        };

        while (col < response.length) {
            let cmd = response.substring(col, col + 2);

            if (cmd === 'ST') {
                window.cylonGfxSession = response.substring(col + 2);
                col = response.length;
            }

            else if (cmd === 'S^') {
                let end = response.indexOf('^S', col + 2);
                let sPlugs = (end !== -1) ? response.substring(col + 2, end) : response.substring(col + 2);
                col = (end !== -1) ? end + 2 : response.length;
                if (sPlugs.indexOf('LO--') !== -1) {
                    this.resetSession();
                }
                sPlugsBuffer += sPlugs;
            } else if (cmd === 'PI') {
                if (this.gfxTickRate !== 0) {
                    let newItem = response.substring(col + 2, col + 4);
                    let zStr = response.substring(col + 4, col + 6);
                    serverPlayerZ = this.decodeZ(zStr, this.gfxZBase);
                    let newId = response.substring(col + 6, col + 10);

                    // If local player upgraded from Za or changed team, migrate queue key
                    if (window.playerItem && window.playerItem !== newItem && window.movingItems[window.playerItem]) {
                        window.movingItems[newItem] = window.movingItems[window.playerItem];
                        delete window.movingItems[window.playerItem];
                    }
                    window.playerItem = newItem;
                    window.playerId = newId;

                    let localQueue = (window.movingItems[window.playerItem] && window.movingItems[window.playerItem].queue) || [];
                    if (localQueue.length === 0 && window.playerWalk === -1) {
                        window.playerZ = serverPlayerZ;
                    }
                }
                col += 10;
            }
            else if (cmd === 'Vi') {
                let end = response.indexOf('--', col + 2);
                if (end !== -1) {
                    window.playerInven = response.substring(col + 2, end);
                    col = end + 2;
                } else {
                    window.playerInven = response.substring(col + 2);
                    col = response.length;
                }
                if (typeof window.renderInventory === 'function') {
                    window.renderInventory();
                }
            }
            else if (cmd === 'Vl') {
                this.isLooking = true;
                let myMap = response.substring(col + 2, col + 4);
                let myZ = response.substring(col + 4, col + 6);
                let playerData = response.substring(col + 6);
                await this.gfxRenderGlobalCanvas(myMap, myZ, playerData);
                col = response.length;
            }
            else if (cmd === 'RF') {
                this.isLooking = false;
                if (this.lookCanvas) this.lookCanvas.style.display = 'none';

                if (this.gfxTickRate !== 0) {
                    let sector = response.substring(col + 2, col + 4);
                    let zStr = response.substring(col + 4, col + 6);
                    let itemsStr = response.substring(col + 6);
                    await this.gfxRefresh(sector, zStr, itemsStr);
                }
                col = response.length;
            }
            else {
                col++;
            }        }

        flushServerPlugs();
    },

    // Load sector terrain ('m') and static 6-char objects once from CylonDOS into memory
    ensureSectorCached: async function(sector) {
        let drive = window.desktopDrive || this.currentPath.split(':')[0] || 'capflag';
        let dos = this.getDOS();
        if (!dos) return;

        if (!this.mapTiles[sector]) {
            let tData = await this.qdosLoadSafe(dos, `${drive}:/w/${sector}/m`) || "";
            tData = tData.replace(/\s+/g, '');
            let expectedLen = this.gridWide * this.gridTall * 2;
            if (tData.length < expectedLen) {
                tData += 'Za'.repeat(Math.ceil((expectedLen - tData.length) / 2));
            }
            this.mapTiles[sector] = tData;
        }

        if (!this.mapObjs[sector]) {
            let staticList = [];
            try {
                let files = await dos.dir(`${drive}:/w/${sector}`);
                for (let file of files) {
                    if (file.type !== 'file') continue;
                    let fname = file.name.substring(file.name.lastIndexOf('/') + 1);
                    if (fname === 'm' || fname === 'e' || fname === 't') continue;
                    let lead = fname.charAt(0);
                    // Static world objects are 6 chars and do not start with V or X
                    if (fname.length === 6 && lead !== 'V' && lead !== 'X') {
                        staticList.push(fname);
                    }
                }
            } catch (e) {}
            this.mapObjs[sector] = staticList;
        }
    },

    // Build a single tile <img>. Records data-src so we can diff cheaply later.
    _makeTileEl: function(z, code) {
        let x = z % this.gridWide;
        let y = Math.floor(z / this.gridWide);
        let src = `${this.gfxTileDir}${code}.png`;

        let img = document.createElement('img');
        img.src = src;
        img.setAttribute('data-src', src);
        img.onerror = function() { this.style.display = 'none'; };
        img.style.position = 'absolute';
        img.style.left = ((x / this.gridWide) * 100) + '%';
        img.style.top = ((y / this.gridTall) * 100) + '%';
        img.style.width = ((1 / this.gridWide) * 100) + '%';
        img.style.height = ((1 / this.gridTall) * 100) + '%';
        img.style.imageRendering = 'pixelated';
        img.id = `gfx-tile-${z}`;
        return img;
    },

    // Full rebuild (sector change / explicit edits only).
    renderSectorTiles: function(sector) {
        const tilesLayer = document.getElementById('tiles-layer');
        if (!tilesLayer) return;
        tilesLayer.innerHTML = '';

        let tData = this.mapTiles[sector] || '';
        let total = this.gridWide * this.gridTall;
        for (let z = 0; z < total; z++) {
            let code = tData.substring(z * 2, z * 2 + 2);
            if (code && code !== 'Za') {
                tilesLayer.appendChild(this._makeTileEl(z, code));
            }
        }
    },

    // Flicker-free refresh: only touches tiles whose image actually changed.
    // Result in the DOM is identical to renderSectorTiles().
    syncSectorTiles: function(sector) {
        const tilesLayer = document.getElementById('tiles-layer');
        if (!tilesLayer) return;

        let existing = new Map();
        for (let el of Array.from(tilesLayer.children)) existing.set(el.id, el);

        let tData = this.mapTiles[sector] || '';
        let total = this.gridWide * this.gridTall;
        for (let z = 0; z < total; z++) {
            let code = tData.substring(z * 2, z * 2 + 2);
            let want = (code && code !== 'Za') ? code : null;
            let id = `gfx-tile-${z}`;
            let el = existing.get(id);
            existing.delete(id);

            if (!want) {
                if (el) el.remove();
                continue;
            }
            let src = `${this.gfxTileDir}${want}.png`;
            if (!el) {
                tilesLayer.appendChild(this._makeTileEl(z, want));
            } else if (el.getAttribute('data-src') !== src) {
                el.src = src;
                el.setAttribute('data-src', src);
                el.style.display = '';
            }
        }
        // Anything left over has no valid id/slot any more
        existing.forEach(el => el.remove());
    },

    // Build one static object element from its filename (e.g. "Ta0cZa").
    // data-base-code remembers the pristine filename so we can diff/reset later.
    _buildStaticObj: function(sector, fname) {
        let drive = window.desktopDrive || this.currentPath.split(':')[0] || 'capflag';
        let iconId = fname.substring(0, 2);
        let zHex = fname.substring(2, 4);
        let z = this.decodeZ(zHex, this.gfxZBase);
        if (isNaN(z)) return null;

        let x = z % this.gridWide;
        let y = Math.floor(z / this.gridWide);
        let labelText = this.getItemName(iconId);
        let fullPath = `${drive}:/w/${sector}/${fname}`;

        let wrap = this.buildSprite(iconId, x, y, z, labelText, fullPath, "");
        if (wrap) {
            wrap.classList.add('static-obj');
            wrap.setAttribute('data-orig-id', iconId);
            wrap.setAttribute('data-id', iconId);
            wrap.setAttribute('data-zstr', zHex);
            wrap.setAttribute('data-code', fname);
            wrap.setAttribute('data-base-code', fname);
            wrap.id = `obj_${iconId}_${z}`;
        }
        return wrap;
    },

    // Full rebuild (sector change / explicit object edits). Also clears dynamic
    // sprites and chat bubbles, as before.
    renderSectorStaticObjects: function(sector) {
        const iconsLayer = document.getElementById('icons-layer');
        if (!iconsLayer) return;

        iconsLayer.querySelectorAll('.dyn-sprite, .chat-bubble').forEach(el => el.remove());
        iconsLayer.querySelectorAll('.static-obj').forEach(el => el.remove());

        let objs = this.mapObjs[sector] || [];
        for (let fname of objs) this._buildStaticObj(sector, fname);
    },

    // Flicker-free refresh: keeps existing static objects in the DOM, only
    // adding new ones and removing ones that no longer exist.
    syncSectorStaticObjects: function(sector) {
        const iconsLayer = document.getElementById('icons-layer');
        if (!iconsLayer) return;

        let want = this.mapObjs[sector] || [];
        let wantSet = new Set(want);
        let have = new Map();

        iconsLayer.querySelectorAll('.static-obj').forEach(el => {
            let key = el.getAttribute('data-base-code');
            if (!key || !wantSet.has(key) || have.has(key)) el.remove();
            else have.set(key, el);
        });

        for (let fname of want) {
            if (!have.has(fname)) {
                let w = this._buildStaticObj(sector, fname);
                if (w) have.set(fname, w);
            }
        }
    },

    gfxRefresh: async function(sector, zStr, itemsStr) {
        let drive = window.desktopDrive || this.currentPath.split(':')[0] || 'capflag';
        let sectorChanged = (this._loadedSector !== sector);

        if (sectorChanged) {
            this.currentPath = `${drive}:/w/${sector}`;
            window.map = sector;
            this._loadedSector = sector;
            this.lastRenderedItems = null;
            await this.ensureSectorCached(sector);
            this.renderSectorTiles(sector);
            this.renderSectorStaticObjects(sector);
        }

        let serverPlayerZ = this.decodeZ(zStr, this.gfxZBase);
        let oldPlayerQueue = (window.movingItems[window.playerItem] && window.movingItems[window.playerItem].queue)
            ? window.movingItems[window.playerItem].queue
            : [];

        // Only snap local playerZ to server when no local queued moves are in-flight
        let resolvedPlayerZ = (!isNaN(serverPlayerZ) && oldPlayerQueue.length === 0 && window.playerWalk === -1)
            ? serverPlayerZ
            : window.playerZ;

        if (!isNaN(resolvedPlayerZ) && resolvedPlayerZ >= 0) {
            window.playerZ = resolvedPlayerZ;
        }

        // Preserve local player's in-flight queue across refresh
        let nextMovingItems = {};
        if (window.playerItem && window.playerItem !== "Za") {
            nextMovingItems[window.playerItem] = {
                z: window.playerZ,
                queue: oldPlayerQueue,
                avatar: window.playerAvatar
            };
        }

        if (!sectorChanged && itemsStr === this.lastRenderedItems) {
            window.movingItems = nextMovingItems;
            this.renderCursor();
            return;
        }
        this.lastRenderedItems = itemsStr;

        // this is not needed, objects and tiles only change on scroll on/off
        // if (!sectorChanged) {
        //     this.syncSectorTiles(sector);
        //     this.syncSectorStaticObjects(sector);
        // }

        const iconsLayer = document.getElementById('icons-layer');

        // Pool of existing dynamic sprites, so unchanged ones can be reused rather than rebuilt
        let dynPool = new Map();
        let allDyn = [];
        let claimedDyn = new Set();
        if (iconsLayer) {
            allDyn = Array.from(iconsLayer.querySelectorAll('.dyn-sprite'));
            for (let el of allDyn) {
                let k = el.getAttribute('data-unique-id');
                if (k && !dynPool.has(k)) dynPool.set(k, el);
            }
        }
        let touchedStatic = new Set();


        let entries = itemsStr ? itemsStr.split('~').filter(Boolean) : [];
        let hasStaticObjs = new Set(this.mapObjs[sector] || []);
        let chatBubbles = [];

        for (let entry of entries) {
            if (entry.length < 4) continue;
            let iId = entry.substring(0, 2);

            // --- 0. CHAT BUBBLES (Vb[zStr][pubId][text]) ---
            if (iId === 'Vb') {
                if (entry.length > 8) {
                    let bZ = this.decodeZ(entry.substring(2, 4), this.gfxZBase);
                    let bPubId = entry.substring(4, 8);
                    let bText = entry.substring(8);
                    if (!isNaN(bZ) && bText) {
                        chatBubbles.push({ z: bZ, pubId: bPubId, text: bText });
                    }
                }
                continue;
            }

            // --- 1. PUNCH CODE MARKER INTERCEPTION (Vx, Vy, Xz) ---
            if (entry.length === 6 && (iId.charAt(0) === 'V' || iId.charAt(0) === 'X')) {
                let param1 = entry.substring(2, 4);
                let param2 = entry.substring(4, 6);

                if (iId === 'Vx') {
                    let objEl = document.querySelector(`.static-obj[data-orig-id="${param1}"]`);
                    if (objEl) {
                        touchedStatic.add(objEl);
                        objEl.setAttribute('data-dirty', '1');
                        if (objEl.getAttribute('data-id') !== param2) {
                            objEl.setAttribute('data-id', param2);
                            let zHex = objEl.getAttribute('data-zstr') || '00';
                            objEl.setAttribute('data-code', param2 + zHex + 'Za');
                            let img = objEl.querySelector('.icon-img');
                            if (img) img.src = `${this.gfxIconDir}${param2}.png`;
                        }
                    }
                } else if (iId === 'Vy') {
                    let objEl = document.querySelector(`.static-obj[data-orig-id="${param1}"]`);
                    if (objEl) {
                        touchedStatic.add(objEl);
                        objEl.setAttribute('data-dirty', '1');
                        let newZ = this.decodeZ(param2, this.gfxZBase);
                        if (objEl.getAttribute('data-z') !== String(newZ)) {
                            let nx = newZ % this.gridWide;
                            let ny = Math.floor(newZ / this.gridWide);
                            objEl.setAttribute('data-z', newZ);
                            objEl.setAttribute('data-zstr', param2);
                            let curId = objEl.getAttribute('data-id') || param1;
                            objEl.setAttribute('data-code', curId + param2 + 'Za');
                            objEl.style.left = ((nx / this.gridWide) * 100) + '%';
                            objEl.style.top = ((ny / this.gridTall) * 100) + '%';
                        }
                    }
                } else if (iId === 'Xz') {
                    let targetZ = this.decodeZ(param1, this.gfxZBase);
                    let tileCode = param2;
                    this.updateTileDOM(targetZ, tileCode);
                    if (this.mapTiles[sector]) {
                        let idx = targetZ * 2;
                        let m = this.mapTiles[sector];
                        while (m.length < idx + 2) m += 'Ga';
                        this.mapTiles[sector] = m.substring(0, idx) + tileCode + m.substring(idx + 2);
                        this.terrainCache = null;
                    }
                }
                continue;
            }

            // Skip static objects already rendered from sector cache
            if (entry.length === 6 && hasStaticObjs.has(entry)) {
                continue;
            }

            // --- 2. DYNAMIC ITEMS & PLAYERS ---
            let zHex = entry.substring(2, 4);
            let destZ = this.decodeZ(zHex, this.gfxZBase);
            if (isNaN(destZ)) continue;

            let pubId = entry.length >= 8 ? entry.substring(4, 8) : "";
            let avatar = entry.length > 8 ? entry.substring(8) : "";
            let moves = [];

            // Extract Q[nsew] movement trail if appended
            let qIdx = avatar.indexOf('Q');
            if (qIdx > -1) {
                let historyStr = avatar.substring(qIdx);
                avatar = avatar.substring(0, qIdx);
                moves = historyStr.match(/Q[nsew]/g) || [];
            }

            let isLocalPlayer = (iId === window.playerItem && (pubId === window.playerId || !window.playerId));
            if (isLocalPlayer) {
                let avatarChanged = (window.playerAvatar !== avatar);
                window.playerAvatar = avatar;
                if (nextMovingItems[window.playerItem]) {
                    nextMovingItems[window.playerItem].avatar = avatar;
                }
                if (avatarChanged && typeof window.renderInventory === 'function') {
                    window.renderInventory();
                }
                continue;
            }

            let uniqueId = pubId ? (iId + pubId) : (entry);
            let renderZ = destZ;

            if (avatar && moves.length > 0) {
                for (let k = moves.length - 1; k >= 0; k--) {
                    renderZ = this.reverseMoveZ(renderZ, moves[k]);
                }
                nextMovingItems[uniqueId] = {
                    z: renderZ,
                    destZ: destZ,
                    queue: moves,
                    avatar: avatar
                };
            }

            let x = renderZ % this.gridWide;
            let y = Math.floor(renderZ / this.gridWide);
            let labelText = this.getItemName(iId); // was: this.getItemName(iconId)

            let fullDosPath = `${drive}:/w/${sector}/${entry}`;

            // Reuse an existing sprite if it looks the same (same item, label & avatar).
            // Multi-tile T*/U* items are only reused when the entry is byte-identical,
            // because their size/offset is applied once in img.onload.
            let sig = iId + '|' + labelText + '|' + avatar;
            let prev = dynPool.get(uniqueId);
            let isMulti = (iId.charAt(0) === 'T' || iId.charAt(0) === 'U');
            if (prev && !claimedDyn.has(prev) && prev.getAttribute('data-sig') === sig &&
                (prev.getAttribute('data-code') === entry || (pubId && !isMulti))) {
                claimedDyn.add(prev);
                prev.setAttribute('data-code', entry);
                prev.setAttribute('data-path', fullDosPath);
                if (prev.getAttribute('data-z') !== String(renderZ)) {
                    prev.setAttribute('data-z', renderZ);
                    prev.style.left = ((x / this.gridWide) * 100) + '%';
                    prev.style.top = ((y / this.gridTall) * 100) + '%';
                }
                continue;
            }

            let wrap = this.buildSprite(iId, x, y, renderZ, labelText, fullDosPath, avatar);
            if (wrap) {
                wrap.classList.add('dyn-sprite');
                wrap.setAttribute('data-code', entry);
                wrap.setAttribute('data-unique-id', uniqueId);
                wrap.setAttribute('data-sig', sig);
                claimedDyn.add(wrap);
            }
        }

        // Remove dynamic sprites that are no longer present in the server state
        for (let el of allDyn) {
            if (!claimedDyn.has(el)) el.remove();
        }

        // Revert static objects whose Vx/Vy marker has expired (rebuild just those, in place)
        if (iconsLayer) {
            iconsLayer.querySelectorAll('.static-obj[data-dirty="1"]').forEach(el => {
                if (touchedStatic.has(el)) return;
                let base = el.getAttribute('data-base-code');
                let fresh = base ? this._buildStaticObj(sector, base) : null;
                if (fresh) el.replaceWith(fresh);
                else el.remove();
            });
        }

        window.movingItems = nextMovingItems;
        this.renderCursor();
        this.syncChatBubbles(chatBubbles);
        
    },

    // ========================================================================
    // LOOK MODE (Vl Global Radar Canvas)
    // ========================================================================

    gfxRenderGlobalCanvas: async function(myMap, myZ, playerData) {
        const wrapper = document.getElementById('desktop-wrapper') || document.getElementById('screen-wrapper');
        if (!wrapper) return;

        const sectorsY = "ABCDEFGH".split("");
        const parts = String(playerData || '').split('|');
        const pCSV = parts[0] || '';
        const visibleSectors = parts[1] || '';
        const knownSectors = parts[2] || visibleSectors;

        if (this.lastKnownSectors !== knownSectors) {
            this.terrainCache = null;
            this.lastKnownSectors = knownSectors;
        }

        const cWidth = 8 * this.gridWide * 4;
        const cHeight = 8 * this.gridTall * 4;

        if (!this.lookCanvas) {
            this.lookCanvas = document.createElement('canvas');
            this.lookCanvas.id = 'lookCanvas';
            this.lookCanvas.style.position = 'absolute';
            this.lookCanvas.style.top = '0';
            this.lookCanvas.style.left = '0';
            this.lookCanvas.style.width = '100%';
            this.lookCanvas.style.height = '100%';
            this.lookCanvas.style.imageRendering = 'pixelated';
            this.lookCanvas.style.zIndex = '2000';
            wrapper.appendChild(this.lookCanvas);
        }

        this.lookCanvas.width = cWidth;
        this.lookCanvas.height = cHeight;
        this.lookCanvas.style.display = 'block';
        const ctx = this.lookCanvas.getContext('2d');

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, cWidth, cHeight);

        const self = this;
        const secW = this.gridWide * 4;
        const secH = this.gridTall * 4;

        const drawPlayers = () => {
            const currentVisiblePlayers = {};
            if (pCSV) {
                pCSV.split('~').forEach(p => {
                    if (p.length < 6) return;
                    const id = p.substring(0, 2);
                    const sec = p.substring(2, 4);
                    const z = self.decodeZ(p.substring(4, 6), self.gfxZBase);
                    const uid = p.length >= 10 ? p.substring(6, 10) : p;

                    currentVisiblePlayers[uid] = { id, sec, z };

                    const myTeam = window.playerItem ? window.playerItem.substring(0, 2) : 'Za';
                    if (id !== myTeam && id >= 'Sa' && id < 'Ua' && p.length >= 10) {
                        self.lastKnownOpponents[uid] = { id, sec, z };
                    }
                });
            }

            for (const uid in self.lastKnownOpponents) {
                const opp = self.lastKnownOpponents[uid];
                if (!currentVisiblePlayers[uid] && visibleSectors.includes(opp.sec)) {
                    delete self.lastKnownOpponents[uid];
                }
            }

            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            for (const uid in self.lastKnownOpponents) {
                if (!currentVisiblePlayers[uid]) {
                    const opp = self.lastKnownOpponents[uid];
                    const sy = opp.sec.charCodeAt(0) - 65;
                    const sx = opp.sec.charCodeAt(1) - 97;
                    if (sy < 0 || sy > 7 || sx < 0 || sx > 7) continue;
                    const tx = opp.z % self.gridWide;
                    const ty = Math.floor(opp.z / self.gridWide);
                    ctx.fillStyle = '#FF0000';
                    ctx.fillText('?', (sx * secW) + (tx * 4) + 2, (sy * secH) + (ty * 4) + 3);
                }
            }

            const myTeam = window.playerItem ? window.playerItem.substring(0, 2) : 'Za';
            const myUid = window.playerId || "";

            for (const uid in currentVisiblePlayers) {
                const p = currentVisiblePlayers[uid];
                const sy = p.sec.charCodeAt(0) - 65;
                const sx = p.sec.charCodeAt(1) - 97;
                if (sy < 0 || sy > 7 || sx < 0 || sx > 7) continue;
                const tx = p.z % self.gridWide;
                const ty = Math.floor(p.z / self.gridWide);

                if (p.id === myTeam) {
                    if (uid === myUid) {
                        ctx.fillStyle = '#FFFF00';
                        ctx.fillRect((sx * secW) + (tx * 4) - 1, (sy * secH) + (ty * 4) - 1, 6, 6);
                    } else {
                        ctx.fillStyle = '#00FFFF';
                        ctx.fillRect((sx * secW) + (tx * 4), (sy * secH) + (ty * 4), 4, 4);
                    }
                } else {
                    ctx.fillStyle = '#FF0000';
                    ctx.fillRect((sx * secW) + (tx * 4), (sy * secH) + (ty * 4), 4, 4);
                }
            }
        };

        if (!this.terrainCache) {
            this.terrainCache = document.createElement('canvas');
            this.terrainCache.width = cWidth;
            this.terrainCache.height = cHeight;
            const tCtx = this.terrainCache.getContext('2d');
            tCtx.fillStyle = '#000000';
            tCtx.fillRect(0, 0, cWidth, cHeight);

            const drive = window.desktopDrive || this.currentPath.split(':')[0] || 'capflag';
            const dos = this.getDOS();
            const totalTiles = this.gridWide * this.gridTall;

            for (let sy = 0; sy < 8; sy++) {
                for (let sx = 0; sx < 8; sx++) {
                    const sectorId = sectorsY[sy] + String.fromCharCode(97 + sx);
                    if (!knownSectors.includes(sectorId)) continue;

                    if (!this.mapTiles[sectorId] && dos) {
                        let mData = await this.qdosLoadSafe(dos, `${drive}:/w/${sectorId}/m`);
                        if (mData) this.mapTiles[sectorId] = mData.replace(/\s+/g, '');
                    }

                    const data = this.mapTiles[sectorId];
                    if (!data) continue;

                    for (let t = 0; t < totalTiles; t++) {
                        const tileId = data.substring(t * 2, t * 2 + 2);
                        if (!tileId || tileId === 'Qf' || tileId === 'Za') continue;

                        const tx = t % this.gridWide;
                        const ty = Math.floor(t / this.gridWide);
                        const img = new Image();
                        img.src = `${this.gfxMapsDir}${tileId}.png`;
                        img.onload = function() {
                            tCtx.drawImage(img, (sx * secW) + (tx * 4), (sy * secH) + (ty * 4), 4, 4);
                            if (self.isLooking) {
                                ctx.drawImage(img, (sx * secW) + (tx * 4), (sy * secH) + (ty * 4), 4, 4);
                                drawPlayers();
                            }
                        };
                    }
                }
            }
        }

        ctx.drawImage(this.terrainCache, 0, 0);
        drawPlayers();
    },

    // ========================================================================
    // TERMINAL / LOCAL GFX COMMAND ROUTER
    // ========================================================================

    printTerminal: function(text) {
        let msg = String(text == null ? '' : text);
        if (!msg.endsWith('\n')) msg += '\n';
        if (window.parent && typeof window.parent.printDOS === 'function') {
            window.parent.printDOS(msg);
        } else if (window.parent && typeof window.parent.print === 'function') {
            window.parent.print(msg);
        } else if (typeof window.print === 'function') {
            window.print(msg);
        }
    },

    sendRemoteGfxCommand: async function(cmdStr) {
        if (!window.remoteQandylandUrl) return null;
        if (!window.cylonGfxSession) {
            this.printTerminal('Error: [.4]Not connected/logged in to server.[.]');
            return null;
        }
        try {
            let raw = await this.gfxPing('GFX:' + cmdStr);
            let res;
            try {
                res = JSON.parse(raw);
            } catch (e) {
                this.printTerminal(raw);
                return null;
            }
            if (res && res.output) {
                this.printTerminal(res.output);
            }
            return res;
        } catch (err) {
            this.printTerminal('Error: [.4]' + (err && err.message ? err.message : String(err)) + '[.]');
            return null;
        }
    },

    handleGfxCommand: async function(cmd, data) {
        let cmdStr = String(cmd || '').trim();
        let cmdLower = cmdStr.toLowerCase();
        let dataStr = String(data == null ? '' : data);

        // Support: gfx <drive> <mod|id> <item> [description]
        let subMatch = dataStr.match(/^\s*(id|mod)(?:\s+(.*))?$/i);
        if (subMatch && cmdLower !== 'id' && cmdLower !== 'mod') {
            let res = await this.handleGfxId(subMatch[2] || '', cmdStr);
            if (window.parent && typeof window.parent.printDOS === 'function') {
                window.parent.printDOS(res.output + '\n');
            } else if (window.parent && window.parent.print) {
                window.parent.print(res.output + '\n');
            }
            return;
        }

        switch (cmd) {
            case 'list': {
                let output = "[.2]Available GFX Servers:[.]\n\n";
                let dos = this.getDOS();

                let path = window.location.pathname;
                let dir = path.substring(0, path.lastIndexOf('/'));
                let fallbackUrl = window.location.origin !== "null" ? (window.location.origin + dir + '/qandyland.js') : "";

                let serverUrl = window.remoteQandylandUrl || fallbackUrl;
                let remoteFound = false;

                if (serverUrl.startsWith('http')) {
                    try {
                        let res = await fetch(serverUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `c=SYS:DRIVES` });
                        if (res.ok) {
                            let remoteDrives = await res.text();
                            if (remoteDrives.trim()) {
                                remoteDrives.split(',').forEach(d => {
                                    if (d.trim()) output += `  qandyland ${d.trim().replace(/\.gfx$/i, '')}\n`;
                                });
                                remoteFound = true;
                            }
                        }
                    } catch (e) {}
                }

                if (!remoteFound) output += "  [.4]qandyland unreachable[.]\n";

                let localFound = false;
                if (dos) {
                    let mnts = await dos.mounts();
                    let gfxMnts = mnts.filter(m => m.name.endsWith('.gfx') || m.name === 'capflag' || m.name === 'queville');
                    if (gfxMnts.length > 0) {
                        gfxMnts.forEach(m => output += `      local ${m.name.replace(/\.gfx$/i, '')}\n`);
                        localFound = true;
                    }
                }

                if (!localFound && !remoteFound) output = "(No GFX servers found)\n";
                if (window.parent && window.parent.print) window.parent.print(output);
                break;
            }

            case 'connect': {
                if (data) {
                    let parts = data.trim().split(/\s+/);
                    let url = parts[0];
                    let world = parts[1] || 'capflag';
                    await this.gfxConnect(url, world, world);
                    if (this.gfxCommandLog && window.parent && window.parent.print) {
                        window.parent.print(`[.3]Connected to GFX Server: ${url} (World: ${world})[.]\n`);
                    }
                } else if (window.parent && window.parent.print) {
                    window.parent.print(`[.4]GFX Error: 'gfx connect [url] [world]' required.[.]\n`);
                }
                break;
            }

            case 'login':
            case 'new': {
                if (!window.remoteQandylandUrl) {
                    if (window.parent && window.parent.print) window.parent.print(`[.4]GFX Error: Not connected to a Qandyland server.[.]\n`);
                    break;
                }
                let user = '', pass = '';
                if (data && typeof data === 'object') {
                    user = String(data.user || '').trim();
                    pass = String(data.pass || '');
                } else {
                    let trimmed = String(data || '').trim();
                    let sp = trimmed.search(/\s+/);
                    if (sp !== -1) {
                        user = trimmed.substring(0, sp);
                        pass = trimmed.substring(sp).replace(/^\s+/, '');
                    }
                }
                if (!user || !pass) {
                    if (window.parent && window.parent.print) window.parent.print(`[.4]Usage: gfx ${cmd} <username> <password>[.]\n`);
                    break;
                }
                await this.ensureSession();
                let verb = (cmd === 'login') ? 'LI' : 'LC';
                if (window.gfxDo === 'RF') window.gfxDo = '';
                window.gfxDo += `${verb}${user}--${pass}--`;
                if (!this.networkInterval) this.startNetworkTick();
                else if (!this.isSyncing) await this.networkTick();
                break;
            }

            case 'guest': {
                if (!window.remoteQandylandUrl) {
                    if (window.parent && window.parent.print) window.parent.print(`[.4]GFX Error: Not connected to a Qandyland server.[.]\n`);
                    break;
                }
                await this.ensureSession();
                if (window.gfxDo === 'RF') window.gfxDo = '';
                window.gfxDo += 'LG';
                if (!this.networkInterval) this.startNetworkTick();
                else if (!this.isSyncing) await this.networkTick();
                break;
            }

            case 'logout': {
                if (!window.remoteQandylandUrl) {
                    if (window.parent && window.parent.print) window.parent.print(`[.4]GFX Error: Not connected to a Qandyland server.[.]\n`);
                    break;
                }
                if (!window.cylonGfxSession) {
                    if (typeof window.serverdown === 'function') window.serverdown('LO--');
                    break;
                }
                if (window.gfxDo === 'RF') window.gfxDo = '';
                window.gfxDo += 'LO';
                if (!this.isSyncing) await this.networkTick();
                break;
            }

            case 'refresh':
                if (window.remoteQandylandUrl) {
                    this._loadedSector = null;
                    this.lastRenderedItems = null;
                    this.terrainCache = null;
                    if (!this.isSyncing) await this.networkTick();
                    if (this.gfxCommandLog) this.printTerminal('[.3]GFX Engine: Desktop Refreshed.[.]');
                    break;
                }
                await this.init(this.currentPath);
                if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.3]GFX Engine: Desktop Refreshed.[.]\n`);
                break;

            case 'tile':
                if (window.remoteQandylandUrl) {
                    let tArg = data ? data.trim() : '';
                    let res = await this.sendRemoteGfxCommand(tArg ? ('tile ' + tArg) : 'tile');
                    if (res && res.ok && tArg && res.sector && res.tile !== undefined && res.z !== undefined) {
                        if (!this.mapTiles[res.sector]) {
                            this.mapTiles[res.sector] = 'Za'.repeat(this.gridWide * this.gridTall);
                        }
                        let m = this.mapTiles[res.sector];
                        let idx = res.z * 2;
                        while (m.length < idx + 2) m += 'Za';
                        this.mapTiles[res.sector] = m.substring(0, idx) + res.tile + m.substring(idx + 2);
                        this.terrainCache = null;
                        this.updateTileDOM(res.z, res.tile);
                    }
                    break;
                }
                if (typeof this.setTileAtCursor === 'function') {
                    await this.setTileAtCursor(data);
                    this.renderScreen();
                }
                break;

            case 'fill': {
                let fillArg = data ? data.trim() : '';
                let isOff = !fillArg || fillArg.toLowerCase() === 'off' || fillArg.toLowerCase() === 'none';

                if (window.remoteQandylandUrl) {
                    let res = await this.sendRemoteGfxCommand(isOff ? 'fill' : ('fill ' + fillArg.substring(0, 2)));
                    if (res && res.ok) {
                        this.fillTileCode = res.fill || null;
                    } else if (isOff) {
                        this.fillTileCode = null;
                    }
                    break;
                }

                if (!isOff) {
                    this.fillTileCode = fillArg.substring(0, 2);
                    if (this.gfxCommandLog) {
                        this.printTerminal(`[.4]GFX Fill Mode ENGAGED: brush set to [${this.fillTileCode}][.]`);
                    }
                } else {
                    this.fillTileCode = null;
                    if (this.gfxCommandLog) {
                        this.printTerminal(`[.2]GFX Fill Mode DISABLED.[.]`);
                    }
                }
                break;
            }

            case 'tele':
                if (window.remoteQandylandUrl) {
                    if (!data || !data.trim()) {
                        this.printTerminal('[.4]Usage: gfx tele <sector> [z][.]');
                        break;
                    }
                    let res = await this.sendRemoteGfxCommand('tele ' + data.trim());
                    if (res && res.ok && res.sector) {
                        let drive = window.desktopDrive || this.currentPath.split(':')[0] || 'queville';
                        window.playerWalk = -1;
                        window.playerDo = '';
                        window.playerZ = res.z;
                        window.map = res.sector;
                        this.currentPath = `${drive}:/w/${res.sector}`;
                        this._loadedSector = null;
                        this.lastRenderedItems = null;
                        if (!this.isSyncing) await this.networkTick();
                    }
                    break;
                }
                if (data) {
                    let drive = this.currentPath.split(':')[0] || 'ram';
                    await this.init(`${drive}:/w/${data}`);
                    await this.persistState(`${drive}:/a/gfxSector`, data);
                    if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.3]Teleported to sector: ${data}[.]\n`);
                }
                break;

            case 'obj':
                if (window.remoteQandylandUrl) {
                    let res = await this.sendRemoteGfxCommand('obj ' + String(data || '').trim());
                    if (res && res.ok && res.filename && res.sector) {
                        let list = this.mapObjs[res.sector] || [];
                        let keyPrefix = res.filename.substring(0, 4);
                        list = list.filter(f => !(f.length === 6 && f.substring(0, 4) === keyPrefix));
                        list.push(res.filename);
                        this.mapObjs[res.sector] = list;
                        this.renderSectorStaticObjects(res.sector);
                        this.lastRenderedItems = null;
                        if (!this.isSyncing) await this.networkTick();
                    }
                    break;
                }
                if (data) {
                    let parts = data.trim().split(/\s+/);
                    let id = parts[0];
                    let dataField = parts[1];
                    if (id && id.length > 2 && !dataField) {
                        dataField = id.substring(2);
                        id = id.substring(0, 2);
                    } else if (!dataField) {
                        dataField = 'Za';
                    }
                    if (id && id.length === 2) {
                        let zHex = this.encodeZ(window.playerZ, this.gfxZBase);
                        dataField = dataField.substring(0, 2).padEnd(2, 'a');
                        let filename = id + zHex + dataField;
                        let pathPrefix = this.currentPath.endsWith('/') ? this.currentPath : this.currentPath + '/';
                        await this.persistState(`${pathPrefix}${filename}`, "\\n");
                        if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.4]GFX Engine: Created object '${filename}' at Z:${window.playerZ}[.]\n`);
                        this.renderScreen();
                    } else if (window.parent.print) {
                        window.parent.print(`[.4]GFX Error: 'gfx obj [2-char id] [optional 2-char data]' required.[.]\n`);
                    }
                }
                break;

            case 'item':
                if (window.remoteQandylandUrl) {
                    let res = await this.sendRemoteGfxCommand('item ' + String(data || '').trim());
                    if (res && res.ok) {
                        this.lastRenderedItems = null;
                        if (!this.isSyncing) await this.networkTick();
                    }
                    break;
                }
                if (data) {
                    let parts = data.trim().split(/\s+/);
                    let id = parts[0];
                    if (id && id.length >= 2) {
                        id = id.substring(0, 2);
                        let zHex = this.encodeZ(window.playerZ, this.gfxZBase);
                        let filename = id + zHex;
                        let pathPrefix = this.currentPath.endsWith('/') ? this.currentPath : this.currentPath + '/';
                        await this.persistState(`${pathPrefix}${filename}`, "\\n");
                        if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.4]GFX Engine: Created item '${filename}' at Z:${window.playerZ}[.]\n`);
                        this.renderScreen();
                    } else if (window.parent.print) {
                        window.parent.print(`[.4]GFX Error: 'gfx item [2-char id]' required.[.]\n`);
                    }
                }
                break;

            case 'save': {

                let targetSectorArg = data ? data.trim() : '';
                let res = await this.sendRemoteGfxCommand(targetSectorArg ? ('save ' + targetSectorArg) : 'save');
                if (!res || !res.ok || !res.sector || !res.files) break;

                let dos = this.getDOS();
                if (!dos) {
                    this.printTerminal('Error: [.4]CylonDOS is not available.[.]');
                    break;
                }

                let drive = window.desktopDrive || this.currentPath.split(':')[0] || 'queville';
                let wDir = `${drive}:/w`;
                let sectorDir = `${wDir}/${res.sector}`;

                try {
                    if (!(await dos.exists(wDir))) {
                        await dos.mkdir(wDir);
                    }
                    if (!(await dos.exists(sectorDir))) {
                        await dos.mkdir(sectorDir);
                    }

                    // Remove local files in /w/<sector>/ that no longer exist on the server (e.g. deleted via gfx del)
                    let existing = [];
                    try { existing = await dos.dir(sectorDir); } catch (e) { existing = []; }
                    let removedCount = 0;
                    for (let entry of existing) {
                        if (entry.type !== 'file' || entry.readOnly) continue;
                        let fname = entry.name.substring(entry.name.lastIndexOf('/') + 1);
                        if (!fname || fname === '_dir.sys!' || fname.startsWith('_')) continue;
                        if (!Object.prototype.hasOwnProperty.call(res.files, fname)) {
                            await dos.delete(`${sectorDir}/${fname}`);
                            removedCount++;
                        }
                    }

                    // Write all current server sector files to the local CylonDOS drive
                    let savedCount = 0;
                    for (let fname of Object.keys(res.files)) {
                        await dos.save(`${sectorDir}/${fname}`, res.files[fname]);
                        savedCount++;
                    }

                    // Keep the in-memory sector cache in sync
                    if (Object.prototype.hasOwnProperty.call(res.files, 'm')) {
                        let tData = String(res.files.m || '').replace(/\s+/g, '');
                        let expectedLen = this.gridWide * this.gridTall * 2;
                        if (tData.length < expectedLen) {
                            tData += 'Za'.repeat(Math.ceil((expectedLen - tData.length) / 2));
                        }
                        this.mapTiles[res.sector] = tData;
                        this.terrainCache = null;
                    }

                    let staticList = [];
                    for (let fname of Object.keys(res.files)) {
                        if (fname === 'm' || fname === 'e' || fname === 't') continue;
                        let lead = fname.charAt(0);
                        if (fname.length === 6 && lead !== 'V' && lead !== 'X') {
                            staticList.push(fname);
                        }
                    }
                    this.mapObjs[res.sector] = staticList;

                    if (res.sector === window.map) {
                        this.renderSectorTiles(res.sector);
                        this.renderSectorStaticObjects(res.sector);
                        this.lastRenderedItems = null;
                        if (!this.isSyncing) await this.networkTick();
                    }

                    let msg = `Saved ${savedCount} file(s) to ${sectorDir}/`;
                    if (removedCount > 0) msg += ` (removed ${removedCount} stale file(s))`;
                    this.printTerminal(msg);
                } catch (err) {
                    this.printTerminal('Error: [.4]' + (err && err.message ? err.message : String(err)) + '[.]');
                }
                break;
            }

            case 'del':
            case 'rm':
                if (window.remoteQandylandUrl) {
                    let res = await this.sendRemoteGfxCommand('del ' + String(data || '').trim());
                    if (res && res.ok && res.sector && Array.isArray(res.deleted)) {
                        if (this.mapObjs[res.sector]) {
                            this.mapObjs[res.sector] = this.mapObjs[res.sector].filter(f => !res.deleted.includes(f));
                            this.renderSectorStaticObjects(res.sector);
                        }
                        this.lastRenderedItems = null;
                        if (!this.isSyncing) await this.networkTick();
                    }
                    break;
                }
                this.printTerminal('[.4]gfx del is only available in remote server mode (use the context menu locally).[.]');
                break;

            case 'code':
            case 'exits':
            case 'sector':
                if (window.remoteQandylandUrl) {
                    await this.sendRemoteGfxCommand(cmd + (data ? (' ' + data.trim()) : ''));
                    break;
                }
                this.printTerminal(`[.4]gfx ${cmd} is only available in remote server mode.[.]`);
                break;

            case 'id':
            case 'mod': {
                if (window.remoteQandylandUrl) {
                    await this.sendRemoteGfxCommand(cmd + (data ? (' ' + data.trim()) : ''));
                    break;
                }
                let res = await this.handleGfxId(data, null);
                this.printTerminal(res.output);
                break;
            }
            
            case 'export': {
                if (!window.remoteQandylandUrl) {
                    this.printTerminal('[.4]gfx export requires a remote Qandyland connection (use "export" for local drives).[.]');
                    break;
                }

                let rawArgs = String(data || '').trim();
                let tokens = rawArgs ? rawArgs.split(/\s+/) : [];
                let forceOverwrite = false;
                let target = null;

                for (let t of tokens) {
                    if (t === '-y' || t === '--yes' || t === '-f' || t === '--force') {
                        forceOverwrite = true;
                    } else if (!target) {
                        target = t;
                    }
                }

                if (!target) {
                    this.printTerminal('Usage: gfx export <c> | gfx export <filename.gfx> [-y]');
                    break;
                }

                // 1. Pre-check local file existence before pulling from server
                let dos = this.getDOS();
                if (target !== '<c>') {
                    if (!dos) {
                        this.printTerminal('Error: [.4]CylonDOS is not available.[.]');
                        break;
                    }
                    let alreadyExists = false;
                    try { alreadyExists = await dos.exists(target); } catch (e) {}
                    if (alreadyExists && !forceOverwrite) {
                        let safeName = String(target).replace(/[&<>'"]/g, c => ({
                            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
                        }[c]));
                        let warnHtml =
                            `<div style="padding:12px 16px; text-align:center; font-family:var(--font-face,monospace);">` +
                            `<div style="margin-bottom:6px;">File exists: <strong>${safeName}</strong></div>` +
                            `<div style="font-size:12px;">-y to over-write</div>` +
                            `</div>`;
                        if (typeof window.pop === 'function') window.pop(warnHtml, 'center');
                        this.printTerminal(`File exists: ${target} (-y to over-write)`);
                        break;
                    }
                }

                // 2. Fetch filtered archive from qandyland.js
                let res = await this.sendRemoteGfxCommand('export');
                if (!res || !res.ok || !res.archive) break;

                // 3. Output to clipboard (<c>) or save to local CylonDOS drive
                if (target === '<c>') {
                    let clip = (window.parent && window.parent.navigator && window.parent.navigator.clipboard)
                        ? window.parent.navigator.clipboard
                        : navigator.clipboard;

                    let copied = false;
                    if (clip && typeof clip.writeText === 'function') {
                        try {
                            await clip.writeText(res.archive);
                            copied = true;
                        } catch (e) {
                            copied = false;
                        }
                    }

                    if (copied) {
                        this.printTerminal('Exported map copied to clipboard.');
                    } else {
                        // Browser blocked async clipboard write; provide a 1-click gesture popup
                        try {
                            if (window.parent && window.parent !== window) {
                                window.parent._qandyPendingGfxExport = res.archive;
                            } else {
                                window._qandyPendingGfxExport = res.archive;
                            }
                        } catch (e) {}

                        let copyBtnHtml =
                            `<div style="padding:12px 16px; text-align:center; font-family:var(--font-face,monospace);">` +
                            `<div style="margin-bottom:8px;">Export ready (${res.archive.length} bytes)</div>` +
                            `<button type="button" onclick="(function(){` +
                                `var txt=window._qandyPendingGfxExport||'';` +
                                `if(navigator.clipboard&&txt){navigator.clipboard.writeText(txt);}` +
                                `delete window._qandyPendingGfxExport;` +
                                `if(window.hpop)window.hpop();` +
                            `})()" style="padding:6px 12px; cursor:pointer; background:var(--sel-bg,#333); color:var(--sel-fg,#0f0); border:1px solid var(--fg-color,#0f0); font-family:inherit;">Copy to Clipboard</button>` +
                            `</div>`;
                        if (typeof window.pop === 'function') window.pop(copyBtnHtml, 'center');
                        this.printTerminal('Click "Copy to Clipboard" in the popup to finish copying.');
                    }
                } else {
                    try {
                        await dos.save(target, res.archive);
                        this.printTerminal('Saved remote export to ' + target);
                    } catch (err) {
                        this.printTerminal('Error: [.4]' + (err && err.message ? err.message : String(err)) + '[.]');
                    }
                }
                break;
            }

            case 'edit': {
                let dos = this.getDOS();
                let zStr = this.encodeZ(window.playerZ, this.gfxZBase || 10);
                let trimmedEdit = dataStr.trim();
                let editMatch = trimmedEdit ? trimmedEdit.match(/^(\S+)(?:\s+([\s\S]+))?$/) : null;
                let objId = editMatch ? editMatch[1] : null;
                let newCode = editMatch ? editMatch[2] : undefined;

                if (objId && !/^[A-Z][A-Za-z0-9_()[\]{}^,:;+\-=%@]$/.test(objId)) {
                    this.printTerminal('Usage: gfx edit <2-char id> [punchcode|null]');
                    break;
                }

                // --- REMOTE QANDYLAND MODE ---
                if (window.remoteQandylandUrl) {
                    if (!window.cylonGfxSession) {
                        this.printTerminal('Error: [.4]Not connected/logged in to server.[.]');
                        break;
                    }

                    if (!objId) {
                        let atZ = (this.mapObjs[window.map] || []).filter(f =>
                            f.length === 6 && f.substring(2, 4) === zStr
                        );
                        if (atZ.length === 1) {
                            objId = atZ[0].substring(0, 2);
                        } else if (atZ.length > 1) {
                            this.printTerminal('Multiple objects at Z:' + window.playerZ + ' (' +
                                atZ.map(f => f.substring(0, 2)).join(', ') + '). Specify: gfx edit <2-char id>');
                            break;
                        } else {
                            this.printTerminal('Usage: gfx edit <2-char id> [punchcode|null]');
                            break;
                        }
                    }

                    // Inline edit: gfx edit <id> <punchcode|null>
                    if (newCode !== undefined) {
                        let res = await this.sendRemoteGfxCommand('code ' + objId + ' ' + newCode);
                        if (res && res.ok && dos && res.sector && res.filename) {
                            let cacheDrive = window.desktopDrive || this.currentPath.split(':')[0];
                            try {
                                await dos.save(`${cacheDrive}:/w/${res.sector}/${res.filename}`, newCode === 'null' ? '' : newCode);
                            } catch (e) {}
                        }
                        break;
                    }

                    // Visual compiler edit: fetch live code from server, then open cylon-gfx-compiler.htm
                    let res = null;
                    try {
                        let raw = await this.gfxPing('GFX:code ' + objId);
                        res = JSON.parse(raw);
                    } catch (err) {
                        this.printTerminal('Error: [.4]' + (err && err.message ? err.message : String(err)) + '[.]');
                        break;
                    }

                    if (!res || !res.ok) {
                        this.printTerminal((res && res.output) || 'Error: [.4]Failed to load object punch code.[.]');
                        break;
                    }

                    if (!dos) {
                        this.printTerminal('Error: [.4]CylonDOS is not available.[.]');
                        break;
                    }

                    let cacheDrive = window.desktopDrive || this.currentPath.split(':')[0] || 'queville';
                    let targetPayload = {
                        mode: 'remote',
                        path: `${cacheDrive}:/w/${res.sector}/${res.filename}`,
                        remoteUrl: window.remoteQandylandUrl,
                        remoteDrive: window.gfxDrive || cacheDrive,
                        session: window.cylonGfxSession,
                        sector: res.sector,
                        filename: res.filename,
                        itemId: objId,
                        code: res.code != null ? res.code : ''
                    };
                    await dos.save('cylon:/a/gfxEditTarget', JSON.stringify(targetPayload));

                    if (typeof window.CylonCommand === 'function') {
                        await window.CylonCommand('cylon-gfx-compiler.htm');
                    } else if (window.parent && typeof window.parent.PageOpen === 'function') {
                        await window.parent.PageOpen('cylon-gfx-compiler.htm');
                    } else if (typeof window.PageOpen === 'function') {
                        await window.PageOpen('cylon-gfx-compiler.htm');
                    }
                    break;
                }

                // --- LOCAL .GFX DRIVE MODE ---
                if (!dos) {
                    this.printTerminal('Error: [.4]CylonDOS is not available.[.]');
                    break;
                }

                let localDir = this.currentPath.replace(/\/$/, '');
                let drive = localDir.split(':')[0] || 'ram';
                let files = [];
                try { files = await dos.dir(localDir); } catch (e) { files = []; }

                let matches = [];
                for (let f of files) {
                    if (f.type !== 'file') continue;
                    let fname = f.name.substring(f.name.lastIndexOf('/') + 1);
                    if (fname === 'm' || fname === 't' || fname === 'e' || fname.length < 4) continue;
                    let fId = fname.substring(0, 2);
                    let fZ = fname.substring(2, 4);
                    let fPub = fname.length >= 8 ? fname.substring(4, 8) : '';
                    if (fId === window.playerItem && (fPub === window.playerId || !window.playerId)) continue;
                    if (this.decodeZ(fZ, this.gfxZBase || 10) !== window.playerZ) continue;
                    if (objId && fId !== objId) continue;
                    matches.push(fname);
                }

                if (!matches.length) {
                    this.printTerminal('Error: [.4]No object' + (objId ? ' "' + objId + '"' : '') + ' found at Z:' + window.playerZ + '.[.]');
                    break;
                }
                if (matches.length > 1) {
                    this.printTerminal('Multiple objects at Z:' + window.playerZ + ' (' +
                        matches.map(f => f.substring(0, 2)).join(', ') + '). Specify: gfx edit <2-char id>');
                    break;
                }

                let fullPath = `${localDir}/${matches[0]}`;

                if (newCode !== undefined) {
                    let saveVal = (newCode === 'null') ? '' : newCode;
                    await dos.save(fullPath, saveVal);
                    this.printTerminal('Updated punch code for ' + fullPath);
                    break;
                }

                await dos.save('cylon:/a/gfxEditTarget', fullPath);
                if (typeof window.CylonCommand === 'function') {
                    await window.CylonCommand('cylon-gfx-compiler.htm');
                } else if (window.parent && typeof window.parent.PageOpen === 'function') {
                    await window.parent.PageOpen('cylon-gfx-compiler.htm');
                } else if (typeof window.PageOpen === 'function') {
                    await window.PageOpen('cylon-gfx-compiler.htm');
                }
                break;
            }

            case 'say': {
                if (!window.remoteQandylandUrl) {
                    if (window.parent && window.parent.print) window.parent.print(`[.4]GFX Error: Not connected to a Qandyland server.[.]\n`);
                    break;
                }
                let msg = String(data == null ? '' : data)
                    .replace(/[\x00-\x1f\x7f]/g, ' ')
                    .replace(/~/g, '-')
                    .replace(/--/g, '-')
                    .trim()
                    .slice(0, 80);
                if (!msg) break;
                if (!window.cylonGfxSession || !window.playerItem || window.playerItem.startsWith('Za')) {
                    if (window.parent && window.parent.print) window.parent.print(`[.4]Login first before chatting.[.]\n`);
                    break;
                }
                if (window.gfxDo === 'RF') window.gfxDo = '';
                window.gfxDo += 'Vb' + msg + '--';
                if (!this.networkInterval) this.startNetworkTick();
                else if (!this.isSyncing) await this.networkTick();
                break;
            }


        }
    },

    // ========================================================================
    // SPRITE & AVATAR RENDERING
    // ========================================================================

    buildAvatarOrIcon: function(container, iconId, avatarStr) {
        let overlayId = null;
        let registerVal = null;

        while (avatarStr) {
            let regMatch = avatarStr.match(/\-([0-9]{2})$/);
            if (regMatch) {
                registerVal = parseInt(regMatch[1], 10);
                avatarStr = avatarStr.substring(0, avatarStr.length - 3);
                continue;
            }
            let itemMatch = avatarStr.match(/\-([A-Z][A-Za-z0-9])$/);
            if (itemMatch) {
                overlayId = itemMatch[1];
                avatarStr = avatarStr.substring(0, avatarStr.length - 3);
                continue;
            }
            break;
        }

        if (!avatarStr || avatarStr.length < 2) {
            let img = document.createElement('img');
            img.src = this.gfxIconDir + iconId + '.png';
            img.className = 'icon-img';
            img.style.maxWidth = '60%';
            img.style.maxHeight = '55%';
            img.style.objectFit = 'contain';
            img.style.imageRendering = 'pixelated';
            img.style.filter = 'drop-shadow(2px 2px 2px rgba(0,0,0,0.8))';
            img.onerror = function() { this.src = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4="; };
            container.appendChild(img);
            return img;
        }

        const typeMap = {
            'A': 'head', 'B': 'head', 'E': 'head', 'F': 'head',
            'C': 'body', 'D': 'body', 'G': 'body', 'H': 'body',
            'I': 'hat',  'J': 'hat',  'K': 'hat',  'L': 'hat',
            'M': 'sword', 'N': 'sword',
            'O': 'shield', 'P': 'shield'
        };
        const partOrder = ['body', 'head', 'hat', 'sword', 'shield'];
        const currentParts = {};

        const facingLeft = /^[ACEG]/.test(avatarStr);
        const wornMap = {
            'L': { type: 'hat',    left: 'I', right: 'J' },
            'M': { type: 'sword',  left: 'M', right: 'N' },
            'N': { type: 'shield', left: 'O', right: 'P' }
        };

        for (let i = 0; i < avatarStr.length; i += 2) {
            let partCode = avatarStr.substring(i, i + 2);
            const c0 = partCode.charAt(0);
            const c1 = partCode.charAt(1);

            let type = typeMap[c0];
            if (wornMap[c0] && c1 >= 'a' && c1 <= 'z') {
                const spec = wornMap[c0];
                type = spec.type;
                const num = c1.charCodeAt(0) - 97; // 'a'->0, 'b'->1, 'c'->2, 'd'->3 ...
                const suffix = (num >= 0 && num <= 9) ? String(num) : c1;
                partCode = (facingLeft ? spec.left : spec.right) + suffix;
            }

            if (type && !currentParts[type]) {
                currentParts[type] = partCode;
            }
        }

        partOrder.forEach((type, index) => {
            const partCode = currentParts[type];
            if (partCode) {
                let el = document.createElement('img');
                el.src = this.gfxCharDir + partCode + '.png';
                el.style.position = 'absolute';
                el.style.width = '100%';
                el.style.height = '200%';
                el.style.bottom = '10%';
                el.style.left = '0';
                el.style.objectFit = 'contain';
                el.style.zIndex = (10 + index).toString();
                el.style.imageRendering = 'pixelated';
                container.appendChild(el);
            }
        });

        if (overlayId) {
            let el = document.createElement('img');
            el.src = this.gfxIconDir + overlayId + '.png';
            el.style.position = 'absolute';
            el.style.width = '100%';
            el.style.height = '100%';
            el.style.bottom = '100%';
            el.style.left = '0';
            el.style.objectFit = 'contain';
            el.style.zIndex = '20';
            el.style.imageRendering = 'pixelated';
            container.appendChild(el);
        }

        if (registerVal !== null) {
            let meterEl = document.createElement('div');
            meterEl.style.position = 'absolute';
            meterEl.style.width = '100%';
            meterEl.style.height = '8px';
            meterEl.style.bottom = '180%';
            meterEl.style.left = '0';
            meterEl.style.zIndex = '25';

            let greenW = registerVal;
            let redW = 100 - registerVal;

            meterEl.innerHTML = `
                <img src="${this.gfxIconDir}Zn.png" style="position:absolute; left:0; top:0; height:100%; width:${greenW}%;" />
                <img src="${this.gfxIconDir}Zm.png" style="position:absolute; right:0; top:0; height:100%; width:${redW}%;" />
            `;
            container.appendChild(meterEl);
        }
        return null;
    },

    // Local Desktop Mode full directory renderer
    renderScreen: async function() {
        let dos = this.getDOS();
        const iconsLayer = document.getElementById('icons-layer');
        const tilesLayer = document.getElementById('tiles-layer');
        if (!iconsLayer) return;

        if (this.gfxGrid) {
            iconsLayer.style.backgroundImage = `
                linear-gradient(to right, rgba(255, 255, 255, 0.15) 1px, transparent 1px),
                linear-gradient(to bottom, rgba(255, 255, 255, 0.15) 1px, transparent 1px)
            `;
            iconsLayer.style.backgroundSize = `${100 / this.gridWide}% ${100 / this.gridTall}%`;
            iconsLayer.style.borderRight = '1px solid rgba(255, 255, 255, 0.15)';
            iconsLayer.style.borderBottom = '1px solid rgba(255, 255, 255, 0.15)';
            iconsLayer.style.boxSizing = 'border-box';
        } else {
            iconsLayer.style.backgroundImage = 'none';
            iconsLayer.style.borderRight = 'none';
            iconsLayer.style.borderBottom = 'none';
        }

        Array.from(iconsLayer.children).forEach(child => {
            if (child.id !== 'gfx-sys-cursor') child.remove();
        });

        if (tilesLayer) tilesLayer.innerHTML = '';

        let tData = "";
        try { tData = await dos.load(`${this.currentPath}/m`); } catch (e) {}

        if (tData) {
            tData = tData.replace(/\s+/g, '');
            let expectedLen = this.gridWide * this.gridTall * 2;
            if (tData.length < expectedLen) {
                let needed = (expectedLen - tData.length) / 2;
                if (needed > 0) tData += 'Za'.repeat(Math.ceil(needed));
            }
            if (tilesLayer) {
                for (let z = 0; z < this.gridWide * this.gridTall; z++) {
                    let code = tData.substring(z * 2, z * 2 + 2);
                    if (code && code !== 'Za') {
                        let x = z % this.gridWide;
                        let y = Math.floor(z / this.gridWide);

                        let img = document.createElement('img');
                        img.src = `${this.gfxTileDir}${code}.png`;
                        img.onerror = function() { this.style.display = 'none'; };
                        img.style.position = 'absolute';
                        img.style.left = ((x / this.gridWide) * 100) + '%';
                        img.style.top = ((y / this.gridTall) * 100) + '%';
                        img.style.width = ((1 / this.gridWide) * 100) + '%';
                        img.style.height = ((1 / this.gridTall) * 100) + '%';
                        img.style.imageRendering = 'pixelated';
                        img.id = `gfx-tile-${z}`;
                        tilesLayer.appendChild(img);
                    }
                }
            }
        }

        let files = [];
        try { files = await dos.dir(this.currentPath); } catch (e) { return; }

        let drive = this.currentPath.split(':')[0] || 'ram';

        for (let file of files) {
            let filename = file.name.substring(file.name.lastIndexOf('/') + 1);
            if (filename === 'm' || filename === 't' || filename === 'e' || file.type !== 'file') continue;

            if (filename.length >= 4) {
                let iconId = filename.substring(0, 2);
                let zHex = filename.substring(2, 4);
                let pubId = filename.length >= 8 ? filename.substring(4, 8) : "";
                let avatarStr = filename.length > 8 ? filename.substring(8) : "";

                let isLocalPlayer = (iconId === window.playerItem && (pubId === window.playerId || !window.playerId));
                if (isLocalPlayer) {
                    window.playerAvatar = avatarStr;
                    continue;
                }

                let labelText = this.getItemName(iconId);
                let z = this.decodeZ(zHex, this.gfxZBase);
                if (isNaN(z)) continue;

                let x = z % this.gridWide;
                let y = Math.floor(z / this.gridWide);
                let fullDosPath = `${drive}:/${file.name.replace(/^\/+/, '')}`;
                this.buildSprite(iconId, x, y, z, labelText, fullDosPath, avatarStr);
            }
        }

        this.renderCursor();
    },

    buildSprite: function(iconId, x, y, z, labelText, fullPath, avatarStr) {
        const iconsLayer = document.getElementById('icons-layer');
        if (!iconsLayer) return null;
        const self = this;

        let wrap = document.createElement('div');
        wrap.className = 'icon-wrap';

        wrap.setAttribute('data-z', z);
        wrap.setAttribute('data-path', fullPath);
        wrap.setAttribute('data-label', labelText);

        wrap.style.left = ((x / this.gridWide) * 100) + '%';
        wrap.style.top = ((y / this.gridTall) * 100) + '%';
        wrap.style.width = ((1 / this.gridWide) * 100) + '%';
        wrap.style.height = ((1 / this.gridTall) * 100) + '%';

        if (this.gfxGrid) {
            wrap.style.border = '1px dashed rgba(0, 255, 255, 0.4)';
            wrap.style.boxSizing = 'border-box';
        }

        let visualContainer = document.createElement('div');
        visualContainer.style.position = 'relative';
        visualContainer.style.width = '100%';
        visualContainer.style.height = '100%';
        visualContainer.style.display = 'flex';
        visualContainer.style.justifyContent = 'center';
        visualContainer.style.alignItems = 'center';

        let img = this.buildAvatarOrIcon(visualContainer, iconId, avatarStr);

        let lbl = document.createElement('div');
        lbl.className = 'icon-label';
        lbl.textContent = labelText;

        if (img && (iconId.charAt(0) === 'T' || iconId.charAt(0) === 'U')) {
            img.onload = function() {
                let tilesX = Math.round(this.naturalWidth / 32);
                let tilesY = Math.round(this.naturalHeight / 32);

                if (tilesX > 1 || tilesY > 1) {
                    wrap.style.width = ((tilesX / self.gridWide) * 100) + '%';
                    wrap.style.height = ((tilesY / self.gridTall) * 100) + '%';
                    wrap.style.left = (((x - tilesX + 1) / self.gridWide) * 100) + '%';
                    wrap.style.top = (((y - tilesY + 1) / self.gridTall) * 100) + '%';

                    img.style.maxWidth = '100%';
                    img.style.maxHeight = '100%';
                    img.style.width = '100%';
                    img.style.height = '100%';
                    img.style.objectFit = 'fill';

                    lbl.style.position = 'absolute';
                    lbl.style.bottom = '5px';
                }
            };
        }

        wrap.appendChild(visualContainer);
        wrap.appendChild(lbl);
        iconsLayer.appendChild(wrap);
        return wrap;
    },

    renderCursor: function() {
        const iconsLayer = document.getElementById('icons-layer');
        if (!iconsLayer) return;

        let transTime = Math.max(0.05, (this.gfxCycle * 0.75) / 1000);

        let cursorEl = document.getElementById('gfx-sys-cursor');
        if (!cursorEl) {
            cursorEl = document.createElement('div');
            cursorEl.id = 'gfx-sys-cursor';
            cursorEl.style.position = 'absolute';
            cursorEl.style.pointerEvents = 'none';
            cursorEl.style.zIndex = '1000';
            cursorEl.style.display = 'flex';
            cursorEl.style.justifyContent = 'center';
            cursorEl.style.alignItems = 'center';
            iconsLayer.appendChild(cursorEl);
        }

        cursorEl.style.transition = `top ${transTime}s linear, left ${transTime}s linear`;

        let z = Math.max(0, window.playerZ || 0);
        let x = z % this.gridWide;
        let y = Math.floor(z / this.gridWide);

        cursorEl.style.left = ((x / this.gridWide) * 100) + '%';
        cursorEl.style.top = ((y / this.gridTall) * 100) + '%';
        cursorEl.style.width = ((1 / this.gridWide) * 100) + '%';
        cursorEl.style.height = ((1 / this.gridTall) * 100) + '%';

        // Only rebuild the avatar layers when what they show has actually changed
        let cursorSig = [window.playerItem || 'Za', window.playerAvatar || '', this.gfxIconDir, this.gfxCharDir].join('|');
        if (cursorEl.getAttribute('data-sig') !== cursorSig || !cursorEl.firstChild) {
            cursorEl.innerHTML = '';
            this.buildAvatarOrIcon(cursorEl, window.playerItem || 'Za', window.playerAvatar);
            cursorEl.setAttribute('data-sig', cursorSig);
        }
        
        if (window.playerId) {
            iconsLayer.querySelectorAll(`.chat-bubble[data-pubid="${window.playerId}"]`).forEach(el => {
                if (parseInt(el.getAttribute('data-z'), 10) !== z) el.remove();
            });
        }

    },

    // Diff chat bubbles: drop ones that are gone, add only the new ones.
    syncChatBubbles: function(bubbles) {
        const iconsLayer = document.getElementById('icons-layer');
        if (!iconsLayer) return;
        bubbles = bubbles || [];

        let wantKeys = new Set(bubbles.map(b => `${b.z}|${b.pubId}|${b.text}`));
        let haveKeys = new Set();
        iconsLayer.querySelectorAll('.chat-bubble').forEach(el => {
            let k = `${el.getAttribute('data-z')}|${el.getAttribute('data-pubid')}|${el.getAttribute('data-text')}`;
            if (!wantKeys.has(k) || haveKeys.has(k)) el.remove();
            else haveKeys.add(k);
        });

        let fresh = bubbles.filter(b => !haveKeys.has(`${b.z}|${b.pubId}|${b.text}`));
        this.renderChatBubbles(fresh);
    },

    renderChatBubbles: function(bubbles) {
        const iconsLayer = document.getElementById('icons-layer');
        if (!iconsLayer || !bubbles || bubbles.length === 0) return;

        for (let b of bubbles) {
            let x = b.z % this.gridWide;
            let y = Math.floor(b.z / this.gridWide);

            let el = document.createElement('div');
            el.className = 'chat-bubble';
            el.setAttribute('data-z', b.z);
            el.setAttribute('data-pubid', b.pubId);
            el.setAttribute('data-text', b.text);
            el.textContent = b.text; // XSS-safe

            let isTopRows = (y < 2);
            let tx = '-50%';
            let ty = isTopRows ? '0%' : '-100%';

            el.style.position = 'absolute';
            el.style.pointerEvents = 'none';
            el.style.zIndex = '1500';
            el.style.maxWidth = '180px';
            el.style.padding = '3px 6px';
            el.style.borderRadius = '4px';
            el.style.background = 'rgba(0, 0, 0, 0.85)';
            el.style.color = '#ffffff';
            el.style.border = '1px solid var(--fg-color, #0f0)';
            el.style.fontFamily = 'var(--font-face, monospace)';
            el.style.fontSize = '11px';
            el.style.lineHeight = '1.2';
            el.style.textAlign = 'center';
            el.style.wordWrap = 'break-word';
            el.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.8)';

            if (x === 0) {
                el.style.left = '2px';
                tx = '0%';
            } else if (x === this.gridWide - 1) {
                el.style.right = '2px';
                tx = '0%';
            } else {
                el.style.left = (((x + 0.5) / this.gridWide) * 100) + '%';
            }

            if (isTopRows) {
                el.style.top = (((y + 0.95) / this.gridTall) * 100) + '%';
            } else {
                el.style.top = (((y - 1.05) / this.gridTall) * 100) + '%';
            }

            el.style.transform = `translate(${tx}, ${ty})`;
            iconsLayer.appendChild(el);
        }
    },

    // ========================================================================
    // MOVEMENT, ANIMATION QUEUE & LOCAL CURSOR
    // ========================================================================

    moveZ: function(z, cmd) {
        z = parseInt(z, 10);
        let cols = this.gridWide;
        let total = cols * this.gridTall;
        let col = z % cols;
        if (cmd === 'Vn' || cmd === 'Qn') return (z - cols >= 0) ? z - cols : z;
        if (cmd === 'Vs' || cmd === 'Qs') return (z + cols < total) ? z + cols : z;
        if (cmd === 'Vw' || cmd === 'Qw') return (col > 0) ? z - 1 : z;
        if (cmd === 'Ve' || cmd === 'Qe') return (col < cols - 1) ? z + 1 : z;
        return z;
    },

    reverseMoveZ: function(z, cmd) {
        if (cmd === 'Vn' || cmd === 'Qn') return this.moveZ(z, 'Vs');
        if (cmd === 'Vs' || cmd === 'Qs') return this.moveZ(z, 'Vn');
        if (cmd === 'Vw' || cmd === 'Qw') return this.moveZ(z, 'Ve');
        if (cmd === 'Ve' || cmd === 'Qe') return this.moveZ(z, 'Vw');
        return z;
    },

    setCursorZ: function(newZ) {
        window.playerZ = newZ;
        this.renderCursor();

        if (!window.remoteQandylandUrl) {
            let drive = this.currentPath.split(':')[0] || 'ram';
            this.persistState(`${drive}:/a/playerZ`, this.encodeZ(window.playerZ, this.gfxZBase));
        }
    },

    calculateTargetSector: function(currentSector, dirChar, maxMapBounds, roundWorld) {
        if (!currentSector || currentSector.length < 2) return null;
        if (!maxMapBounds || maxMapBounds.length !== 2) maxMapBounds = 'Hh';

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
    },

    moveCursor: function(dx, dy) {
        // In multiplayer mode, send Vn/Vs/Ve/Vw to server + predict locally
        if (window.remoteQandylandUrl) {
            let cmd = null;
            if (dy < 0) cmd = 'Vn';
            else if (dy > 0) cmd = 'Vs';
            else if (dx < 0) cmd = 'Vw';
            else if (dx > 0) cmd = 'Ve';
            if (!cmd) return;

            let x = window.playerZ % this.gridWide;
            let y = Math.floor(window.playerZ / this.gridWide);
            let nx = x + dx;
            let ny = y + dy;

            if (nx >= 0 && nx < this.gridWide && ny >= 0 && ny < this.gridTall) {
                let targetZ = ny * this.gridWide + nx;
                if (typeof window.gfxCollisionHook === 'function' && !window.gfxCollisionHook(targetZ, window.playerItem)) {
                    window.playerWalk = -1;
                    window.playerDo = "";
                    return;
                }
                if (window.gfxDo === "RF") window.gfxDo = "";
                window.gfxDo += cmd;
                this.setCursorZ(targetZ);
                if (this.fillTileCode) {
                    this._afterTickQueue.push({ cmd: 'tile', data: this.fillTileCode });
                    if (!this.isSyncing) this.networkTick();
                }
            } else {
                if (this.fillTileCode) {
                    window.playerWalk = -1;
                    window.playerDo = "";
                    return;
                }

                // Edge scroll is authoritative on the server
                if (window.gfxDo === "RF") window.gfxDo = "";
                window.gfxDo += cmd;
                window.playerWalk = -1;
                window.playerDo = "";
                if (this.fillTileCode) {
                    this._afterTickQueue.push({ cmd: 'tile', data: this.fillTileCode });
                    if (!this.isSyncing) this.networkTick();
                }
            }
            return;
        }

        // Local Desktop Mode navigation
        let x = window.playerZ % this.gridWide;
        let y = Math.floor(window.playerZ / this.gridWide);
        let nx = x + dx;
        let ny = y + dy;

        let dirChar = null;
        let triggersScroll = false;
        let moveBlocked = false;

        if (this.gfxAirLock) {
            if (dx > 0) {
                if (x === this.gridWide - 1) moveBlocked = true;
                else if (nx === this.gridWide - 1 && !this.fillTileCode) { dirChar = 'E'; triggersScroll = true; }
            } else if (dx < 0) {
                if (x === 0) moveBlocked = true;
                else if (nx === 0 && !this.fillTileCode) { dirChar = 'W'; triggersScroll = true; }
            }
            if (dy > 0) {
                if (y === this.gridTall - 1) moveBlocked = true;
                else if (ny === this.gridTall - 1 && !this.fillTileCode) { dirChar = 'S'; triggersScroll = true; }
            } else if (dy < 0) {
                if (y === 0) moveBlocked = true;
                else if (ny === 0 && !this.fillTileCode) { dirChar = 'N'; triggersScroll = true; }
            }
        } else {
            if (nx >= this.gridWide) {
                if (this.fillTileCode) moveBlocked = true; else { dirChar = 'E'; triggersScroll = true; }
            } else if (nx < 0) {
                if (this.fillTileCode) moveBlocked = true; else { dirChar = 'W'; triggersScroll = true; }
            }
            if (ny >= this.gridTall) {
                if (this.fillTileCode) moveBlocked = true; else { dirChar = 'S'; triggersScroll = true; }
            } else if (ny < 0) {
                if (this.fillTileCode) moveBlocked = true; else { dirChar = 'N'; triggersScroll = true; }
            }
        }

        let tentativeZ = ny * this.gridWide + nx;
        if (typeof window.gfxCollisionHook === 'function') {
            if (!window.gfxCollisionHook(tentativeZ, window.playerItem)) {
                moveBlocked = true;
            }
        }

        if (moveBlocked) {
            window.playerWalk = -1;
            return;
        }

        if (triggersScroll && dirChar) {
            let parts = this.currentPath.split('/');
            let currentSector = parts[parts.length - 1];
            let driveBase = this.currentPath.substring(0, this.currentPath.lastIndexOf('/'));
            let nextSector = this.calculateTargetSector(currentSector, dirChar, this.gfxLowerBound, this.gfxRoundWorld);

            if (nextSector) {
                let targetZ;
                if (this.gfxAirLock) {
                    if (dirChar === 'E') targetZ = (ny * this.gridWide) + 0;
                    if (dirChar === 'W') targetZ = (ny * this.gridWide) + (this.gridWide - 1);
                    if (dirChar === 'S') targetZ = (0 * this.gridWide) + nx;
                    if (dirChar === 'N') targetZ = ((this.gridTall - 1) * this.gridWide) + nx;
                } else {
                    if (nx >= this.gridWide) nx = 0;
                    if (nx < 0) nx = this.gridWide - 1;
                    if (ny >= this.gridTall) ny = 0;
                    if (ny < 0) ny = this.gridTall - 1;
                    targetZ = (ny * this.gridWide) + nx;
                }

                window.playerWalk = -1;
                this.currentPath = driveBase + '/' + nextSector;
                window.map = nextSector;
                this.setCursorZ(targetZ);

                let drive = driveBase.split(':')[0] || 'ram';
                this.persistState(`${drive}:/a/gfxSector`, nextSector);
                this.renderScreen();
                return;
            } else {
                window.playerWalk = -1;
                return;
            }
        }

        if (nx < 0) nx = 0;
        if (nx >= this.gridWide) nx = this.gridWide - 1;
        if (ny < 0) ny = 0;
        if (ny >= this.gridTall) ny = this.gridTall - 1;

        let targetZ = ny * this.gridWide + nx;
        this.setCursorZ(targetZ);

        if (this.fillTileCode && typeof this.setTileAtCursor === 'function') {
            this.setTileAtCursor(this.fillTileCode);
        }
    },

    walkToZ: function(newZ, action = null) {
        window.playerWalk = newZ;
        window.playerDo = action;

        if (window.playerZ === window.playerWalk) {
            window.playerWalk = -1;
            if (window.playerDo) {
                if (typeof window.playerDo === 'function') window.playerDo();
                else if (typeof window.playerDo === 'string' && window.playerDo) {
                    if (window.gfxDo === "RF") window.gfxDo = "";
                    window.gfxDo += window.playerDo;
                }
                window.playerDo = null;
            }
        }
    },

    startCursorTick: function() {
        if (this.cursorInterval) clearInterval(this.cursorInterval);
        let safeCycle = Math.max(50, this.gfxCycle);
        this.cursorInterval = setInterval(() => this.cursorTick(), safeCycle);
    },

    cursorTick: function() {
        // 1. Drain 200ms visual animation queues (matches gfxVisualTick)
        if (window.movingItems) {
            for (let id in window.movingItems) {
                let mi = window.movingItems[id];
                if (!mi || !mi.queue || mi.queue.length === 0) continue;

                let move = mi.queue.shift();
                mi.z = this.moveZ(mi.z, move);

                if (id === window.playerItem) {
                    window.playerZ = mi.z;
                    this.renderCursor();
                } else {
                    let el = document.querySelector(`.dyn-sprite[data-unique-id="${id}"]`);
                    if (el) {
                        let x = mi.z % this.gridWide;
                        let y = Math.floor(mi.z / this.gridWide);
                        el.setAttribute('data-z', mi.z);
                        el.style.left = ((x / this.gridWide) * 100) + '%';
                        el.style.top = ((y / this.gridTall) * 100) + '%';
                    }
                }
            }
        }

        // 2. Step auto-walk
        if (window.playerWalk === -1) return;

        // If client provides custom walkdown() (e.g. capflag), delegate to it
        if (window.remoteQandylandUrl && typeof window.walkdown === 'function') {
            window.walkdown();
            return;
        }

        if (window.playerZ === window.playerWalk) {
            window.playerWalk = -1;
            if (window.playerDo) {
                if (typeof window.playerDo === 'function') window.playerDo();
                else if (typeof window.playerDo === 'string' && window.playerDo) {
                    if (window.gfxDo === "RF") window.gfxDo = "";
                    window.gfxDo += window.playerDo;
                }
                window.playerDo = null;
            }
            return;
        }

        let cx = window.playerZ % this.gridWide;
        let cy = Math.floor(window.playerZ / this.gridWide);
        let tx = window.playerWalk % this.gridWide;
        let ty = Math.floor(window.playerWalk / this.gridWide);

        let dx = tx - cx;
        let dy = ty - cy;
        let stepX = 0, stepY = 0;

        if (Math.abs(dx) > Math.abs(dy)) stepX = dx > 0 ? 1 : -1;
        else if (Math.abs(dy) > Math.abs(dx)) stepY = dy > 0 ? 1 : -1;
        else stepX = dx > 0 ? 1 : -1;

        this.moveCursor(stepX, stepY);
    },

    executeCursor: function() {
        let z = window.playerZ;
        let x = z % this.gridWide;
        let y = Math.floor(z / this.gridWide);
        const wrapper = document.getElementById('desktop-wrapper');
        if (!wrapper) return;

        let rect = wrapper.getBoundingClientRect();
        let w = rect.width / this.gridWide;
        let h = rect.height / this.gridTall;
        let clientX = rect.left + (x + 0.5) * w;
        let clientY = rect.top + (y + 0.5) * h;

        this.showTargetMenu(z, clientX, clientY);
    },

    // ========================================================================
    // LOCAL DESKTOP CONTEXT MENUS & FILE OPS
    // ========================================================================

    showTargetMenu: function(z, clientX, clientY) {
        if (!window.parent || !window.parent.CylonPopManager || typeof window.parent.CylonPopManager.showContextMenu !== 'function') return;

        let items = [];
        let iconWraps = document.querySelectorAll(`.icon-wrap[data-z="${z}"]`);

        iconWraps.forEach(wrap => {
            let labelText = wrap.getAttribute('data-label');
            let fullPath = wrap.getAttribute('data-path');
            if (labelText && fullPath) {
                items.push({
                    label: labelText,
                    action: () => this.walkToZ(z, () => this.showActionMenu(z, labelText, fullPath))
                });
            }
        });

        let x = z % this.gridWide;
        let y = Math.floor(z / this.gridWide);
        let parts = this.currentPath.split('/');
        let currentSector = parts[parts.length - 1];

        let addScroll = (dirChar, label, dx, dy) => {
            let nextSector = this.calculateTargetSector(currentSector, dirChar, this.gfxLowerBound, this.gfxRoundWorld);
            if (nextSector) {
                items.push({
                    label: label,
                    action: () => this.walkToZ(z, () => this.moveCursor(dx, dy))
                });
            }
        };

        if (!this.fillTileCode) {
            if (y === 0) addScroll('N', 'Scroll North', 0, -1);
            if (y === this.gridTall - 1) addScroll('S', 'Scroll South', 0, 1);
            if (x === this.gridWide - 1) addScroll('E', 'Scroll East', 1, 0);
            if (x === 0) addScroll('W', 'Scroll West', -1, 0);
        }

        items.push({
            label: 'Walk Here',
            action: () => this.walkToZ(z)
        });

        if (items.length === 1) {
            items[0].action();
            return;
        }

        let mockEvent = { clientX, clientY, view: window };
        window.parent.CylonPopManager.showContextMenu(mockEvent, items);
    },

    showActionMenu: function(z, labelText, fullPath) {
        if (!window.parent || !window.parent.CylonPopManager || typeof window.parent.CylonPopManager.showContextMenu !== 'function') return;
        let items = [];
        items.push({ label: 'Open ' + labelText, action: () => this.executeScript(fullPath) });
        if (this.enableFileMove) {
            items.push({ label: 'Move ' + labelText, action: () => {
                this.pendingMovePath = fullPath;
                if (window.parent && window.parent.print) window.parent.print('Select a destination tile to move this file.\n');
            }});
        }
        items.push({ label: 'Remove ' + labelText, action: () => this.removeScript(fullPath) });

        let x = z % this.gridWide;
        let y = Math.floor(z / this.gridWide);
        const wrapper = document.getElementById('desktop-wrapper');
        let rect = wrapper.getBoundingClientRect();
        let w = rect.width / this.gridWide;
        let h = rect.height / this.gridTall;

        let clientX = rect.left + (x + 0.5) * w;
        let clientY = rect.top + (y + 0.5) * h;
        let mockEvent = { clientX, clientY, view: window };
        window.parent.CylonPopManager.showContextMenu(mockEvent, items);
    },

    moveObjectToZ: async function(filePath, z) {
        const dos = this.getDOS();
        if (!dos || typeof dos.rename !== 'function') {
            if (window.parent && window.parent.print) window.parent.print('Cannot move file: DOS rename is unavailable.\n');
            return false;
        }
        const slash = filePath.lastIndexOf('/');
        const basename = filePath.substring(slash + 1);
        if (basename.length < 4) return false;
        const zText = this.encodeZ(z, this.gfxZBase || 10);
        const newName = basename.substring(0, 2) + zText + basename.substring(4);
        if (newName === basename) {
            await this.renderScreen();
            return true;
        }
        const newPath = filePath.substring(0, slash + 1) + newName;
        try {
            if (await dos.exists(newPath)) {
                if (window.parent && window.parent.print) window.parent.print('That tile already contains a file with this name.\n');
                return false;
            }
            await dos.rename(filePath, newPath);
            await this.renderScreen();
            return true;
        } catch (err) {
            console.error('GFX move failed:', err);
            if (window.parent && window.parent.print) window.parent.print(`Move failed: ${String(err.message || err)}\n`);
            return false;
        }
    },

    executeScript: async function(filePath) {
        let scriptData = await window.qdosLoad(filePath);
        if (!scriptData) return;
        await window.CylonScript(scriptData);
        if (!window.remoteQandylandUrl) {
            this.renderScreen();
        }
    },

    removeScript: async function(filePath) {
        let dos = this.getDOS();
        if (dos) {
            try {
                await dos.delete(filePath);
                this.renderScreen();
            } catch (err) {}
        }
    },

    setTileAtCursor: async function(code) {
        let dos = this.getDOS();
        if (!dos) return;

        let tPath = `${this.currentPath}/m`;
        let tData = "";
        try { tData = await dos.load(tPath); } catch (e) {}
        if (!tData) tData = "";
        tData = tData.replace(/\s+/g, '');

        let expectedLen = this.gridWide * this.gridTall * 2;
        if (tData.length < expectedLen) {
            let needed = (expectedLen - tData.length) / 2;
            if (needed > 0) tData += 'Za'.repeat(Math.ceil(needed));
        }

        if (!code) {
            let currentCode = tData.substring(window.playerZ * 2, window.playerZ * 2 + 2) || 'Za';
            if (this.gfxCommandLog && window.parent.print) {
                window.parent.print(`\n[.3]GFX Tile Engine: Tile at Cursor (${window.playerZ}) is [${currentCode}][.]\n`);
            }
            let html = `<div> ${currentCode} </div>`;
            if (window.parent && typeof window.parent.popHtm === 'function') {
                window.parent.popHtm(html, 'center');
            } else if (typeof window.pop === 'function') {
                window.pop(html, 'cursor');
            }
            return;
        }

        code = String(code).padEnd(2, 'a').substring(0, 2);
        let prefix = tData.substring(0, window.playerZ * 2);
        let suffix = tData.substring(window.playerZ * 2 + 2);
        tData = prefix + code + suffix;

        await this.persistState(tPath, tData);
        this.updateTileDOM(window.playerZ, code);
    },

    updateTileDOM: function(z, code) {
        const tilesLayer = document.getElementById('tiles-layer');
        if (!tilesLayer) return;

        let existing = document.getElementById(`gfx-tile-${z}`);

        if (code === 'Za') {
            if (existing) existing.remove();
            return;
        }

        if (existing) {
            let src = `${this.gfxTileDir}${code}.png`;
            if (existing.getAttribute('data-src') !== src) {
                existing.src = src;
                existing.setAttribute('data-src', src);
            }
            existing.style.display = '';
        } else {
            tilesLayer.appendChild(this._makeTileEl(z, code));
        }
    },

    toggleGfxGrid: function(state) {
        this.gfxGrid = typeof state === 'boolean' ? state : !this.gfxGrid;
        if (!window.remoteQandylandUrl) {
            this.renderScreen();
        }
    }
};

window.CylonGFX.setupListeners();

window.qdosLoad = async function(filename) {
    let dos = window.parent && window.parent.CylonDOS ? window.parent.CylonDOS : window.CylonDOS;
    if (!dos) throw new Error("CylonDOS not available");
    let driveName = filename.split(':')[0];
    if (!driveName || driveName === filename) driveName = dos.mountedDrive;
    let mounts = await dos.mounts();
    let targetMount = mounts.find(m => m.name === driveName);

    if (targetMount && targetMount.type === 'idb') {
        throw new Error("SECURITY EXCEPTION: GFX Engine cannot access IndexedDB drives.");
    }
    return await dos.load(filename);
};