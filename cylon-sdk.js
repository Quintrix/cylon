// --- QANDY POCKET COMPUTER SDK: UI BINDINGS ---

(function() {
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
    
    // Smart label extraction to aid user navigation
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
            // Tell mobile browsers NOT to pop up the native soft keyboard.
            el.setAttribute('inputmode', 'none');

            // Only trigger OS input on the primary pointerdown (or fallback mousedown)
            if (e.type === 'pointerdown' || (e.type === 'mousedown' && e.pointerType === undefined)) {
                if (!el.id) el.id = 'qandy-input-auto-' + (autoIdCounter++);
                
                window.parent.postMessage({
                    type: 'QANDY_REQ_INPUT',
                    id: el.id,
                    value: el.value,
                    isMultiline: el.tagName === 'TEXTAREA',
                    label: getFieldLabel(el), // <--- Send the clean label here
                    rect: rectOf(el)
                }, '*');

                trackElement(el);
            }
        }
    }

    document.addEventListener('pointerdown', handleInputTap, { capture: true, passive: false });
    document.addEventListener('mousedown', handleInputTap, { capture: true, passive: false });
    document.addEventListener('touchstart', handleInputTap, { capture: true, passive: false });

    // Listen for the OS sending text back
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
})();