// ============================================================================
// Cylon Graphics & Physics Co-Processor (cylon-gfx.js)
// "Everything is a file. The filesystem is the physics engine."
// ============================================================================

// --- Unification with multiplayer gfx.js state variables ---
window.playerItem = "Si";   // Desktop defaults to Cursor 1 ('Si')
window.playerZ = -1;        // z-location of player/cursor
window.lastClickZ = -1;     // Tracks the last physical mapped screen coordinate clicked
window.playerAvatar = "";   // player's avatar modifiers (if any)
window.playerInven = "";    // inventory 
window.playerId = "";       // unique 4 character player id
window.playerWalk = -1;     // z-location player clicks to walk to, -1 = standing still
window.playerDo = null;     // callback/command to execute when destination is reached
window.map = "A1";          // map player-item is currently on

// Somewhere in cylon-gfx.js init() or setup:
if (typeof UNIVAC !== 'undefined') {
    UNIVAC.inject(window.GfxSyncFS);
}

window.CylonGFX = {
    // --- GFX Configuration Defaults ---
    gfxTileSize: 64,
    gfxTileDir: 't/',
    gfxIconDir: 'q/',   // Default system icons (Desktop uses q/ for icons/cursors)
    gfxCharDir: 'c/',
    gfxMapsDir: 'm/',
    gridWide: 8, 
    gridTall: 4,  
    gfxGridStretch: true,

    // --- Spatial Navigation Defaults ---
    gfxRoundWorld: false, // Map wrapping (Az <-> Aa)
    gfxLowerBound: 'Hh',  // Bottom-Right map grid sector limit
    gfxAirLock: false,    // True: Scroll triggers ON edge tile. False: Scroll triggers PAST edge tile.

    gfxCommandLog: false, // If true, saves are echoed natively in the command terminal

    fillTileCode: null, // Holds the active brush code (e.g., 'Za')

    // --- Cursor Walk Variables ---
    gfxCycle: 200,             // Tick speed in ms
    cursorInterval: null,      // Internal loop pointer

    // Backwards compatibility aliases
    get mapx() { return this.gridWide; },
    set mapx(v) { this.gridWide = v; },
    get mapy() { return this.gridTall; },
    set mapy(v) { this.gridTall = v; },
    get targetCursorZ() { return window.playerWalk; },
    set targetCursorZ(v) { window.playerWalk = v; },
    get pendingCursorAction() { return window.playerDo; },
    set pendingCursorAction(v) { window.playerDo = v; },

    // --- State Variables ---
    currentPath: '',
    gfxGrid: false, 

    // --- Unified Save Method ---
    persistState: async function(path, data) {
        let safeData = String(data || "\\n");
        
        if (this.gfxCommandLog && typeof window.CylonCommand === 'function') {
            let cliData = safeData.replace(/\n/g, '\\n');
            if (cliData.trim() === '') cliData = '\\n'; 
            
            await window.CylonCommand(`save ${path} ${cliData}`);
        } else if (window.parent && window.parent.CylonDOS) {
            await window.parent.CylonDOS.save(path, safeData);
        }
    },

    init: async function(startPath) {
        this.setupListeners();
      
        this.currentPath = startPath;
        
        let parts = startPath.replace(/\/$/, '').split('/');
        window.map = parts[parts.length - 1] || "A1";
        
        let drive = startPath.split(':')[0]; 
        
        if (window.CylonSDK && window.CylonSDK.injectDesktopStyles) {
            window.CylonSDK.injectDesktopStyles();
        }

        // Handle safe headless boot mode for native OS initialization
        let dosObj = window.parent && window.parent.CylonDOS ? window.parent.CylonDOS : window.CylonDOS;
        if (!dosObj) return;

        // 1. Load GFX Variables from VFS
        let tDir = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxTileDir`);
        let iDir = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxIconDir`);
        let cDir = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxCharDir`);
        let mDir = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxMapsDir`);
        let tSize = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxTileSize`);
        
        let gWide = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxGridWide`);
        if (!gWide) gWide = await this.qdosLoadSafe(dosObj, `${drive}:/a/mapx`); 
        
        let gTall = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxGridTall`);
        if (!gTall) gTall = await this.qdosLoadSafe(dosObj, `${drive}:/a/mapy`); 
        
        let gStretch = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxGridStretch`);
        let cz = await this.qdosLoadSafe(dosObj, `${drive}:/a/playerZ`);
        if (!cz) cz = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxCursorZ`); // Legacy
        
        let pItem = await this.qdosLoadSafe(dosObj, `${drive}:/a/playerItem`);
        
        // --- Spatial Navigation Variables ---
        let rWorld = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxRoundWorld`);
        let lBound = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxLowerBound`);
        let aLock = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxAirLock`);
        let cLog = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxCommandLog`);

        // 2. Apply Valid Variables
        if (tDir) this.gfxTileDir = tDir.trim();
        if (iDir) this.gfxIconDir = iDir.trim();
        if (cDir) this.gfxCharDir = cDir.trim();
        if (mDir) this.gfxMapsDir = mDir.trim();
        if (tSize) this.gfxTileSize = parseInt(tSize, 10);
        if (gWide) this.gridWide = parseInt(gWide, 10);
        if (gTall) this.gridTall = parseInt(gTall, 10);
        if (gStretch) this.gfxGridStretch = (gStretch.trim().toLowerCase() === 'true');
        
        if (rWorld) this.gfxRoundWorld = (rWorld.trim().toLowerCase() === 'true');
        if (lBound) this.gfxLowerBound = lBound.trim();
        if (aLock) this.gfxAirLock = (aLock.trim().toLowerCase() === 'true');
        if (cLog) this.gfxCommandLog = (cLog.trim().toLowerCase() === 'true');

        let cycleStr = await this.qdosLoadSafe(dosObj, `${drive}:/a/gfxCycle`);
        if (cycleStr) {
            let val = parseFloat(cycleStr.trim());
            if (!isNaN(val)) this.gfxCycle = Math.floor(val * 1000); 
        }

        // 3. Restore Player/Cursor State
        if (pItem) window.playerItem = pItem.trim();
        
        window.playerZ = cz ? parseInt(cz, 10) : 0;
        if (isNaN(window.playerZ)) window.playerZ = 0;
        
        this.startCursorTick();

        window.dispatchEvent(new Event('resize'));
        await this.renderScreen();
    },

    qdosLoadSafe: async function(dos, path) {
        try {
            return await dos.load(path);
        } catch(e) {
            return null;
        }
    },

    setupListeners: function() {
        if (!this._listenersAdded) {
            window.addEventListener('message', async (e) => {
                if (window.location.origin !== "null" && e.origin !== window.location.origin) return;
                if (e.source !== window && e.source !== window.parent) return;
                
                if (e.data.type === 'QANDY_GFX_CMD') {
                    await this.handleGfxCommand(e.data.cmd, e.data.data);
                } else if (e.data.type === 'gfx') {
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
                    // STEP 1: Pop the target selection menu up directly at the click location!
                    this.showTargetMenu(z, e.clientX, e.clientY);
                }
            });

            wrapper.addEventListener('contextmenu', (e) => {
                e.preventDefault();

                if (window.parent && window.parent.document) {
                    window.parent.document.dispatchEvent(new Event('click'));
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
                    window.playerWalk = -1; 
                    this.setCursorZ(z);
                    // Right clicking forces a target menu jump too
                    this.showTargetMenu(z, e.clientX, e.clientY);
                }
            });

            this._bgClickBound = true;
        }
    },

    handleGfxCommand: async function(cmd, data) {
        switch(cmd) {
            case 'tile':
                if (typeof this.setTileAtCursor === 'function') await this.setTileAtCursor(data);
                break;

            case 'fill':
                if (data) {
                    this.fillTileCode = data;
                    if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.4]GFX Fill Mode ENGAGED: brush set to [${data}][.]\n`);
                } else {
                    this.fillTileCode = null;
                    if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.2]GFX Fill Mode DISABLED.[.]\n`);
                }
                break;

            case 'tele':
                if (data) {
                    let drive = this.currentPath.split(':')[0] || 'ram';
                    await this.init(`${drive}:/w/${data}`);
                    
                    await this.persistState(`${drive}:/a/gfxSector`, data);
                    if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.3]Teleported to sector: ${data}[.]\n`);
                }
                break;

            case 'pickicon':
                if (data) {
                    let parts = data.split(' ');
                    let code = parts[0];
                    let z = parts[1];
                    this.showIconNamer(code, z);
                }
                break;

            case 'saveicon':
                if (data) {
                    let parts = data.split(' ');
                    let code = parts[0];
                    let z = parseInt(parts[1], 10);
                    let name = parts[2];
                    
                    if (code && code.length === 2 && /^[A-Z]/.test(code[0]) && name && name.length >= 1) {
                        let zHex = z.toString(16).padStart(2, '0').toLowerCase();
                        let filename = code + zHex + name;
                        
                        let pathPrefix = this.currentPath.endsWith('/') ? this.currentPath : this.currentPath + '/';
                        let filePath = `${pathPrefix}${filename}`;
                        
                        await this.persistState(filePath, "\\n");
                        
                        if (this.gfxCommandLog && window.parent.print) {
                            window.parent.print(`[.4]GFX Engine: Created icon '${name}' at Z:${z}[.]\n`);
                        }
                        this.renderScreen();
                    } else {
                        if (this.gfxCommandLog && window.parent.print) {
                            window.parent.print(`[.4]GFX Error: Invalid icon code or name.[.]\n`);
                        }
                    }
                }
                break;
                
            case 'icon':
                if (data) {
                    let parts = data.trim().split(/\s+/);
                    let code = parts[0];
                    let name = parts.slice(1).join(' ');
                    
                    if (code && code.length >= 2 && name && name.length >= 3) {
                        code = code.substring(0, 2); 
                        let zHex = window.playerZ.toString(16).padStart(2, '0').toLowerCase();
                        let filename = code + zHex + name;
                        
                        let pathPrefix = this.currentPath.endsWith('/') ? this.currentPath : this.currentPath + '/';
                        let filePath = `${pathPrefix}${filename}`;
                        
                        await this.persistState(filePath, "\\n");
                        if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.4]GFX Engine: Created icon '${name}' at Z:${window.playerZ}[.]\n`);
                        this.renderScreen();
                    } else {
                        if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.4]GFX Error: 'gfx icon [2-char code] [>=3-char name]' required.[.]\n`);
                    }
                }
                break;

            case 'run':
                if (data) {
                    let parts = data.trim().split(/\s+/);
                    let name = parts[0];
                    let commands = data.substring(name.length).trim();
                    
                    if (name && name.length >= 3 && commands) {
                        let zHex = window.playerZ.toString(16).padStart(2, '0').toLowerCase();
                        let dos = window.parent && window.parent.CylonDOS ? window.parent.CylonDOS : window.CylonDOS;
                        let files = [];
                        try { files = await dos.dir(this.currentPath); } catch (e) {}
                        
                        let targetFile = null;
                        for (let file of files) {
                            let fname = file.name.substring(file.name.lastIndexOf('/') + 1);
                            if (fname.length >= 4 && file.type === 'file' && fname !== 'm' && fname !== 't') {
                                let fZHex = fname.substring(2, 4).toLowerCase();
                                let fName = fname.substring(4);
                                if (fZHex === zHex && fName === name) {
                                    targetFile = fname;
                                    break;
                                }
                            }
                        }
                        
                        if (targetFile) {
                            let pathPrefix = this.currentPath.endsWith('/') ? this.currentPath : this.currentPath + '/';
                            let filePath = `${pathPrefix}${targetFile}`;
                            await this.persistState(filePath, commands);
                            if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.4]GFX Engine: Saved run script for icon '${name}'.[.]\n`);
                        } else {
                            if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.4]GFX Error: Icon '${name}' not found at cursor Z:${window.playerZ}.[.]\n`);
                        }
                    } else {
                        if (this.gfxCommandLog && window.parent.print) window.parent.print(`[.4]GFX Error: 'gfx run [icon name] [commands]' required.[.]\n`);
                    }
                }
                break;                
        }
    },

    renderScreen: async function() {
        let dos = window.parent && window.parent.CylonDOS ? window.parent.CylonDOS : window.CylonDOS;
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
        try { tData = await dos.load(`${this.currentPath}/t`); } catch (e) { }

        if (tData) {
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

            if (filename === 'm' || filename === 't' || file.type !== 'file') continue;

            if (filename.length >= 4) {
                let iconId = filename.substring(0, 2);
                let zHex = filename.substring(2, 4);
                let labelText = filename.substring(4); 
                
                let z = parseInt(zHex, 16);
                let x = z % this.gridWide;
                let y = Math.floor(z / this.gridWide);

                let fullDosPath = `${drive}:/${file.name.replace(/^\/+/, '')}`;
                this.buildSprite(iconId, x, y, z, labelText, fullDosPath);
            }
        }
        
        this.renderCursor();
    },

    buildSprite: function(iconId, x, y, z, labelText, fullPath) {
        const iconsLayer = document.getElementById('icons-layer');
        if (!iconsLayer) return;
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
        
        let img = document.createElement('img');
        img.className = 'icon-img';
        img.src = this.gfxIconDir + iconId + '.png'; 
        img.onerror = function() { this.src = self.gfxIconDir + 'file.png'; }; 
        
        let lbl = document.createElement('div');
        lbl.className = 'icon-label';
        lbl.textContent = labelText;
        
        wrap.appendChild(img);
        wrap.appendChild(lbl);

        iconsLayer.appendChild(wrap);
    },

    // --- SYSTEM CURSOR & SPATIAL NAVIGATION ENGINE ---

    renderCursor: function() {
        const iconsLayer = document.getElementById('icons-layer');
        if (!iconsLayer) return;
        
        let transTime = Math.max(0.05, (this.gfxCycle * 0.75) / 1000);

        let cursorEl = document.getElementById('gfx-sys-cursor');
        if (!cursorEl) {
            cursorEl = document.createElement('img');
            cursorEl.id = 'gfx-sys-cursor';
            cursorEl.style.position = 'absolute';
            cursorEl.style.pointerEvents = 'none'; 
            cursorEl.style.zIndex = '1000';
            cursorEl.style.imageRendering = 'pixelated';
            cursorEl.style.filter = 'drop-shadow(2px 2px 2px rgba(0,0,0,0.8))';
            iconsLayer.appendChild(cursorEl);
        }
        
        cursorEl.src = this.gfxIconDir + window.playerItem + '.png';
        cursorEl.onerror = function() { this.src = 'q/file.png'; }; 

        cursorEl.style.transition = `top ${transTime}s linear, left ${transTime}s linear`;

        let x = window.playerZ % this.gridWide;
        let y = Math.floor(window.playerZ / this.gridWide);

        cursorEl.style.left = ((x / this.gridWide) * 100) + '%';
        cursorEl.style.top = ((y / this.gridTall) * 100) + '%';
        cursorEl.style.width = ((1 / this.gridWide) * 100) + '%';
        cursorEl.style.height = ((1 / this.gridTall) * 100) + '%';
    },

    setCursorZ: function(newZ) {
        window.playerZ = newZ;
        this.renderCursor(); 
        
        let drive = this.currentPath.split(':')[0] || 'ram';
        this.persistState(`${drive}:/a/playerZ`, window.playerZ.toString());
    },

    calculateTargetSector: function(currentSector, dirChar, maxMapBounds, roundWorld) {
        if (!currentSector || currentSector.length < 2) return null;
        if (!maxMapBounds || maxMapBounds.length !== 2) maxMapBounds = 'Hh';

        let minY = 65; // 'A'
        let minX = 97; // 'a'
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
                else if (nx === this.gridWide - 1) { dirChar = 'E'; triggersScroll = true; }
            } else if (dx < 0) {
                if (x === 0) moveBlocked = true;
                else if (nx === 0) { dirChar = 'W'; triggersScroll = true; }
            }
            if (dy > 0) {
                if (y === this.gridTall - 1) moveBlocked = true;
                else if (ny === this.gridTall - 1) { dirChar = 'S'; triggersScroll = true; }
            } else if (dy < 0) {
                if (y === 0) moveBlocked = true;
                else if (ny === 0) { dirChar = 'N'; triggersScroll = true; }
            }
        } else {
            if (nx >= this.gridWide) { dirChar = 'E'; triggersScroll = true; }
            else if (nx < 0) { dirChar = 'W'; triggersScroll = true; }
            if (ny >= this.gridTall) { dirChar = 'S'; triggersScroll = true; }
            else if (ny < 0) { dirChar = 'N'; triggersScroll = true; }
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

        let oldFile = `${this.currentPath}/${window.playerItem}${window.playerZ.toString(16).padStart(2, '0').toLowerCase()}`;
        let newFile = `${this.currentPath}/${window.playerItem}${targetZ.toString(16).padStart(2, '0').toLowerCase()}`;
        
        if (window.parent && window.parent.CylonDOS && window.playerItem.charAt(0) === 'S') {
            window.parent.CylonDOS.rename(oldFile, newFile).catch(()=> {});
        }

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
        if (window.playerWalk === -1) return;

        if (window.playerZ === window.playerWalk) {
            window.playerWalk = -1;
            if (window.playerDo) {
                if (typeof window.playerDo === 'function') window.playerDo();
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

        let stepX = 0;
        let stepY = 0;

        if (Math.abs(dx) > Math.abs(dy)) {
            stepX = dx > 0 ? 1 : -1;
        } else if (Math.abs(dy) > Math.abs(dx)) {
            stepY = dy > 0 ? 1 : -1;
        } else {
            stepX = dx > 0 ? 1 : -1;
        }

        this.moveCursor(stepX, stepY);
    },

    executeCursor: function() {
        // Hitting "Enter" acts identically to clicking the tile the player is currently standing on
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

    // STEP 1: What is on this tile?
    showTargetMenu: function(z, clientX, clientY) {
        if (!window.parent || !window.parent.CylonPopManager || typeof window.parent.CylonPopManager.showContextMenu !== 'function') {
            console.warn("GFX Warning: Context menu manager unavailable.");
            return;
        }

        let items = [];
        
        // Scan for interactable icons/entities on this specific Z tile
        let iconWraps = document.querySelectorAll(`.icon-wrap[data-z="${z}"]`);
        iconWraps.forEach(wrap => {
            let labelText = wrap.getAttribute('data-label');
            let fullPath = wrap.getAttribute('data-path');
            if (labelText && fullPath) {
                items.push({
                    label: labelText,
                    // Selecting the target engages the auto-walk, which defers the Action Menu until arrival!
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

        if (y === 0) addScroll('N', 'Scroll North', 0, -1);
        if (y === this.gridTall - 1) addScroll('S', 'Scroll South', 0, 1);
        if (x === this.gridWide - 1) addScroll('E', 'Scroll East', 1, 0);
        if (x === 0) addScroll('W', 'Scroll West', -1, 0);
        // Always allow a basic walk/move command if clicking the map
        items.push({
            label: 'Walk Here',
            action: () => this.walkToZ(z)
        });
        // Bypass menu if 'Walk Here' is the only option ---
        if (items.length === 1) {
            items[0].action();
            return;
        }
        let mockEvent = { clientX, clientY, view: window };
        window.parent.CylonPopManager.showContextMenu(mockEvent, items);
    },
    
    // STEP 2: We have arrived at the target. What do you want to do with it?
    showActionMenu: function(z, labelText, fullPath) {
        if (!window.parent || !window.parent.CylonPopManager || typeof window.parent.CylonPopManager.showContextMenu !== 'function') return;

        let items = [];
        
        items.push({
            label: 'Open ' + labelText,
            action: () => this.executeScript(fullPath)
        });
        
        items.push({
            label: 'Remove ' + labelText,
            action: () => this.removeScript(fullPath)
        });

        // Visually center the Action Menu on the physical tile coordinates the player is now standing on
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

    showIconPicker: function(z) {
        let html = '<div style="text-align:center; padding:15px; user-select:none;">';
        html += '<div style="margin-bottom:15px; color:var(--fg-color,#0f0); font-family:var(--font-face,monospace); font-size:16px; font-weight:bold;">Select Icon</div>';
        
        let rows = ['A', 'B', 'C'];
        rows.forEach(prefix => {
            html += '<div style="display:flex; justify-content:center; gap:6px; margin-bottom:6px;">';
            for(let c = 'q'.charCodeAt(0); c <= 'z'.charCodeAt(0); c++) {
                let code = prefix + String.fromCharCode(c);
                html += `<a href="gfx:pickicon ${code} ${z}" style="display:flex; align-items:center; justify-content:center; width:36px; height:36px; line-height:0; border:1px solid transparent; border-radius:3px; transition:border 0.1s;" onmouseover="this.style.border='1px solid var(--sel-fg, #0f0)'" onmouseout="this.style.border='1px solid transparent'"><img src="${this.gfxIconDir}${code}.png" style="width:32px; height:32px; image-rendering:pixelated; cursor:pointer;" onerror="this.src='q/file.png'" title="${code}" /></a>`;
            }
            html += '</div>';
        });
        html += '</div>';

        if (window.parent && window.parent.popHtm) {
            window.parent.popHtm(html, 'center');
        }
    },

    showIconNamer: function(code, z) {
        let html = `<div style="text-align:center; padding:15px;">
            <div style="margin-bottom:15px; color:var(--fg-color,#0f0); font-family:var(--font-face,monospace); font-weight:bold;">Name New Icon</div>
            <img src="${this.gfxIconDir}${code}.png" style="width:64px; height:64px; image-rendering:pixelated; margin-bottom:15px; filter:drop-shadow(2px 2px 2px rgba(0,0,0,0.8));" onerror="this.src='q/file.png'"/>
            <div style="margin-bottom:15px;">
                <input type="text" id="gfx-new-icon-name" placeholder="Alpha-numeric name" style="width:100%; box-sizing:border-box; padding:8px; background:var(--input-bg,#000); color:var(--input-fg,#0f0); border:1px solid var(--sel-bg,#333); font-family:var(--font-face,monospace); font-size:16px; outline:none;" maxlength="20" autocomplete="off" spellcheck="false" />
            </div>
            <a href="#" id="gfx-new-icon-submit" onclick="
                var inputEl = document.getElementById('gfx-new-icon-name');
                if(!inputEl) return false;
                var val = inputEl.value.replace(/[^a-zA-Z0-9]/g, '');
                if(!val) { inputEl.focus(); return false; }
                let activeFrame = document.querySelector('.page-frame.active');
                if(activeFrame && activeFrame.contentWindow) {
                    activeFrame.contentWindow.postMessage({ type: 'gfx', cmd: 'saveicon ${code} ${z} ' + val }, (window.location.origin && window.location.origin !== 'null' ? window.location.origin : '*'));
                } else {
                    window.postMessage({ type: 'gfx', cmd: 'saveicon ${code} ${z} ' + val }, (window.location.origin && window.location.origin !== 'null' ? window.location.origin : '*'));
                }
                if(typeof hpop === 'function') hpop();
                return false;
            " style="display:inline-block; padding:8px 16px; background:var(--sel-bg,#333); color:var(--sel-fg,#0f0); text-decoration:none; cursor:pointer; border-radius:3px; font-weight:bold; font-family:var(--font-face,monospace);">Submit</a>
        </div>`;

        if (window.parent && window.parent.popHtm) {
            window.parent.popHtm(html, 'center');
            setTimeout(() => {
                let input = window.parent.document.getElementById('gfx-new-icon-name');
                if (input) {
                    input.focus();
                    input.onkeydown = function(e) {
                        if(e.key === 'Enter') {
                            e.preventDefault();
                            let submitBtn = window.parent.document.getElementById('gfx-new-icon-submit');
                            if(submitBtn) submitBtn.click();
                        }
                    };
                }
            }, 100);
        }
    },

    executeScript: async function(filePath) {
        let scriptData = await window.qdosLoad(filePath);
        if (!scriptData) {
            console.error(`GFX Error: Could not load script at ${filePath}.`);
            return;
        }
        await window.CylonScript(scriptData);
        this.renderScreen();
    },
    
    removeScript: async function(filePath) {
        if (window.parent && window.parent.CylonDOS) {
            try {
                await window.parent.CylonDOS.delete(filePath);
                this.renderScreen();
            } catch(err) {
                console.error("GFX Error: Could not remove icon file.", err);
            }
        }
    },

    setTileAtCursor: async function(code) {
        let dos = window.parent && window.parent.CylonDOS ? window.parent.CylonDOS : window.CylonDOS;
        if (!dos) return;
        
        let tPath = `${this.currentPath}/t`;
        let tData = "";
        try { tData = await dos.load(tPath); } catch (e) {}
        if (!tData) tData = "";

        let expectedLen = this.gridWide * this.gridTall * 2;
        if (tData.length < expectedLen) {
            let needed = (expectedLen - tData.length) / 2;
            if (needed > 0) tData += 'Za'.repeat(Math.ceil(needed));
        }

        if (!code) {
            let currentCode = tData.substring(window.playerZ * 2, window.playerZ * 2 + 2) || 'Za';
            if (this.gfxCommandLog && window.parent.print) window.parent.print(`\n[.3]GFX Tile Engine: Tile at Cursor (${window.playerZ}) is [${currentCode}][.]\n`);
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
            existing.src = `${this.gfxTileDir}${code}.png`;
            existing.style.display = ''; 
        } else {
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
    },

    toggleGfxGrid: function(state) {
        this.gfxGrid = typeof state === 'boolean' ? state : !this.gfxGrid;
        this.renderScreen(); 
    }
};

// ============================================================================
// GFX SECURITY SANDBOX & SYNC FILESYSTEM
// ============================================================================

// 1. Asynchronous Macro Loader (Locked out of IndexedDB)
window.qdosLoad = async function(filename) {
    let dos = window.parent && window.parent.CylonDOS ? window.parent.CylonDOS : window.CylonDOS;
    if (!dos) throw new Error("CylonDOS not available");

    // Determine target drive
    let driveName = filename.split(':')[0];
    if (!driveName || driveName === filename) {
        driveName = dos.mountedDrive; // Fallback to current working drive
    }

    // Security Gate: Check drive type
    let mounts = await dos.mounts();
    let targetMount = mounts.find(m => m.name === driveName);
    
    if (targetMount && targetMount.type === 'idb') {
        console.error(`GFX SECURITY BLOCK: Attempted read on System Drive [${driveName}:]`);
        throw new Error("SECURITY EXCEPTION: GFX Engine cannot access IndexedDB drives.");
    }

    return await dos.load(filename);
};

// 2. Synchronous FileSystem for UNIVAC (Strictly localStorage)
window.GfxSyncFS = {
    getPrefix: function(driveName) {
        return 'cylon:' + driveName + ':';
    },

    fileLoad: function(driveName, root, filepath, session) {
        let key = this.getPrefix(driveName) + filepath;
        let raw = window.localStorage.getItem(key);
        if (!raw) return { success: false };
        try {
            let entry = JSON.parse(raw);
            return { success: true, content: entry.content };
        } catch(e) {
            return { success: false };
        }
    },

    fileSave: function(driveName, root, filepath, content, session1, session2, timestamp) {
        let key = this.getPrefix(driveName) + filepath;
        // Matches CylonDOS internal schema so DOS can still view/delete these files
        let entry = {
            path: filepath,
            type: 'file',
            content: String(content),
            size: String(content).length,
            timestamp: timestamp || new Date().toISOString(),
            readOnly: false
        };
        try {
            window.localStorage.setItem(key, JSON.stringify(entry));
            return { success: true };
        } catch(e) {
            return { success: false, error: "localStorage full" };
        }
    },
    
    fileDelete: function(driveName, root, filepath, session) {
        window.localStorage.removeItem(this.getPrefix(driveName) + filepath);
        return { success: true };
    },

    fileRename: function(driveName, root, oldPath, newPath, session) {
        let loadRes = this.fileLoad(driveName, root, oldPath, session);
        if (loadRes.success) {
            let saveRes = this.fileSave(driveName, root, newPath, loadRes.content, session, session);
            if (saveRes.success) {
                this.fileDelete(driveName, root, oldPath, session);
                return { success: true };
            }
        }
        return { success: false };
    },

    fileList: function(driveName, directory, ignored, session) {
        let prefix = this.getPrefix(driveName) + directory;
        let files = [];
        for (let i = 0; i < window.localStorage.length; i++) {
            let key = window.localStorage.key(i);
            if (key.startsWith(prefix)) {
                // Extract just the filename, ignoring the directory path
                let filename = key.substring(prefix.length).replace(/^\//, '');
                if (filename.indexOf('/') === -1) { // Ensure it's not a sub-directory
                    files.push(filename);
                }
            }
        }
        return { success: true, listing: files.join(' ') };
    },

    futureTimestamp: function(minutes) {
        let d = new Date();
        d.setMinutes(d.getMinutes() + minutes);
        let p = (n) => String(n).padStart(2, '0');
        return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
               p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
};
