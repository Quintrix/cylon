/*
 * Cylon Desktop Environment & Window Manager
 * A local, single-player adaptation of the Qandyland GFX engine.
 */

(function(global) {
    'use strict';

    // --- DESKTOP GFX CONFIGURATION ---
    const TILE_SIZE = 32;
    const TOP_OFFSET = 10;
    const LEFT_OFFSET = 10;
    const DESKTOP_FILE = 'desktop.gfx';

    // Desktop State
    let desktopTiles = ""; // 192 characters (96 tiles * 2 chars)
    let desktopIcons = []; // Array of { id: 'Ta', z: 5 }

    // --- APP BINDINGS ---
    // Maps GFX Item IDs to the apps they launch
    const ICON_APPS = {
        'Ta': { file: 'lunar.htm', title: 'LUNAR LANDER' },
        'Tb': { file: 'capflag.htm', title: 'CAPTURE THE FLAG' },
        'Tc': { file: 'gfx-create.htm', title: 'MAP CREATOR' },
        'Td': { file: 'gfx-viewer.htm', title: 'GFX VIEWER' }
    };

    // --- WINDOW MANAGER STATE ---
    global.openPages = {};
    global.activePage = null;
    global.activeAppTitle = "";

    // ============================================================================
    // DESKTOP GFX ENGINE (Local, Drag & Drop)
    // ============================================================================

    function parseDesktopGfx(raw) {
        // Format: DESK=[192 chars].[Ta00~Tb02]
        let eqIdx = raw.indexOf('=');
        if (eqIdx < 0) return;
        
        let rest = raw.substring(eqIdx + 1);
        let dotIdx = rest.indexOf('.');
        
        desktopTiles = dotIdx >= 0 ? rest.substring(0, dotIdx) : rest;
        let iconData = dotIdx >= 0 ? rest.substring(dotIdx + 1) : '';
        
        desktopIcons = [];
        if (iconData) {
            let items = iconData.split('~');
            items.forEach(itm => {
                if (itm.length >= 4) {
                    desktopIcons.push({
                        id: itm.substring(0, 2),
                        z: parseInt(itm.substring(2, 4), 10)
                    });
                }
            });
        }
    }

    async function saveDesktop() {
        // Serialize state back to GFX string
        let iconStrs = desktopIcons.map(ic => ic.id + String(ic.z).padStart(2, '0')).join('~');
        let gfxString = `DESK=${desktopTiles}.${iconStrs}`;
        await global.CylonDOS.save(DESKTOP_FILE, gfxString, { owner: 'system' });
    }

    function zToXY(z) {
        let y = Math.floor(z / (MAPX + 1));
        let x = z % (MAPX + 1);
        return { x: x, y: y };
    }

    function xyToZ(x, y) {
        if (x < 0 || x > MAPX || y < 0 || y > MAPY) return -1;
        return (y * (MAPX + 1)) + x;
    }

    // ============================================================================
    // WINDOW & TASKBAR MANAGER
    // ============================================================================

    function pageContainer() {
        return document.getElementById('browser-layer-container');
    }

    global.showTerminal = function() {
        document.getElementById('video-layer').style.display = 'flex'; 
        pageContainer().style.display = 'none';
        document.body.classList.remove('app-mode');
        
        if (activePage && openPages[activePage]) {
            openPages[activePage].classList.remove('active');
        }
        activePage = null;
        activeAppTitle = "";
        
        global.hideFullKeyboard(); 
        updateTaskbar();
    };

    global.showPage = function(filename, title) {
        document.getElementById('video-layer').style.display = 'none';
        pageContainer().style.display = 'block';
        document.body.classList.add('app-mode');
        
        activePage = filename;
        activeAppTitle = title || filename.toUpperCase();
        
        Object.keys(openPages).forEach(n => {
            openPages[n].classList.toggle('active', n === filename);
        });
        
        global.hideFullKeyboard(); 
        updateTaskbar();
    };

    global.PageOpen = function(filename, title) {
        if (openPages[filename]) {
            showPage(filename, title);
            return;
        }

        let frame = document.createElement('iframe');
        frame.className = 'page-frame';
        frame.src = filename;
        pageContainer().appendChild(frame);
        
        openPages[filename] = frame;
        // Store title on the frame for the taskbar to read
        frame.dataset.title = title || filename; 

        showPage(filename, title);
    };

    global.PageClose = function(filename) {
        if (!openPages[filename]) return;

        openPages[filename].remove();
        delete openPages[filename];

        if (activePage === filename) {
            let remaining = Object.keys(openPages);
            if (remaining.length) {
                let last = remaining[remaining.length - 1];
                showPage(last, openPages[last].dataset.title);
            } else {
                showTerminal();
            }
        } else {
            updateTaskbar();
        }
    };

    // Rebuilds the Taskbar tabs dynamically
    function updateTaskbar() {
        let taskbarList = document.getElementById('taskbar-app-list');
        if (!taskbarList) return;

        taskbarList.innerHTML = ''; // Clear

        Object.keys(openPages).forEach(filename => {
            let btn = document.createElement('div');
            btn.className = 'taskbar-app-tab';
            if (filename === activePage) btn.classList.add('active');
            
            btn.textContent = openPages[filename].dataset.title;
            
            // Left click to switch, right/middle click to close (optional standard)
            btn.onclick = () => showPage(filename, btn.textContent);
            
            taskbarList.appendChild(btn);
        });
    }

})(typeof window !== 'undefined' ? window : globalThis);