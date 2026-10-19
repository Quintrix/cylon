// ============================================================================
// Cylon Graphics & Physics Co-Processor (cylon-gfx.js)
// "Everything is a file. The filesystem is the physics engine."
// ============================================================================

window.CylonGFX = {
    // --- GFX Configuration Defaults ---
    gfxTileSize: 64,
    gfxTileDir: 't/',
    gfxIconDir: 'q/',
    gfxCharDir: 'c/',
    gfxMapsDir: 'm/',
    gridWide: 8, 
    gridTall: 4,  
    gfxGridStretch: true,

    // --- Spatial Navigation Defaults ---
    gfxRoundWorld: false, // Map wrapping (Az <-> Aa)
    gfxLowerBound: 'Hh',  // Bottom-Right map grid sector limit
    gfxAirLock: false,    // True: Scroll triggers ON edge tile. False: Scroll triggers PAST edge tile.

    gfxCommandLog: false, // NEW: If true, saves are echoed natively in the command terminal

    fillTileCode: null, // Holds the active brush code (e.g., 'Za')

    // --- Cursor Walk Variables ---
    gfxCycle: 200,             // Tick speed in ms
    targetCursorZ: -1,         // Destination point
    pendingCursorAction: null, // Queued execution logic
    cursorInterval: null,      // Internal loop pointer

    // Backwards compatibility aliases for older scripts expecting mapx/mapy
    get mapx() { return this.gridWide; },
    set mapx(v) { this.gridWide = v; },
    get mapy() { return this.gridTall; },
    set mapy(v) { this.gridTall = v; },

    // --- State Variables ---
    currentPath: '',
    cursorZ: 0, // In-memory cursor state
    gfxGrid: false, 

    // --- NEW: Unified Save Method ---
    persistState: async function(path, data) {
        // Guarantee data is a string and handle empty/newline payloads gracefully
        let safeData = String(data || "\\n");
        
        if (this.gfxCommandLog && typeof window.CylonCommand === 'function') {
            // Verbose: Send to terminal GUI
            // CLI requires single line strings. Convert real newlines to '\\n' for the parser.
            let cliData = safeData.replace(/\n/g, '\\n');
            if (cliData.trim() === '') cliData = '\\n'; // Ensure DOS <text> argument is never empty
            
            await window.CylonCommand(`save ${path} ${cliData}`);
        } else if (window.parent && window.parent.CylonDOS) {
            // Silent: Direct to IndexedDB/RAM
            await window.parent.CylonDOS.save(path, safeData);
        }
    },

    init: async function(startPath) {
        // Setup message listeners
        this.setupListeners();
      
        this.currentPath = startPath;
        let drive = startPath.split(':')[0]; 
        
        if (window.CylonSDK && window.CylonSDK.injectDesktopStyles) {
            window.CylonSDK.injectDesktopStyles();
        }

        // 1. Load GFX Variables from VFS
        let tDir = await window.qdosLoad(`${drive}:/a/gfxTileDir`);
        let iDir = await window.qdosLoad(`${drive}:/a/gfxIconDir`);
        let cDir = await window.qdosLoad(`${drive}:/a/gfxCharDir`);
        let mDir = await window.qdosLoad(`${drive}:/a/gfxMapsDir`);
        let tSize = await window.qdosLoad(`${drive}:/a/gfxTileSize`);
        
        let gWide = await window.qdosLoad(`${drive}:/a/gfxGridWide`);
        if (!gWide) gWide = await window.qdosLoad(`${drive}:/a/mapx`); // Legacy Fallback
        
        let gTall = await window.qdosLoad(`${drive}:/a/gfxGridTall`);
        if (!gTall) gTall = await window.qdosLoad(`${drive}:/a/mapy`); // Legacy Fallback
        
        let gStretch = await window.qdosLoad(`${drive}:/a/gfxGridStretch`);
        let cz = await window.qdosLoad(`${drive}:/a/gfxCursorZ`);
        
        // --- Spatial Navigation Variables ---
        let rWorld = await window.qdosLoad(`${drive}:/a/gfxRoundWorld`);
        let lBound = await window.qdosLoad(`${drive}:/a/gfxLowerBound`);
        let aLock = await window.qdosLoad(`${drive}:/a/gfxAirLock`);
        
        let cLog = await window.qdosLoad(`${drive}:/a/gfxCommandLog`);

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

        // Load custom walk cycle time
        let cycleStr = await window.qdosLoad(`${drive}:/a/gfxCycle`);
        if (cycleStr) {
            let val = parseFloat(cycleStr.trim());
            if (!isNaN(val)) this.gfxCycle = Math.floor(val * 1000); 
        }

        // 3. Restore Cursor & Start Clock
        this.cursorZ = cz ? parseInt(cz, 10) : 0;
        if (isNaN(this.cursorZ)) this.cursorZ = 0;
        
        this.startCursorTick();

        window.dispatchEvent(new Event('resize'));
        await this.renderScreen();
    },

    setupListeners: function() {
        if (!this._listenersAdded) {
            window.addEventListener('message', async (e) => {
                if (e.data.type === 'QANDY_GFX_CMD') {
                    await this.handleGfxCommand(e.data.cmd, e.data.data);
                }
            });
            this._listenersAdded = true;
        }

        const wrapper = document.getElementById('desktop-wrapper');
        if (wrapper && !this._bgClickBound) {
            // Unify all left clicks (icons and background alike)
            wrapper.addEventListener('pointerup', (e) => {
                if (e.button !== 0 && e.pointerType === 'mouse') return;
                
                // === NEW UX: TOUCH/CLICK TO DISMISS MENU ===
                if (window.parent && window.parent.CylonPopManager) {
                    // Check if a context menu is currently open in the parent DOM.
                    // NOTE: Change '.context-menu' to the actual CSS class or ID of your pop window!
                    let activeMenu = window.parent.document.querySelector('.context-menu'); 
                    
                    // If the menu exists and is visible on screen...
                    if (activeMenu && activeMenu.style.display !== 'none') {
                        // Close it via the OS Manager (or fallback to hiding it manually)
                        if (typeof window.parent.CylonPopManager.hideContextMenu === 'function') {
                            window.parent.CylonPopManager.hideContextMenu();
                        } else {
                            activeMenu.style.display = 'none'; 
                        }
                        
                        // ABORT! Return early so the cursor DOES NOT move and a new menu doesn't open.
                        return; 
                    }
                }
                // ===========================================
                
                let rect = wrapper.getBoundingClientRect();
                let pctX = (e.clientX - rect.left) / rect.width;
                let pctY = (e.clientY - rect.top) / rect.height;
                let x = Math.floor(pctX * this.gridWide);
                let y = Math.floor(pctY * this.gridTall);
                
                // Keep it strictly clamped to visual bounds
                x = Math.max(0, Math.min(x, this.gridWide - 1));
                y = Math.max(0, Math.min(y, this.gridTall - 1));
                let z = y * this.gridWide + x;
                
                this.walkToZ(z, () => this.showTileMenu(z));
            });

            // Handle right clicks directly (instantly snap cursor and show menu)
            wrapper.addEventListener('contextmenu', (e) => {
                e.preventDefault();

                // Force close any existing menus first
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

                this.targetCursorZ = -1; // stop walking
                this.setCursorZ(z);
                this.showTileMenu(z);
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
                    if (this.gfxCommandLog) window.parent.print(`[.4]GFX Fill Mode ENGAGED: brush set to [${data}][.]\n`);
                } else {
                    this.fillTileCode = null;
                    if (this.gfxCommandLog) window.parent.print(`[.2]GFX Fill Mode DISABLED.[.]\n`);
                }
                break;

            case 'tele':
                if (data) {
                    // Re-initialize the graphics engine pointing at the new sector
                    let drive = this.currentPath.split(':')[0] || 'ram';
                    await this.init(`${drive}:/w/${data}`);
                    
                    // Persist the location
                    await this.persistState(`${drive}:/a/gfxSector`, data);
                    if (this.gfxCommandLog) window.parent.print(`[.3]Teleported to sector: ${data}[.]\n`);
                }
                break;
                
            case 'icon':
                if (data) {
                    let parts = data.trim().split(/\s+/);
                    let code = parts[0];
                    let name = parts.slice(1).join(' ');
                    
                    if (code && code.length >= 2 && name && name.length >= 3) {
                        code = code.substring(0, 2); // strictly exact 2 characters
                        let zHex = this.cursorZ.toString(16).padStart(2, '0').toLowerCase();
                        let filename = code + zHex + name;
                        
                        let pathPrefix = this.currentPath.endsWith('/') ? this.currentPath : this.currentPath + '/';
                        let filePath = `${pathPrefix}${filename}`;
                        
                        // Generates an empty script file representing the icon using literal \n
                        await this.persistState(filePath, "\\n");
                        if (this.gfxCommandLog) window.parent.print(`[.4]GFX Engine: Created icon '${name}' at Z:${this.cursorZ}[.]\n`);
                        this.renderScreen();
                    } else {
                        if (this.gfxCommandLog) window.parent.print(`[.4]GFX Error: 'gfx icon [2-char code] [>=3-char name]' required.[.]\n`);
                    }
                }
                break;

            case 'run':
                if (data) {
                    let parts = data.trim().split(/\s+/);
                    let name = parts[0];
                    let commands = data.substring(name.length).trim();
                    
                    if (name && name.length >= 3 && commands) {
                        let zHex = this.cursorZ.toString(16).padStart(2, '0').toLowerCase();
                        let dos = window.parent.CylonDOS;
                        let files = [];
                        try { files = await dos.dir(this.currentPath); } catch (e) {}
                        
                        let targetFile = null;
                        for (let file of files) {
                            let fname = file.name.substring(file.name.lastIndexOf('/') + 1);
                            // Avoid maps ('m') and tilemaps ('t')
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
                            if (this.gfxCommandLog) window.parent.print(`[.4]GFX Engine: Saved run script for icon '${name}'.[.]\n`);
                        } else {
                            if (this.gfxCommandLog) window.parent.print(`[.4]GFX Error: Icon '${name}' not found at cursor Z:${this.cursorZ}.[.]\n`);
                        }
                    } else {
                        if (this.gfxCommandLog) window.parent.print(`[.4]GFX Error: 'gfx run [icon name] [commands]' required.[.]\n`);
                    }
                }
                break;                
        }
    },

    renderScreen: async function() {
        let dos = window.parent.CylonDOS;
        const iconsLayer = document.getElementById('icons-layer');
        const tilesLayer = document.getElementById('tiles-layer');
        if (!iconsLayer) return;

        // --- Apply Sysop Grid Visualization ---
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
        
        // Clean out icons, but keep the cursor if it exists to preserve animation
        Array.from(iconsLayer.children).forEach(child => {
            if (child.id !== 'gfx-sys-cursor') child.remove();
        });

        // --- RENDER BACKGROUND TILES ---
        if (tilesLayer) tilesLayer.innerHTML = '';
        
        let tData = "";
        try {
            tData = await dos.load(`${this.currentPath}/t`);
        } catch (e) { /* File doesn't exist yet */ }

        if (tData) {
            let expectedLen = this.gridWide * this.gridTall * 2;
            if (tData.length < expectedLen) {
                let needed = (expectedLen - tData.length) / 2;
                if (needed > 0) tData += 'Za'.repeat(Math.ceil(needed));
            }
            if (tilesLayer) {
                for (let z = 0; z < this.gridWide * this.gridTall; z++) {
                    let code = tData.substring(z * 2, z * 2 + 2);
                    
                    // 'Za' denotes a transparent tile, let the bg-canvas shine through natively
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
        try {
            files = await dos.dir(this.currentPath);
        } catch (e) {
            console.warn("GFX: Sector empty or missing:", e.message);
            return;
        }

        let drive = this.currentPath.split(':')[0] || 'ram';

        for (let file of files) {
            let filename = file.name.substring(file.name.lastIndexOf('/') + 1);

            // Skip 'm' map properties, 't' tile maps, and directories
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
        
        // Ensure cursor is drawn on top
        this.renderCursor();
    },

    buildSprite: function(iconId, x, y, z, labelText, fullPath) {
        const iconsLayer = document.getElementById('icons-layer');
        const self = this;
        
        let wrap = document.createElement('div');
        wrap.className = 'icon-wrap';
        
        // Attach data attributes so the menu generator can find it
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
            cursorEl = document.createElement('div');
            cursorEl.id = 'gfx-sys-cursor';
            cursorEl.style.position = 'absolute';
            cursorEl.style.boxSizing = 'border-box';
            cursorEl.style.border = '2px solid var(--sel-fg, #0f0)';
            cursorEl.style.boxShadow = '0 0 10px var(--sel-bg, #000) inset, 0 0 10px var(--sel-fg, #0f0)';
            cursorEl.style.borderRadius = '6px';
            cursorEl.style.pointerEvents = 'none'; // Essential: Allows clicking icons beneath it
            cursorEl.style.zIndex = '1000';
            iconsLayer.appendChild(cursorEl);
        }
        
        cursorEl.style.transition = `top ${transTime}s linear, left ${transTime}s linear`;

        let x = this.cursorZ % this.gridWide;
        let y = Math.floor(this.cursorZ / this.gridWide);

        cursorEl.style.left = ((x / this.gridWide) * 100) + '%';
        cursorEl.style.top = ((y / this.gridTall) * 100) + '%';
        cursorEl.style.width = ((1 / this.gridWide) * 100) + '%';
        cursorEl.style.height = ((1 / this.gridTall) * 100) + '%';
    },

    setCursorZ: function(newZ) {
        this.cursorZ = newZ;
        this.renderCursor();
        
        let drive = this.currentPath.split(':')[0] || 'ram';
        let zStr = this.cursorZ.toString().padStart(2, '0');
        
        this.persistState(`${drive}:/a/gfxCursorZ`, zStr);
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

        // Wrap X-Axis
        if (xCode < minX) { xCode = maxX; wrapped = true; }
        else if (xCode > maxX) { xCode = minX; wrapped = true; }

        // Wrap Y-Axis
        if (yCode < minY) { yCode = maxY; wrapped = true; }
        else if (yCode > maxY) { yCode = minY; wrapped = true; }

        // Block if hitting an edge on a flat world
        if (wrapped && !roundWorld) return null; 

        return String.fromCharCode(yCode) + String.fromCharCode(xCode);
    },

    moveCursor: function(dx, dy) {
        let x = this.cursorZ % this.gridWide;
        let y = Math.floor(this.cursorZ / this.gridWide);
        
        let nx = x + dx;
        let ny = y + dy;
        
        let dirChar = null;
        let triggersScroll = false;
        let moveBlocked = false;

        // Evaluate scrolling logic based on AirLock boundaries 
        // Identical algorithm trace to UNIVAC processing GFX_COLS - 1
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
            // Trigger when stepping PAST the edge tile naturally
            if (nx >= this.gridWide) { dirChar = 'E'; triggersScroll = true; }
            else if (nx < 0) { dirChar = 'W'; triggersScroll = true; }
            if (ny >= this.gridTall) { dirChar = 'S'; triggersScroll = true; }
            else if (ny < 0) { dirChar = 'N'; triggersScroll = true; }
        }

        // 1. Hard block if they walk off the edge of an AirLock or Flat Earth boundary
        if (moveBlocked) {
            this.targetCursorZ = -1; // Snap stop pathfinding
            return;
        }

        // 2. Teleport / Map Transition
        if (triggersScroll && dirChar) {
            let parts = this.currentPath.split('/');
            let currentSector = parts[parts.length - 1];
            let driveBase = this.currentPath.substring(0, this.currentPath.lastIndexOf('/'));

            let nextSector = this.calculateTargetSector(currentSector, dirChar, this.gfxLowerBound, this.gfxRoundWorld);

            if (nextSector) {
                let targetZ;

                if (this.gfxAirLock) {
                    // Placed securely on the exact opposite edge of the new map (index 0 or max-1)
                    if (dirChar === 'E') targetZ = (ny * this.gridWide) + 0;
                    if (dirChar === 'W') targetZ = (ny * this.gridWide) + (this.gridWide - 1);
                    if (dirChar === 'S') targetZ = (0 * this.gridWide) + nx;
                    if (dirChar === 'N') targetZ = ((this.gridTall - 1) * this.gridWide) + nx;
                } else {
                    // Standard visual wrapping logic
                    if (nx >= this.gridWide) nx = 0;
                    if (nx < 0) nx = this.gridWide - 1;
                    if (ny >= this.gridTall) ny = 0;
                    if (ny < 0) ny = this.gridTall - 1;
                    targetZ = (ny * this.gridWide) + nx;
                }

                this.targetCursorZ = -1; // End active pathfinding trace since we are swapping maps natively
                this.currentPath = driveBase + '/' + nextSector;
                this.setCursorZ(targetZ);

                // Persist the new location to the state
                let drive = driveBase.split(':')[0] || 'ram';
                this.persistState(`${drive}:/a/gfxSector`, nextSector);

                this.renderScreen();
                return;
            } else {
                // Flat earth edge: block movement cleanly
                this.targetCursorZ = -1;
                return; 
            }
        }

        // 3. Normal bounds checking fallback
        if (nx < 0) nx = 0;
        if (nx >= this.gridWide) nx = this.gridWide - 1;
        if (ny < 0) ny = 0;
        if (ny >= this.gridTall) ny = this.gridTall - 1;
        
        this.setCursorZ(ny * this.gridWide + nx);

        if (this.fillTileCode && typeof this.setTileAtCursor === 'function') {
            this.setTileAtCursor(this.fillTileCode);
        }
    },

    walkToZ: function(newZ, action = null) {
        this.targetCursorZ = newZ;
        this.pendingCursorAction = action;
        
        // If we're already there, act immediately without waiting for the next physical tick
        if (this.cursorZ === this.targetCursorZ) {
            this.targetCursorZ = -1;
            if (this.pendingCursorAction) {
                this.pendingCursorAction();
                this.pendingCursorAction = null;
            }
        }
    },

    startCursorTick: function() {
        if (this.cursorInterval) clearInterval(this.cursorInterval);
        
        // Hard-block browsers from seizing on dangerously low ticks
        let safeCycle = Math.max(50, this.gfxCycle); 
        this.cursorInterval = setInterval(() => this.cursorTick(), safeCycle);
    },

    cursorTick: function() {
        if (this.targetCursorZ === -1) return;

        // Final check and commit execution block
        if (this.cursorZ === this.targetCursorZ) {
            this.targetCursorZ = -1;
            if (this.pendingCursorAction) {
                this.pendingCursorAction();
                this.pendingCursorAction = null;
            }
            return;
        }

        // Apply a greedy pathfinding formula step
        let cx = this.cursorZ % this.gridWide;
        let cy = Math.floor(this.cursorZ / this.gridWide);
        let tx = this.targetCursorZ % this.gridWide;
        let ty = Math.floor(this.targetCursorZ / this.gridWide);

        let dx = tx - cx;
        let dy = ty - cy;

        let stepX = 0;
        let stepY = 0;

        // Heavily weight the longest remaining distance, resolving diagonal biases automatically
        if (Math.abs(dx) > Math.abs(dy)) {
            stepX = dx > 0 ? 1 : -1;
        } else if (Math.abs(dy) > Math.abs(dx)) {
            stepY = dy > 0 ? 1 : -1;
        } else {
            stepX = dx > 0 ? 1 : -1;
        }

        // Route through default cursor mechanics (Triggers brush code intrinsically!)
        this.moveCursor(stepX, stepY);
    },

    executeCursor: function() {
        // Trigger tile menu exactly where the cursor arrived (usually fired by keyboard interaction)
        this.showTileMenu(this.cursorZ);
    },

    // ----------------------------
    
    showTileMenu: function(z) {
        if (!window.parent || !window.parent.CylonPopManager || typeof window.parent.CylonPopManager.showContextMenu !== 'function') {
            console.warn("GFX Warning: Context menu manager unavailable.");
            return;
        }

        let items = [];
        
        // 1. Find all graphical objects sharing this exact spatial tile
        let iconWraps = document.querySelectorAll(`.icon-wrap[data-z="${z}"]`);
        iconWraps.forEach(wrap => {
            let labelText = wrap.getAttribute('data-label');
            let fullPath = wrap.getAttribute('data-path');
            if (labelText && fullPath) {
                items.push({
                    label: 'Open ' + labelText,
                    action: () => this.executeScript(fullPath)
                });
                items.push({
                    label: 'Remove ' + labelText,
                    action: () => this.removeScript(fullPath)
                });
            }
        });

        // 2. Perform bounding calculations to check for valid edge-scrolling exits
        let x = z % this.gridWide;
        let y = Math.floor(z / this.gridWide);
        let parts = this.currentPath.split('/');
        let currentSector = parts[parts.length - 1];

        let addScroll = (dirChar, label, dx, dy) => {
            let nextSector = this.calculateTargetSector(currentSector, dirChar, this.gfxLowerBound, this.gfxRoundWorld);
            if (nextSector) {
                items.push({
                    label: label,
                    action: () => this.moveCursor(dx, dy)
                });
            }
        };

        if (y === 0) addScroll('N', 'Scroll North', 0, -1);
        if (y === this.gridTall - 1) addScroll('S', 'Scroll South', 0, 1);
        if (x === this.gridWide - 1) addScroll('E', 'Scroll East', 1, 0);
        if (x === 0) addScroll('W', 'Scroll West', -1, 0);

        // 3. Informational empty state if no icons and no scrolling
        if (items.length === 0) {
            items.push({
                label: 'To add icon input: gfx icon [code] [name]',
                action: null
            });
        }

        // 4. Calculate absolute tile center relative to viewport to cleanly mount context menu over top
        const wrapper = document.getElementById('desktop-wrapper');
        let rect = wrapper.getBoundingClientRect();
        let w = rect.width / this.gridWide;
        let h = rect.height / this.gridTall;
        
        let clientX = rect.left + (x + 0.5) * w;
        let clientY = rect.top + (y + 0.5) * h;

        let mockEvent = { clientX, clientY, view: window };
        
        window.parent.CylonPopManager.showContextMenu(mockEvent, items);
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
                // Delete the physical script file representing the icon
                await window.parent.CylonDOS.delete(filePath);
                
                // Immediately refresh the desktop to make the icon vanish
                this.renderScreen();
            } catch(err) {
                console.error("GFX Error: Could not remove icon file.", err);
            }
        }
    },

    setTileAtCursor: async function(code) {
        let dos = window.parent.CylonDOS;
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
            let currentCode = tData.substring(this.cursorZ * 2, this.cursorZ * 2 + 2) || 'Za';
            // Print straight to the native command prompt
            if (this.gfxCommandLog) window.print(`\n[.3]GFX Tile Engine: Tile at Cursor (${this.cursorZ}) is [${currentCode}][.]\n`);
            return;
        }

        // Protect file map structure sizes
        code = String(code).padEnd(2, 'a').substring(0, 2);
        
        let prefix = tData.substring(0, this.cursorZ * 2);
        let suffix = tData.substring(this.cursorZ * 2 + 2);
        tData = prefix + code + suffix;

        // Save natively to sector structure
        await this.persistState(tPath, tData);

        // Update DOM instantly rather than performing a full re-render
        this.updateTileDOM(this.cursorZ, code);
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
            existing.style.display = ''; // Reset display in case it failed over previously
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