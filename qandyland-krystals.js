/**
 * Qandyland Krystals - WebSockets Connection Protocol
 * Handles real-time device hosting, connecting, and data transmission.
 */
const WebSocket = require('ws');

// Registry of active frequencies
const activeKrystals = new Map();

/**
 * Map Structure:
 * "fj4idf9j" => {
 *    frequency: "fj4idf9j",
 *    device: "keyboard",
 *    pin: "1234",
 *    hostWs: <WebSocket>,
 *    clients: Set<WebSocket>
 * }
 */

// Generates an 8-character alphanumeric frequency
function generateFrequency() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let freq;
    do {
        freq = '';
        for (let i = 0; i < 8; i++) {
            freq += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (activeKrystals.has(freq));
    return freq;
}

function init(server) {
    const wss = new WebSocket.Server({ server, path: '/krystals' });
    
    console.log(" 💎 Krystals WebSocket Protocol initialized.");

    wss.on('connection', (ws) => {
        // Track what this specific socket is doing so we can clean up if it drops
        ws.hostedFrequencies = new Set();
        ws.connectedFrequencies = new Set();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                // 1. HOST: A device wants to transmit
                if (data.action === 'host') {
                    const freq = generateFrequency();
                    const deviceName = data.device || 'unknown';
                    
                    activeKrystals.set(freq, {
                        frequency: freq,
                        device: deviceName,
                        pin: data.pin || '',
                        hostWs: ws,
                        clients: new Set()
                    });
                    
                    ws.hostedFrequencies.add(freq);
                    
                    // Reply to the host with their new frequency
                    ws.send(JSON.stringify({ 
                        type: 'hosted', 
                        frequency: freq, 
                        device: deviceName 
                    }));
                    console.log(`[Krystals] Hosted: ${deviceName} on ${freq}`);
                }
                
                // 2. CONNECT: A device wants to receive
                else if (data.action === 'connect') {
                    const krystal = activeKrystals.get(data.frequency);
                    
                    if (!krystal) {
                        ws.send(JSON.stringify({ type: 'error', message: `Frequency ${data.frequency} not found.` }));
                        return;
                    }
                    
                    if (krystal.pin && krystal.pin !== data.pin) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid PIN.' }));
                        return;
                    }
                    
                    krystal.clients.add(ws);
                    ws.connectedFrequencies.add(data.frequency);
                    
                    ws.send(JSON.stringify({ 
                        type: 'connected', 
                        frequency: data.frequency, 
                        device: krystal.device 
                    }));
                    
                    // Let the host know someone tuned in
                    if (krystal.hostWs.readyState === WebSocket.OPEN) {
                        krystal.hostWs.send(JSON.stringify({ type: 'client_joined', frequency: data.frequency }));
                    }
                    console.log(`[Krystals] Connected: Client tuned into ${data.frequency}`);
                }
                
                // 3. TRANSMIT: The host is sending data (e.g., a keystroke)
                else if (data.action === 'transmit') {
                    const krystal = activeKrystals.get(data.frequency);
                    // Ensure only the authorized host can transmit on this frequency
                    if (krystal && krystal.hostWs === ws) {
                        const payloadMsg = JSON.stringify({ 
                            type: 'payload', 
                            frequency: data.frequency, 
                            payload: data.payload 
                        });
                        
                        krystal.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(payloadMsg);
                            }
                        });
                    }
                }
                
                // 4. DISCONNECT: Manually drop a connection
                else if (data.action === 'disconnect') {
                    const krystal = activeKrystals.get(data.frequency);
                    if (krystal) {
                        // If the host disconnects, shut down the frequency entirely
                        if (krystal.hostWs === ws) {
                            krystal.clients.forEach(c => {
                                if (c.readyState === WebSocket.OPEN) {
                                    c.send(JSON.stringify({ type: 'host_disconnected', frequency: data.frequency }));
                                }
                            });
                            activeKrystals.delete(data.frequency);
                            ws.hostedFrequencies.delete(data.frequency);
                            ws.send(JSON.stringify({ type: 'disconnected', frequency: data.frequency, role: 'host' }));
                            console.log(`[Krystals] Host closed frequency ${data.frequency}`);
                        } 
                        // If a client disconnects, just remove them from the audience
                        else if (krystal.clients.has(ws)) {
                            krystal.clients.delete(ws);
                            ws.connectedFrequencies.delete(data.frequency);
                            ws.send(JSON.stringify({ type: 'disconnected', frequency: data.frequency, role: 'client' }));
                        }
                    }
                }
            } catch (e) {
                console.error("[Krystals] Socket Error:", e);
            }
        });

        // Handle dirty disconnects (closing the browser tab)
        ws.on('close', () => {
            // Clean up any frequencies this socket was hosting
            ws.hostedFrequencies.forEach(freq => {
                const k = activeKrystals.get(freq);
                if (k) {
                    k.clients.forEach(c => {
                        if (c.readyState === WebSocket.OPEN) {
                            c.send(JSON.stringify({ type: 'host_disconnected', frequency: freq }));
                        }
                    });
                    activeKrystals.delete(freq);
                    console.log(`[Krystals] Host dropped, frequency ${freq} closed.`);
                }
            });
            
            // Clean up any frequencies this socket was listening to
            ws.connectedFrequencies.forEach(freq => {
                const k = activeKrystals.get(freq);
                if (k) {
                    k.clients.delete(ws);
                }
            });
        });
    });
}

// Generates the public list for `krystals list`
function getList() {
    let list = [];
    activeKrystals.forEach((val, key) => {
        // Hide devices starting with an underscore
        if (!val.device.startsWith('_')) {
            list.push({ 
                frequency: key, 
                device: val.device, 
                secure: !!val.pin 
            });
        }
    });
    return list;
}

module.exports = { init, getList };
