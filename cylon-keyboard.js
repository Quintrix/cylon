window.normalKeys = {
    '`':'`', '1':'1', '2':'2', '3':'3', '4':'4', '5':'5', '6':'6', '7':'7', '8':'8', '9':'9', '0':'0',
    '-':'-', '=':'=', '[':'[', ']':']', '\\':'\\', ';':';', "'":"'", ',':',', '.':'.', '/':'/',
    'q':'q', 'w':'w', 'e':'e', 'r':'r', 't':'t', 'y':'y', 'u':'u', 'i':'i', 'o':'o', 'p':'p',
    'a':'a', 's':'s', 'd':'d', 'f':'f', 'g':'g', 'h':'h', 'j':'j', 'k':'k', 'l':'l',
    'z':'z', 'x':'x', 'c':'c', 'v':'v', 'b':'b', 'n':'n', 'm':'m'
};

window.shiftedKeys = {
    '`':'~', '1':'!', '2':'@', '3':'#', '4':'$', '5':'%', '6':'^', '7':'&', '8':'*', '9':'(', '0':')',
    '-':'_', '=':'+', '[':'{', ']':'}', '\\':'|', ';':':', "'":'"', ',':'<', '.':'>', '/':'?',
    'q':'Q', 'w':'W', 'e':'E', 'r':'R', 't':'T', 'y':'Y', 'u':'U', 'i':'I', 'o':'O', 'p':'P',
    'a':'A', 's':'S', 'd':'D', 'f':'F', 'g':'G', 'h':'H', 'j':'J', 'k':'K', 'l':'L',
    'z':'Z', 'x':'X', 'c':'C', 'v':'V', 'b':'B', 'n':'N', 'm':'M'
};

function keyboard() {
    document.getElementById('kb-line1').addEventListener('click', function(e) { handleLineClick(e, 0); });
    document.getElementById('kb-line2').addEventListener('click', function(e) { handleLineClick(e, 1); });

    window.modState = { shift: new Set(), ctrl: new Set(), alt: new Set() };
    window.shift = 0; window.ctrl = 0; window.alt = 0; window.caps = false;
    window.allKeys = [];

    function spacerDef(flex) {
        return {id: '_sp_' + Math.random().toString(36).slice(2), label: '', flex: flex, isSpacer: true};
    }

    function setModifier(type, id, on) {
        if (on) window.modState[type].add(id); else window.modState[type].delete(id);
        window[type] = window.modState[type].size > 0 ? 1 : 0;
    }

    function isLetterKey(lookup) {
        return /^[a-z]$/.test(lookup);
    }

    function computeActiveChar(def) {
        var lookup = def.label.toLowerCase();
        var normal = (window.normalKeys && window.normalKeys[lookup]) || def.label;
        var shifted = (window.shiftedKeys && window.shiftedKeys[lookup]) || def.label;
        var shiftOn = !!window.shift;
        var capsOn = !!window.caps;

        if (isLetterKey(lookup)) {
            return (capsOn !== shiftOn) ? shifted : normal;
        }
        return shiftOn ? shifted : normal;
    }

    function pressDown(e, key, btn) {
        e.preventDefault();
        if (key.isSpacer) return;
        btn.classList.add('active');

        if (key.id === 'lshift' || key.id === 'rshift') {
            setModifier('shift', key.id, true); updateKeyLabels();
        } else if (key.id === 'lctrl' || key.id === 'rctrl') {
            setModifier('ctrl', key.id, true); updateKeyLabels();
        } else if (key.id === 'lalt' || key.id === 'ralt') {
            setModifier('alt', key.id, true); updateKeyLabels();
        } else if (key.id === 'caps') {
            window.caps = !window.caps;
            if (window.caps) btn.classList.add('locked'); else btn.classList.remove('locked');
            updateKeyLabels();
        } else {
            let charToType;
            if (key.id === 'space') charToType = ' ';
            else if (key.noType) charToType = null;
            else if (key.dual) charToType = computeActiveChar(key);
            else charToType = btn.textContent;
            if (window.press) window.press({keyCode: key.keyCode, id: key.id, char: charToType});
        }
    }

    function pressUp(e, key, btn) {
        e.preventDefault();
        if (key.isSpacer) return;
        btn.classList.remove('active');

        if (key.id === 'lshift' || key.id === 'rshift') {
            setModifier('shift', key.id, false); updateKeyLabels();
        } else if (key.id === 'lctrl' || key.id === 'rctrl') {
            setModifier('ctrl', key.id, false); updateKeyLabels();
        } else if (key.id === 'lalt' || key.id === 'ralt') {
            setModifier('alt', key.id, false); updateKeyLabels();
        }
    }

    function makeKeyEl(def) {
        if (def.isSpacer) {
            var spacer = document.createElement('div');
            spacer.style.flex = def.flex;
            spacer.style.visibility = 'hidden';
            return spacer;
        }

        var btn = document.createElement('div');
        btn.className = 'kb-key' + (def.extraClass ? ' ' + def.extraClass : '') + (def.dual ? ' kb-key-dual' : '');
        btn.id = 'kb-' + def.id;
        btn.style.flex = def.flex || 1;
        btn.textContent = def.label;

        if (def.id === 'caps' && window.caps) btn.classList.add('locked');

        btn.addEventListener('touchstart', function(e) { pressDown(e, def, btn); }, {passive: false});
        btn.addEventListener('touchend', function(e) { pressUp(e, def, btn); }, {passive: false});
        btn.addEventListener('touchcancel', function(e) { pressUp(e, def, btn); }, {passive: false});
        btn.addEventListener('mousedown', function(e) { pressDown(e, def, btn); });
        btn.addEventListener('mouseup', function(e) { pressUp(e, def, btn); });
        btn.addEventListener('mouseleave', function(e) { if (btn.classList.contains('active')) pressUp(e, def, btn); });

        window.allKeys.push(def);
        return btn;
    }

    function appendRow(container, rowDefs, rowClass) {
        var rowDiv = document.createElement('div');
        rowDiv.className = rowClass || 'kb-row';
        rowDefs.forEach(function(def) { rowDiv.appendChild(makeKeyEl(def)); });
        container.appendChild(rowDiv);
    }

    // Build Static Keyboard Structure
    var grid = document.getElementById('kb-grid');

    var colsWrap = document.createElement('div');
    colsWrap.className = 'kb-cols-wrap';

    var main = document.createElement('div');
    main.className = 'kb-col kb-main-block';

    var fnRow = document.createElement('div');
    fnRow.className = 'kb-row kb-fn-row';
    fnRow.appendChild(makeKeyEl({id: "esc", label: "Esc", keyCode: 27, flex: 5, noType: true}));

    for (var i = 1; i <= 12; i++) {
        if (i === 5 || i === 9) fnRow.appendChild(makeKeyEl(spacerDef(0.6)));
        var fGrp = document.createElement('div'); fGrp.className = 'kb-row'; fGrp.style.flex = '4';
        fGrp.appendChild(makeKeyEl({id: 'f'+i, label: 'F'+i, keyCode: 111+i, flex: 1, noType: true, extraClass: 'kb-fn-key'}));
        fnRow.appendChild(fGrp);
    }
    main.appendChild(fnRow);

    const mainRows = [
        [ {id:"backtick", label:"`", keyCode:192, flex: 1.5, dual: true}, {id:"n1", label:"1", keyCode:49, flex: 1, dual: true}, {id:"n2", label:"2", keyCode:50, flex: 1, dual: true}, {id:"n3", label:"3", keyCode:51, flex: 1, dual: true}, {id:"n4", label:"4", keyCode:52, flex: 1, dual: true}, {id:"n5", label:"5", keyCode:53, flex: 1, dual: true}, {id:"n6", label:"6", keyCode:54, flex: 1, dual: true}, {id:"n7", label:"7", keyCode:55, flex: 1, dual: true}, {id:"n8", label:"8", keyCode:56, flex: 1, dual: true}, {id:"n9", label:"9", keyCode:57, flex: 1, dual: true}, {id:"n0", label:"0", keyCode:48, flex: 1, dual: true}, {id:"dash", label:"-", keyCode:173, flex: 1, dual: true}, {id:"equal", label:"=", keyCode:61, flex: 1, dual: true}, {id:"back", label:"Back", keyCode:8, flex: 2, noType: true} ],
        [ {id:"tab", label:"Tab", keyCode:9, flex: 1.5, noType: true}, {id:"q", label:"q", keyCode:81, flex: 1, dual: true}, {id:"w", label:"w", keyCode:87, flex: 1, dual: true}, {id:"e", label:"e", keyCode:69, flex: 1, dual: true}, {id:"r", label:"r", keyCode:82, flex: 1, dual: true}, {id:"t", label:"t", keyCode:84, flex: 1, dual: true}, {id:"y", label:"y", keyCode:89, flex: 1, dual: true}, {id:"u", label:"u", keyCode:85, flex: 1, dual: true}, {id:"i", label:"i", keyCode:73, flex: 1, dual: true}, {id:"o", label:"o", keyCode:79, flex: 1, dual: true}, {id:"p", label:"p", keyCode:80, flex: 1, dual: true}, {id:"open", label:"[", keyCode:219, flex: 1, dual: true}, {id:"close", label:"]", keyCode:221, flex: 1, dual: true}, {id:"backslash", label:"\\", keyCode:220, flex: 1.5, dual: true} ],
        [ {id:"caps", label:"Caps", keyCode:20, flex: 1.8, noType: true}, {id:"a", label:"a", keyCode:65, flex: 1, dual: true}, {id:"s", label:"s", keyCode:83, flex: 1, dual: true}, {id:"d", label:"d", keyCode:68, flex: 1, dual: true}, {id:"f", label:"f", keyCode:70, flex: 1, dual: true}, {id:"g", label:"g", keyCode:71, flex: 1, dual: true}, {id:"h", label:"h", keyCode:72, flex: 1, dual: true}, {id:"j", label:"j", keyCode:74, flex: 1, dual: true}, {id:"k", label:"k", keyCode:75, flex: 1, dual: true}, {id:"l", label:"l", keyCode:76, flex: 1, dual: true}, {id:"colon", label:";", keyCode:59, flex: 1, dual: true}, {id:"quote", label:"'", keyCode:222, flex: 1, dual: true}, {id:"enter", label:"Enter", keyCode:13, flex: 2.2, noType: true} ],
        [ {id:"lshift", label:"Shift", keyCode:16, flex: 2.3, noType: true}, {id:"z", label:"z", keyCode:90, flex: 1, dual: true}, {id:"x", label:"x", keyCode:88, flex: 1, dual: true}, {id:"c", label:"c", keyCode:67, flex: 1, dual: true}, {id:"v", label:"v", keyCode:86, flex: 1, dual: true}, {id:"b", label:"b", keyCode:66, flex: 1, dual: true}, {id:"n", label:"n", keyCode:78, flex: 1, dual: true}, {id:"m", label:"m", keyCode:77, flex: 1, dual: true}, {id:"comma", label:",", keyCode:188, flex: 1, dual: true}, {id:"dot", label:".", keyCode:190, flex: 1, dual: true}, {id:"slash", label:"/", keyCode:191, flex: 1, dual: true}, {id:"rshift", label:"Shift", keyCode:16, flex: 2.3, noType: true} ],
        [ {id:"lctrl", label:"Ctrl", keyCode:17, flex: 1.3, noType: true}, {id:"lalt", label:"Alt", keyCode:18, flex: 1.3, noType: true}, {id:"space", label:"Space", keyCode:32, flex: 6}, {id:"ralt", label:"Alt", keyCode:18, flex: 1.3, noType: true}, {id:"rctrl", label:"Ctrl", keyCode:17, flex: 1.3, noType: true} ]
    ];
    mainRows.forEach(function(r) { appendRow(main, r); });
    colsWrap.appendChild(main);

    var nav = document.createElement('div');
    nav.className = 'kb-col kb-nav-block';

    var sidePanel = document.createElement('div');
    sidePanel.id = 'kb-side-panel';
    sidePanel.className = 'kb-row kb-side-panel';
    nav.appendChild(sidePanel);

    const navRows = [
        [ {id:"ins", label:"Ins", keyCode:45, flex:1, noType:true, extraClass:"kb-nav-key"}, {id:"home", label:"Home", keyCode:36, flex:1, noType:true, extraClass:"kb-nav-key"}, {id:"pgup", label:"PgUp", keyCode:33, flex:1, noType:true, extraClass:"kb-nav-key"} ],
        [ {id:"del", label:"Del", keyCode:46, flex:1, noType:true, extraClass:"kb-nav-key"}, {id:"end", label:"End", keyCode:35, flex:1, noType:true, extraClass:"kb-nav-key"}, {id:"pgdn", label:"PgDn", keyCode:34, flex:1, noType:true, extraClass:"kb-nav-key"} ],
        [ spacerDef(1) ],
        [ spacerDef(1), {id:"up", label:"▲", keyCode:38, flex:1, noType:true, extraClass:"kb-nav-key"}, spacerDef(1) ],
        [ {id:"left", label:"◀", keyCode:37, flex:1, noType:true, extraClass:"kb-nav-key"}, {id:"down", label:"▼", keyCode:40, flex:1, noType:true, extraClass:"kb-nav-key"}, {id:"right", label:"▶", keyCode:39, flex:1, noType:true, extraClass:"kb-nav-key"} ]
    ];
    navRows.forEach(function(r) { appendRow(nav, r); });
    colsWrap.appendChild(nav);

    grid.appendChild(colsWrap);

    function updateKeyLabels() {
        window.allKeys.forEach(function(key) {
            var el = document.getElementById('kb-' + key.id);
            if (!el) return;

            if (key.dual) {
                var lookup = key.label.toLowerCase();
                var normal = (window.normalKeys && window.normalKeys[lookup]) || key.label;
                var shifted = (window.shiftedKeys && window.shiftedKeys[lookup]) || key.label;
                var active = computeActiveChar(key);
                
                el.textContent = active;
                if (active === shifted && shifted !== normal) {
                    el.classList.add('active-shift');
                } else {
                    el.classList.remove('active-shift');
                }
            }
        });
    }

    updateKeyLabels();

    var inputViewOffset = 0;
    var lastCharW = 10, lastPromptWidth = 0, lastCharsPerLine = 20;
    var lastLine1Start = 0, lastLine2Start = 0, lastLine1Text = '', lastLine2Text = '';

    function measureLineGeometry() {
        var promptEl = document.getElementById('kb-prompt');
        var wrapEl = document.getElementById('kb-input-lines');
        if (!promptEl || !wrapEl) return {charW: lastCharW, promptWidth: lastPromptWidth, charsPerLine: lastCharsPerLine};
        if (!window._measureCtx) window._measureCtx = document.createElement('canvas').getContext('2d');
        var ctx = window._measureCtx;
        var cs = getComputedStyle(promptEl);
        ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        var charW = ctx.measureText('0').width || 10;
        var promptWidth = ctx.measureText(promptEl.textContent || '').width;
        var totalWidth = wrapEl.clientWidth;
        var charsPerLine = Math.max(1, Math.floor((totalWidth - promptWidth) / charW));
        return {charW: charW, promptWidth: promptWidth, charsPerLine: charsPerLine};
    }

    function buildLineSpans(lineText, showCursor, posInLine, lineGlobalStart) {
        var frag = document.createDocumentFragment();
        var selStart = null, selEnd = null;
        if (selAnchor !== null && selAnchor !== cursorPos) {
            var gStart = Math.min(selAnchor, cursorPos);
            var gEnd = Math.max(selAnchor, cursorPos);
            var lineEnd = lineGlobalStart + lineText.length;
            var s = Math.max(gStart, lineGlobalStart);
            var eIdx = Math.min(gEnd, lineEnd);
            if (s < eIdx) { selStart = s - lineGlobalStart; selEnd = eIdx - lineGlobalStart; }
        }

        function addSpan(str, cls) {
            var span = document.createElement('span');
            span.textContent = str === '' ? '\u00A0' : str;
            if (str === '') span.style.display = 'none';
            if (cls) span.className = cls;
            frag.appendChild(span);
        }

        if (selStart !== null) {
            addSpan(lineText.slice(0, selStart));
            addSpan(lineText.slice(selStart, selEnd), 'kb-selected');
            addSpan(lineText.slice(selEnd));
        } else if (showCursor) {
            var before = lineText.slice(0, posInLine);
            var atChar = lineText.slice(posInLine, posInLine + 1);
            var after = lineText.slice(posInLine + 1);
            addSpan(before);
            var cursorSpan = document.createElement('span');
            if (insertMode) {
                cursorSpan.className = 'kb-cursor-bar';
                frag.appendChild(cursorSpan);
                addSpan(atChar + after);
            } else {
                cursorSpan.className = 'kb-cursor-block';
                cursorSpan.textContent = atChar === '' ? '\u00A0' : atChar;
                frag.appendChild(cursorSpan);
                addSpan(after);
            }
        } else {
            addSpan(lineText);
        }
        return frag;
    }

    function renderInputLine() {
        var render1 = document.getElementById('kb-input-render1');
        var render2 = document.getElementById('kb-input-render2');
        var indent = document.getElementById('kb-line2-indent');
        if (!render1 || !render2) return;

        var text = inputBuffer;
        var geom = measureLineGeometry();
        lastCharW = geom.charW; lastPromptWidth = geom.promptWidth; lastCharsPerLine = geom.charsPerLine;
        if (indent) indent.style.width = geom.promptWidth + 'px';

        var capacity = geom.charsPerLine * 2;
        if (cursorPos < inputViewOffset || cursorPos >= inputViewOffset + capacity) {
            inputViewOffset = Math.floor(cursorPos / geom.charsPerLine) * geom.charsPerLine;
        }

        var line1Start = inputViewOffset;
        var line2Start = inputViewOffset + geom.charsPerLine;
        var line1Text = text.slice(line1Start, line1Start + geom.charsPerLine);
        var line2Text = text.slice(line2Start, line2Start + geom.charsPerLine);
        lastLine1Start = line1Start; lastLine2Start = line2Start;
        lastLine1Text = line1Text; lastLine2Text = line2Text;

        var relPos = cursorPos - inputViewOffset;
        var cursorOnLine2 = relPos >= geom.charsPerLine;
        var posInLine = cursorOnLine2 ? relPos - geom.charsPerLine : relPos;

        render1.innerHTML = '';
        render1.appendChild(buildLineSpans(line1Text, !cursorOnLine2, posInLine, line1Start));
        render2.innerHTML = '';
        render2.appendChild(buildLineSpans(line2Text, cursorOnLine2, posInLine, line2Start));
    }

    function handleLineClick(e, lineNum) {
        var row = e.currentTarget;
        var rect = row.getBoundingClientRect();
        var clickX = e.clientX - rect.left - lastPromptWidth;
        var idx = Math.round(clickX / lastCharW);
        if (idx < 0) idx = 0;
        var lineText = lineNum === 0 ? lastLine1Text : lastLine2Text;
        if (idx > lineText.length) idx = lineText.length;
        var lineStart = lineNum === 0 ? lastLine1Start : lastLine2Start;
        cursorPos = Math.max(0, Math.min(inputBuffer.length, lineStart + idx));
        selAnchor = null;
        renderInputLine();
    }

    window.updateOverlayInput = function() {
        renderInputLine();
    };
    window.renderInputLine = renderInputLine;
    window.setModifier = setModifier;
    window.updateKeyLabels = updateKeyLabels;
    
    window.setKeyVisual = function(id, cls, on) {
        var el = document.getElementById('kb-' + id);
        if (!el) return;
        if (on) el.classList.add(cls); else el.classList.remove(cls);
    };

    window.showFullKeyboard = function() {
        if (window.updatePrompt) window.updatePrompt(); // Use the global function
        document.getElementById('kb-overlay').classList.add('is-open');
        document.body.classList.add('kb-open');
    };

    window.hideFullKeyboard = function() {
        document.getElementById('kb-overlay').classList.remove('is-open');
        document.body.classList.remove('kb-open');
        window.resetPan();
    };

    // --- KEYBOARD-AVOIDANCE PANNING ---------------------------------------
    // Given a focused field's rect (in ITS OWN iframe's viewport coordinates,
    // as reported by cylon-sdk.js), work out whether it's covered by the
    // on-screen keyboard and, if so, how far to pan the whole app layer up
    // to clear it. This is deliberately ignorant of what's inside the app -
    // no scrollIntoView, no assumptions about scroll containers - so it works
    // the same for every page regardless of its internal layout.

    var kbHeightPxCache = null, barHeightPxCache = null;

    function cssVarPx(name) {
        var probe = document.createElement('div');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(' + name + ');';
        document.body.appendChild(probe);
        var px = probe.getBoundingClientRect().height;
        probe.remove();
        return px;
    }

    function getKbHeightPx() {
        if (kbHeightPxCache == null) kbHeightPxCache = cssVarPx('--kb-height');
        return kbHeightPxCache;
    }
    function getBarHeightPx() {
        if (barHeightPxCache == null) barHeightPxCache = cssVarPx('--bar-height');
        return barHeightPxCache;
    }
    // --kb-height is in vh, so it changes with viewport size/orientation.
    window.addEventListener('resize', function() {
        kbHeightPxCache = null;
        barHeightPxCache = null;
    });

    // frameRect: the on-screen document coordinates of the iframe that holds
    // the app the rect came from (i.e. #browser-layer-container's box with
    // --kb-pan treated as 0 - the frame's resting position before any pan).
    window.panToRect = function(rect) {
        if (!document.body.classList.contains('kb-open')) return;
        if (osMode !== 'app-edit' && osMode !== 'app-textarea') return;

        var kbH = getKbHeightPx();
        var barH = getBarHeightPx();
        var kbTop = window.innerHeight - kbH - barH; // top edge of the keyboard, resting-frame coords
        var margin = 12;

        // #screen-wrapper sits at top:0 and the app layer fills it with no
        // offset, so the rect the app reported is already in resting-frame
        // document coordinates - no need to add an iframe offset.
        var shift = Math.max(0, rect.bottom - (kbTop - margin));
        shift = Math.min(shift, kbH); // never pan further than the keyboard is tall
        document.documentElement.style.setProperty('--kb-pan', shift + 'px');
    };

    window.resetPan = function() {
        document.documentElement.style.setProperty('--kb-pan', '0px');
    };

    window.isVirtualKeyboardOpen = function() {
        return document.body.classList.contains('kb-open');
    };

    window.toggleFullKeyboard = function() {
        if (window.isVirtualKeyboardOpen()) { window.hideFullKeyboard(); }
        else { window.showFullKeyboard(); }
    };

    // Prompt toggles the keyboard when tapped
    document.getElementById('input-bar').addEventListener('click', function() {
        if (!document.body.classList.contains('kb-open')) {
            window.showFullKeyboard();
        }
    });
    
    function clampCursor(pos) { return Math.max(0, Math.min(inputBuffer.length, pos)); }
    function hasSelection() { return selAnchor !== null && selAnchor !== cursorPos; }
    function selRange() { return [Math.min(selAnchor, cursorPos), Math.max(selAnchor, cursorPos)]; }

    function deleteSelection() {
        var range = selRange();
        inputBuffer = inputBuffer.slice(0, range[0]) + inputBuffer.slice(range[1]);
        cursorPos = range[0];
        selAnchor = null;
    }

    window.press = function(e) {
        var shiftHeld = (typeof e.shift !== 'undefined') ? e.shift : !!window.shift;

        if (e.id === 'back') {
            if (hasSelection()) { deleteSelection(); }
            else if (cursorPos > 0) {
                inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
                cursorPos--;
            }
        } else if (e.id === 'del') {
            if (hasSelection()) {
                if (shiftHeld) { var r = selRange(); clipboard = inputBuffer.slice(r[0], r[1]); }
                deleteSelection();
            } else if (cursorPos < inputBuffer.length) {
                inputBuffer = inputBuffer.slice(0, cursorPos) + inputBuffer.slice(cursorPos + 1);
            }
        } else if (e.id === 'ins') {
            if (shiftHeld) {
                if (hasSelection()) deleteSelection();
                if (clipboard) {
                    inputBuffer = inputBuffer.slice(0, cursorPos) + clipboard + inputBuffer.slice(cursorPos);
                    cursorPos += clipboard.length;
                }
            } else { insertMode = !insertMode; }
        } else if (e.id === 'left') {
            if (shiftHeld) { if (selAnchor === null) selAnchor = cursorPos; cursorPos = clampCursor(cursorPos - 1); }
            else { cursorPos = hasSelection() ? selRange()[0] : clampCursor(cursorPos - 1); selAnchor = null; }
        } else if (e.id === 'right') {
            if (shiftHeld) { if (selAnchor === null) selAnchor = cursorPos; cursorPos = clampCursor(cursorPos + 1); }
            else { cursorPos = hasSelection() ? selRange()[1] : clampCursor(cursorPos + 1); selAnchor = null; }
        } else if (e.id === 'home') {
            if (shiftHeld) { if (selAnchor === null) selAnchor = cursorPos; } else { selAnchor = null; }
            cursorPos = 0;
        } else if (e.id === 'end') {
            if (shiftHeld) { if (selAnchor === null) selAnchor = cursorPos; } else { selAnchor = null; }
            cursorPos = inputBuffer.length;
        } else if (e.id === 'enter') {
            if (osMode === 'app-edit' || osMode === 'app-textarea') {
                // 1. Send the text back to the App iframe safely via DOM query
                var activeFrame = document.querySelector('.page-frame.active');
                if (activeFrame) {
                    activeFrame.contentWindow.postMessage({
                        type: 'QANDY_COMMIT_INPUT',
                        id: proxyInputId,
                        value: inputBuffer
                    }, '*');
                }
                // 2. Revert back to App Mode
                osMode = 'app';
                inputBuffer = "";
                cursorPos = 0;
                var title = activeFrame ? activeFrame.dataset.title : 'App';
                document.getElementById('kb-prompt').textContent = `[ ${title} ]`;
                window.hideFullKeyboard();
                renderInputLine();
            } else {
                // Normal Terminal Enter behavior
                command(inputBuffer);
                inputBuffer = "";
                cursorPos = 0;
                selAnchor = null;
                if (window.updatePrompt) window.updatePrompt();
                hideFullKeyboard();
            }
        } else if (e.id === 'up') {
            navigateHistory(-1);
            cursorPos = inputBuffer.length;
            selAnchor = null;
        } else if (e.id === 'down') {
            navigateHistory(1);
            cursorPos = inputBuffer.length;
            selAnchor = null;
        } else if (e.id === 'esc') {
            hideFullKeyboard();
        } else if (e.char) {
            if (hasSelection()) deleteSelection();
            if (insertMode) { inputBuffer = inputBuffer.slice(0, cursorPos) + e.char + inputBuffer.slice(cursorPos); }
            else { inputBuffer = inputBuffer.slice(0, cursorPos) + e.char + inputBuffer.slice(cursorPos + 1); }
            cursorPos++;
        }
        renderInputLine();

        // If we are editing an app field, send the updated text immediately 
        // after every single keystroke, backspace, or deletion.
        if (osMode === 'app-edit' || osMode === 'app-textarea') {
            if (e.id !== 'enter') {
                var activeFrame = document.querySelector('.page-frame.active');
                if (activeFrame) {
                    activeFrame.contentWindow.postMessage({
                        type: 'QANDY_UPDATE_INPUT',
                        id: proxyInputId,
                        value: inputBuffer
                    }, '*');
                }
            }
        }
    };
}
