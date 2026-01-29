const WebSocket = require("ws");
const crypto = require("crypto");

const wss = new WebSocket.Server({ port: 8080 });

let chatMessages = [];

let boardState = {
    cards: [],
    users: [],
    cursors: {}
};

// Track connected clients
const clients = new Map();

wss.on("connection", (ws) => {
    let userName = null;

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === "CLICK") {
                // Broadcast click
                const payload = JSON.stringify({
                    type: "CLICK",
                    user: data.user,
                    x: data.x,
                    y: data.y
                });

                broadcastToAll(payload);
                return;
            }

            if (data.type === "MOVE_CARD") {
                const card = boardState.cards.find(c => c.id === data.id);
                if (card) {
                    card.x = data.x;
                    card.y = data.y;
                }
                broadcastState();
                return;
            }

            if (data.type === "RESIZE_CARD") {
                const card = boardState.cards.find(c => c.id === data.id);
                if (card) {
                    card.w = data.w;
                    card.h = data.h;
                }
                broadcastState();
                return;
            }

            if (data.type === "DELETE_CARD") {
                const card = boardState.cards.find(c => c.id === data.id);
                if (card && card.user === data.user) {
                    boardState.cards = boardState.cards.filter(c => c.id !== data.id);
                }
                broadcastState();
                return;
            }

            if (data.type === "CHAT") {
                // FIX HERE: Use correct field names
                const msg = {
                    user: data.user,  // The frontend sends 'user', not 'message.user'
                    text: data.text,  // The frontend sends 'text', not 'message.text'
                    time: data.time || Date.now()
                };

                chatMessages.push(msg);

                // Limit history
                if (chatMessages.length > 100) {
                    chatMessages.shift();
                }

                // FIX HERE: Send the message directly, not nested
                const payload = JSON.stringify({
                    type: "CHAT",
                    user: msg.user,
                    text: msg.text,
                    time: msg.time
                });

                broadcastToAll(payload);
                return;
            }

            if (data.type === "JOIN") {
                userName = data.user;
                
                // Handle duplicate usernames
                let finalUsername = userName;
                let counter = 1;
                while (boardState.users.includes(finalUsername)) {
                    finalUsername = `${userName}(${counter})`;
                    counter++;
                }
                userName = finalUsername;

                if (!boardState.users.includes(userName)) {
                    boardState.users.push(userName);
                }

                // Send initial state to new user
                ws.send(JSON.stringify({
                    ...boardState,
                    chatHistory: chatMessages.slice(-50) // Include chat history
                }));

                console.log(`User joined: ${userName}`);
                broadcastState();
                return;
            }

            if (data.type === "ADD_CARD") {
                const card = {
                    id: crypto.randomUUID(),
                    user: data.card.user,
                    type: data.card.type || "text",
                    content: data.card.content,
                    x: data.card.x || Math.random() * 400 + 50,
                    y: data.card.y || Math.random() * 200 + 50,
                    w: data.card.w || 260,
                    h: data.card.h || 160
                };

                boardState.cards.push(card);
                broadcastState();
                return;
            }

            if (data.type === "CURSOR") {
                if (userName) {
                    boardState.cursors[userName] = { x: data.x, y: data.y };
                }
                broadcastState();
                return;
            }

        } catch (error) {
            console.error("Error processing message:", error);
        }
    });

    ws.on("close", () => {
        if (userName) {
            console.log(`User disconnected: ${userName}`);
            boardState.users = boardState.users.filter(u => u !== userName);
            delete boardState.cursors[userName];
            broadcastState();
        }
    });

    ws.on("error", (error) => {
        console.error("WebSocket error:", error);
    });
});

function broadcastToAll(payload) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

function broadcastState() {
    const payload = JSON.stringify(boardState);
    broadcastToAll(payload);
}

console.log("cream spinning on ws://localhost:8080");