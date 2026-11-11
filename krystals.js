window.KrystalNet = {
    ws: null,
    passcode: null,
    role: null,

    connect: function(passcode, role) {
        this.passcode = passcode;
        this.role = role; // 'KEYBOARD' or 'DISPLAY'

        // Connect to the same host/port, but using ws:// instead of http://
        const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        const wsUrl = protocol + window.location.host;
        
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            print(`[.4]Krystal Link Established:[.] Freq ${passcode} (${role})\n`);
            this.ws.send(JSON.stringify({ type: 'JOIN', passcode: passcode, role: role }));
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            // If this device is acting as a Display/Host, process incoming keystrokes
            if (this.role === 'DISPLAY' && data.type === 'KEYSTROKE') {
                if (data.action === 'press' && typeof window.press === 'function') {
                    // Trick Cylon into thinking the remote key was pressed locally
                    window.press(data.payload);
                }
            }
        };

        this.ws.onclose = () => print("[.3]Krystal Link Severed.[.]\n");
    },

    // Called when a physical key is pressed on a device acting as a KEYBOARD
    broadcastKey: function(payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.role === 'KEYBOARD') {
            this.ws.send(JSON.stringify({
                type: 'KEYSTROKE',
                action: 'press',
                payload: payload
            }));
        }
    }
};
