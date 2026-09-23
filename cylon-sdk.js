// --- QANDY POCKET COMPUTER SDK: UI BINDINGS ---

(function() {
    let autoIdCounter = 0;
    let trackedEl = null;
    let resizeObs = null;

    // Position of the element in THIS document's own viewport coordinates.
    // The OS combines this with where our iframe sits on screen to work out
    // whether the field is covered by the on-screen keyboard - it never needs
    // to know anything about our internal layout (scroll containers, overflow,
    // flex, canvases, whatever) to do that.
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

    // Keep watching the field after focus: a textarea can grow as text wraps,
    // or content above it can shift, either of which moves the field without
    // us getting another pointerdown. Re-report whenever that happens so the
    // OS can re-pan instead of relying on a one-time measurement.
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

    // Aggressively intercept all tap/click events to prevent native focus
    // and stop the browser from trying to scroll overflow:hidden containers.
    function handleInputTap(e) {
        const el = e.target;
        if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))) {
            // Prevent native focus and physical keyboard popup
            e.preventDefault();
            el.blur();

            // Only trigger OS input on the primary pointerdown (or fallback mousedown)
            if (e.type === 'pointerdown' || (e.type === 'mousedown' && e.pointerType === undefined)) {
                if (!el.id) el.id = 'qandy-input-auto-' + (autoIdCounter++);
                
                // Ask the OS for input, and tell it exactly where the field is so
                // it can keep it clear of the on-screen keyboard itself.
                window.parent.postMessage({
                    type: 'QANDY_REQ_INPUT',
                    id: el.id,
                    value: el.value,
                    isMultiline: el.tagName === 'TEXTAREA',
                    placeholder: el.placeholder || el.id,
                    rect: rectOf(el)
                }, '*');

                trackElement(el);
            }
        }
    }

    // Use capture: true to guarantee we intercept the event before other app logic
    document.addEventListener('pointerdown', handleInputTap, { capture: true, passive: false });
    document.addEventListener('mousedown', handleInputTap, { capture: true, passive: false });
    document.addEventListener('touchstart', handleInputTap, { capture: true, passive: false });

    // Fallback: if focus somehow still lands on the input, blur it immediately
    // to stop the browser from natively scrolling the layout to bring it into view.
    document.addEventListener('focus', (e) => {
        const el = e.target;
        if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))) {
            el.blur();
        }
    }, true);

    // Listen for the OS sending text back
    window.addEventListener('message', (e) => {
        // Handle BOTH real-time keystrokes (UPDATE) and the final Enter key (COMMIT)
        if (e.data.type === 'QANDY_UPDATE_INPUT' || e.data.type === 'QANDY_COMMIT_INPUT') {
            const el = document.getElementById(e.data.id);
            if (el) {
                // Update value
                el.value = e.data.value;

                // Fire 'input' on every keystroke so real-time app features work
                el.dispatchEvent(new Event('input', { bubbles: true }));

                if (e.data.type === 'QANDY_COMMIT_INPUT') {
                    // Cleanup and fire 'change' when Enter is pressed
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    stopTracking();
                } else {
                    // The value change may have resized the field (a growing
                    // textarea) or shifted its position - re-report once the
                    // browser has applied the new layout.
                    requestAnimationFrame(() => reportRect(el));
                }
            }
        }
    });
})();