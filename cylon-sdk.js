/* --- QANDY POCKET COMPUTER SDK: UI & VIDEO BINDINGS --- */
(function() {
// ========================================================================
// 1. INPUT INTERCEPTION (Keyboard & Textarea handling)
// ========================================================================
let autoIdCounter = 0;
let trackedEl = null;
let resizeObs = null;

function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

function reportRect(el) {
    if (!el || !el.isConnected) return;
    window.parent.postMessage({
        type: 'QANDY_INPUT_RECT',
        id: el.id,
        rect: rectOf(el)
    }, '*');
}

function trackElement(el) {
    if (resizeObs) resizeObs.disconnect();
    trackedEl = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    resizeObs = new ResizeObserver(() => reportRect(trackedEl));
    resizeObs.observe(el);
    resizeObs.observe(document.body);
}

function stopTracking() {
    if (resizeObs) resizeObs.disconnect();
    resizeObs = null;
    trackedEl = null;
}

function getFieldLabel(el) {
    if (el.placeholder) return el.placeholder;
    if (el.title) return el.title;
    if (el.name) return el.name;
    if (el.id && !el.id.startsWith('qandy-input-auto')) return el.id;
    return el.tagName === 'TEXTAREA' ? 'TEXT' : 'INPUT';
}

function handleInputTap(e) {
    const el = e.target;
    if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))) {
        el.setAttribute('inputmode', 'none');

        if (e.type === 'pointerdown' || (e.type === 'mousedown' && e.pointerType === undefined)) {
            if (!el.id) el.id = 'qandy-input-auto-' + (autoIdCounter++);
            
            window.parent.postMessage({
                type: 'QANDY_REQ_INPUT',
                id: el.id,
                value: el.value,
                isMultiline: el.tagName === 'TEXTAREA',
                label: getFieldLabel(el),
                rect: rectOf(el)
            }, '*');

            trackElement(el);
        }
    }
}

document.addEventListener('pointerdown', handleInputTap, { capture: true, passive: false });
document.addEventListener('mousedown', handleInputTap, { capture: true, passive: false });
document.addEventListener('touchstart', handleInputTap, { capture: true, passive: false });

window.addEventListener('message', (e) => {
    if (e.data.type === 'QANDY_UPDATE_INPUT' || e.data.type === 'QANDY_COMMIT_INPUT') {
        const el = document.getElementById(e.data.id);
        if (el) {
            el.value = e.data.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));

            if (e.data.type === 'QANDY_COMMIT_INPUT') {
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur(); 
                stopTracking();
            } else {
                requestAnimationFrame(() => reportRect(el));
            }
        }
    }
});

// ========================================================================
// 2. GRAPHICS & DESKTOP RENDERING LIBRARY
// ========================================================================

window.CylonSDK = window.CylonSDK || {};
window.CylonSDK.apps = {}; // Global app registry for popups

/**
 * Register apps for desktop/popup launching.
 */
window.CylonSDK.registerApps = function(appMap) {
    Object.assign(window.CylonSDK.apps, appMap);
};

/**
 * Injects the shared responsive icon grid and background CSS into the document.
 */
window.CylonSDK.injectDesktopStyles = function() {
    if (document.getElementById('cylon-sdk-desktop-styles')) return;
    
    // This defaults to 64px, constraining our 82x82 icons precisely.
    let tileSize = parseInt(localStorage.getItem('qandy_display_res')) || 64; 
    
    const style = document.createElement('style');
    style.id = 'cylon-sdk-desktop-styles';
    style.textContent = `
        :root { --tile-size: ${tileSize}px; }
        html, body {
            margin: 0; padding: 0; overflow: hidden; height: 100%; width: 100%;
            background-color: #008080;
            background-image: url('desktop-bg.jpg');
            background-size: cover; background-position: center; background-repeat: no-repeat;
        }
        .cylon-grid-container {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
            grid-auto-rows: 100px; gap: 15px; padding: 20px;
            width: 100%; height: 100%; box-sizing: border-box;
            align-content: start; overflow-y: auto;
        }
        .gfx-icon {
            display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
            cursor: pointer; z-index: 10;
        }
        .gfx-icon img {
            width: var(--tile-size); height: var(--tile-size);
            object-fit: contain; image-rendering: pixelated;
            filter: drop-shadow(2px 2px 3px rgba(0,0,0,0.5));
        }
        .gfx-icon-label {
            margin-top: 5px; color: #fff; font-family: sans-serif; font-size: 13px;
            text-align: center; text-shadow: 1px 1px 2px #000, -1px -1px 2px #000;
            word-wrap: break-word; width: 100%;
        }
    `;
    document.head.appendChild(style);
};

/**
 * Renders a generic array of items into a grid container.
 * items: [{ iconId: 'Ta', label: 'Desktop', action: function(item){...} }, ...]
 */
window.CylonSDK.renderIconGrid = function(containerId, items) {
    let container = document.getElementById(containerId);
    if (!container) return;
    
    container.innerHTML = '';
    container.classList.add('cylon-grid-container');

    items.forEach(item => {
        let iconWrap = document.createElement('div');
        iconWrap.className = 'gfx-icon';
        iconWrap.title = item.title || item.label;

        let img = document.createElement('img');
        // Allow absolute paths if requested, otherwise default to i/ folder
        img.src = item.iconPath || `i/${item.iconId}.png`;
        
        // Fallback if image is missing. Nulling out `onerror` fixes the rapid blinking bug!
        img.onerror = function() { 
            this.onerror = null; 
            this.src = 'q/file.png'; 
        }; 

        let label = document.createElement('div');
        label.className = 'gfx-icon-label';
        label.textContent = item.label;

        iconWrap.appendChild(img);
        iconWrap.appendChild(label);

        if (item.action) {
            iconWrap.onclick = (e) => item.action(item, e);
        }

        container.appendChild(iconWrap);
    });
};

/**
 * Fetches a map file (.gfx) via CylonDOS and parses out a specific sector into an items array.
 */
window.CylonSDK.getGFXSectorItems = async function(filename, sectorId) {
    if (!window.parent || !window.parent.CylonDOS) throw new Error("CylonDOS not available.");
    
    let gfxData = await window.parent.CylonDOS.load(filename);
    if (!gfxData) throw new Error("Could not load map file: " + filename);

    let items = [];
    let lines = gfxData.split('\n');
    
    for (let line of lines) {
        let eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;

        let label = line.substring(0, eqIdx);
        if (label === sectorId) {
            let content = line.substring(eqIdx + 1);
            let parts = content.split('.');
            let itemsData = parts[1] || "";
            
            if (itemsData) {
                itemsData.split('~').forEach(c => {
                    if (!c) return;
                    let [meta, logic] = c.split('|');
                    if (meta.length >= 4) {
                        let id = meta.substring(0, 2);
                        let z = meta.substring(2, 4);
                        
                        // Try to resolve human-readable label from the global apps registry
                        let app = window.CylonSDK.apps[id];
                        
                        items.push({
                            iconId: id,
                            label: app ? app.title : id,
                            zLocation: z,
                            originalId: id
                        });
                    }
                });
            }
            break; // Found sector, stop parsing
        }
    }
    return items;
};

/**
 * Standard click action for graphical icons (generates popup menu)
 */
window.CylonSDK.showAppPopup = function(item) {
    let itemId = item.iconId;
    let app = window.CylonSDK.apps[itemId];
    let html = '';

    if (!app) {
        html = `<div style="text-align: center; padding: 8px;"><p><strong>Item: ${itemId}</strong></p><p>(No app bound)</p></div>`;
    } else {
        html = `
        <div style="text-align: center; padding: 8px;">
            <div style="margin-bottom: 8px;">
                <img src="i/${itemId}.png" style="width: 64px; height: 64px; image-rendering: pixelated;" />
            </div>
            <div style="font-weight: bold; margin: 6px 0;">
                <strong>${app.title}</strong>
            </div>
            <div style="font-size: 11px; color: #666; margin: 4px 0;">
                ItemID: <code>${itemId}</code>
            </div>
            <div style="margin-top: 10px;">
                <a href="gfx:launch_${itemId}" style="
                    display: inline-block; padding: 6px 12px;
                    background-color: #0066cc; color: white;
                    text-decoration: none; border-radius: 3px;
                    cursor: pointer; font-size: 12px;
                ">Open ${app.title}</a>
            </div>
        </div>`;
    }

    // Trigger the OS popup
    if (typeof window.parent.popHtm === 'function') {
        if (window.parent.PopAlign !== undefined) window.parent.PopAlign = "click";
        if (item.zLocation) window.parent.lastClickedZ = parseInt(item.zLocation, 16); 
        window.parent.popHtm(html);
    } else if (typeof popHtm === 'function') {
        popHtm(html);
    } else {
        // Fallback direct launch if popups aren't available
        if (app && window.parent && window.parent.PageOpen) {
            window.parent.PageOpen(app.file, app.title);
        }
    }
};

/**
 * Renders a list/tree view of items into a container.
 */

window.CylonSDK.renderListGrid = function(containerId, items) {
    let container = document.getElementById(containerId);
    if (!container) return;
    
    container.innerHTML = '';
    container.className = ''; // Remove CSS grid classes
    container.style.cssText = 'display: flex; flex-direction: column; padding: 10px; overflow-y: auto; height: 100%; box-sizing: border-box; background-color: #008080; background-image: url("desktop-bg.jpg"); background-size: cover; background-position: center; background-attachment: fixed;';

    items.forEach(item => {
        let row = document.createElement('div');
        row.style.cssText = `display: flex; align-items: center; padding: 6px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.2); transition: background 0.1s;`;
        
        row.onmouseover = () => row.style.background = 'rgba(255,255,255,0.1)';
        row.onmouseout = () => row.style.background = 'transparent';

        // Add visual indentation for trees
        let indent = (item.level || 0) * 24;
        row.style.paddingLeft = (6 + indent) + 'px';

        let img = document.createElement('img');
        img.src = item.iconPath || 'q/file.png';
        img.style.cssText = 'width: 24px; height: 24px; image-rendering: pixelated; margin-right: 12px; filter: drop-shadow(1px 1px 2px rgba(0,0,0,0.5));';
        img.onerror = function() { this.onerror = null; this.src = 'q/file.png'; };

        let label = document.createElement('div');
        label.textContent = item.label;
        label.style.cssText = 'flex: 1; color: white; font-family: monospace; font-size: 16px; text-shadow: 1px 1px 2px #000;';

        row.appendChild(img);
        row.appendChild(label);

        if (item.action) {
            row.onclick = (e) => item.action(item, e);
        }

        container.appendChild(row);
    });
};

// ========================================================================
// 3. GLOBAL LISTENERS
// ========================================================================

// Listen for popup "Open Application" clicks natively and System Menus
if (!window.cylonSDKLaunchListenerAdded) {
    window.addEventListener('message', function(event) {
        const data = event.data;
        if (!data || typeof data !== 'object') return;

        // Route System Menu requests
        if (data.type === 'QANDY_OS_MENU') {
            if (typeof window.CylonSDK.onSystemMenu === 'function') {
                window.CylonSDK.onSystemMenu();
            }
        }
        if (data.type === 'gfx' && data.cmd && data.cmd.startsWith('launch_')) {
            let itemId = data.cmd.substring('launch_'.length);
            let app = window.CylonSDK.apps[itemId];

            if (app && window.parent && window.parent.PageOpen) {
                if (typeof window.parent.hpop === 'function') window.parent.hpop();
                else if (typeof hpop === 'function') hpop();
                window.parent.PageOpen(app.file, app.title);
            }
        }
    });
    window.cylonSDKLaunchListenerAdded = true;
}
})();