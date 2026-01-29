const WebSocket = require("ws");
const crypto = require("crypto");

const wss = new WebSocket.Server({ port: 8080 });

// Store rooms
const rooms = new Map();

class Room {
    constructor(id, name, isPublic = true, owner = null) {
        this.id = id;
        this.name = name;
        this.isPublic = isPublic;
        this.owner = owner;
        this.password = null;
        this.users = [];
        this.cards = [];
        this.cursors = {};
        this.chatMessages = [];
        this.createdAt = Date.now();
        this.maxUsers = 50;
    }

    addUser(username, ws) {
        if (this.users.length >= this.maxUsers) return false;
        if (this.users.includes(username)) return true;
        
        this.users.push(username);
        return true;
    }

    removeUser(username) {
        this.users = this.users.filter(u => u !== username);
        delete this.cursors[username];
        
        // If room becomes empty and it's not public, clean it up after delay
        if (this.users.length === 0 && !this.isPublic) {
            setTimeout(() => {
                if (this.users.length === 0) {
                    rooms.delete(this.id);
                }
            }, 300000); // Clean up after 5 minutes of being empty
        }
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            isPublic: this.isPublic,
            owner: this.owner,
            users: this.users,
            cards: this.cards,
            cursors: this.cursors,
            userCount: this.users.length
        };
    }
}

// Create default public room
const defaultRoom = new Room("public", "Main Public Board", true, "system");
rooms.set("public", defaultRoom);

// Track connected clients
const clients = new Map();

wss.on("connection", (ws) => {
    let currentUser = null;
    let currentRoomId = "public";

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                // === ROOM MANAGEMENT ===
                case "JOIN_ROOM":
                    handleJoinRoom(ws, data);
                    break;

                case "CREATE_ROOM":
                    handleCreateRoom(ws, data);
                    break;

                case "LIST_ROOMS":
                    handleListRooms(ws);
                    break;

                case "LEAVE_ROOM":
                    handleLeaveRoom(ws);
                    break;

                // === ROOM-SPECIFIC ACTIONS ===
                case "CLICK":
                    broadcastToRoom(currentRoomId, {
                        type: "CLICK",
                        user: data.user,
                        x: data.x,
                        y: data.y
                    });
                    break;

                case "MOVE_CARD":
                    const room = rooms.get(currentRoomId);
                    if (room) {
                        const card = room.cards.find(c => c.id === data.id);
                        if (card) {
                            card.x = data.x;
                            card.y = data.y;
                            broadcastRoomState(currentRoomId);
                        }
                    }
                    break;

                case "RESIZE_CARD":
                    const resizeRoom = rooms.get(currentRoomId);
                    if (resizeRoom) {
                        const card = resizeRoom.cards.find(c => c.id === data.id);
                        if (card) {
                            card.w = data.w;
                            card.h = data.h;
                            broadcastRoomState(currentRoomId);
                        }
                    }
                    break;

                case "DELETE_CARD":
                    const deleteRoom = rooms.get(currentRoomId);
                    if (deleteRoom) {
                        const card = deleteRoom.cards.find(c => c.id === data.id);
                        if (card && card.user === data.user) {
                            deleteRoom.cards = deleteRoom.cards.filter(c => c.id !== data.id);
                            broadcastRoomState(currentRoomId);
                        }
                    }
                    break;

                case "CHAT":
                    const chatRoom = rooms.get(currentRoomId);
                    if (chatRoom) {
                        const msg = {
                            user: data.user,
                            text: data.text,
                            time: data.time || Date.now(),
                            roomId: currentRoomId
                        };

                        chatRoom.chatMessages.push(msg);

                        // Limit history
                        if (chatRoom.chatMessages.length > 100) {
                            chatRoom.chatMessages.shift();
                        }

                        broadcastToRoom(currentRoomId, {
                            type: "CHAT",
                            ...msg
                        });
                    }
                    break;

                case "ADD_CARD":
                    const addCardRoom = rooms.get(currentRoomId);
                    if (addCardRoom) {
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

                        addCardRoom.cards.push(card);
                        broadcastRoomState(currentRoomId);
                    }
                    break;

                case "CURSOR":
                    const cursorRoom = rooms.get(currentRoomId);
                    if (cursorRoom && data.user) {
                        cursorRoom.cursors[data.user] = { x: data.x, y: data.y };
                        broadcastRoomState(currentRoomId);
                    }
                    break;

                // === USER MANAGEMENT ===
                case "JOIN":
                    currentUser = data.user;
                    const joinRoom = rooms.get(currentRoomId);
                    
                    // Handle duplicate usernames in room
                    let finalUsername = currentUser;
                    let counter = 1;
                    while (joinRoom.users.includes(finalUsername)) {
                        finalUsername = `${currentUser}(${counter})`;
                        counter++;
                    }
                    currentUser = finalUsername;

                    if (joinRoom.addUser(currentUser)) {
                        clients.set(ws, { user: currentUser, roomId: currentRoomId });
                        
                        // Send initial room state
                        ws.send(JSON.stringify({
                            type: "ROOM_JOINED",
                            room: joinRoom.toJSON(),
                            chatHistory: joinRoom.chatMessages.slice(-50),
                            user: currentUser
                        }));

                        // Notify others in room
                        broadcastToRoom(currentRoomId, {
                            type: "USER_JOINED",
                            user: currentUser,
                            roomId: currentRoomId
                        }, ws);

                        broadcastRoomState(currentRoomId);
                    }
                    break;
            }

        } catch (error) {
            console.error("Error processing message:", error);
            ws.send(JSON.stringify({
                type: "ERROR",
                message: "Invalid message format"
            }));
        }
    });

    ws.on("close", () => {
        if (currentUser && currentRoomId) {
            const room = rooms.get(currentRoomId);
            if (room) {
                room.removeUser(currentUser);
                broadcastToRoom(currentRoomId, {
                    type: "USER_LEFT",
                    user: currentUser,
                    roomId: currentRoomId
                });
                broadcastRoomState(currentRoomId);
            }
        }
        clients.delete(ws);
    });

    ws.on("error", (error) => {
        console.error("WebSocket error:", error);
    });

    // Helper functions
    function handleJoinRoom(ws, data) {
        const roomId = data.roomId || "public";
        const password = data.password;
        const room = rooms.get(roomId);

        if (!room) {
            ws.send(JSON.stringify({
                type: "ERROR",
                message: "Room not found"
            }));
            return;
        }

        if (!room.isPublic && room.password && room.password !== password) {
            ws.send(JSON.stringify({
                type: "ERROR",
                message: "Incorrect password"
            }));
            return;
        }

        // Leave previous room if any
        if (currentRoomId && currentUser) {
            const oldRoom = rooms.get(currentRoomId);
            if (oldRoom) {
                oldRoom.removeUser(currentUser);
                broadcastToRoom(currentRoomId, {
                    type: "USER_LEFT",
                    user: currentUser,
                    roomId: currentRoomId
                });
                broadcastRoomState(currentRoomId);
            }
        }

        // Join new room
        currentRoomId = roomId;
        clients.set(ws, { user: currentUser, roomId: currentRoomId });

        if (currentUser && !room.users.includes(currentUser)) {
            room.addUser(currentUser);
        }

        ws.send(JSON.stringify({
            type: "ROOM_JOINED",
            room: room.toJSON(),
            chatHistory: room.chatMessages.slice(-50),
            user: currentUser
        }));

        // Notify room
        broadcastToRoom(roomId, {
            type: "USER_JOINED",
            user: currentUser,
            roomId: roomId
        }, ws);

        broadcastRoomState(roomId);
    }

    function handleCreateRoom(ws, data) {
        if (!currentUser) {
            ws.send(JSON.stringify({
                type: "ERROR",
                message: "You must join first"
            }));
            return;
        }

        const roomId = crypto.randomUUID().slice(0, 8);
        const roomName = data.name || "New Room";
        const isPublic = data.isPublic !== false;
        const password = data.password || null;

        const newRoom = new Room(roomId, roomName, isPublic, currentUser);
        if (password) {
            newRoom.password = password;
        }

        rooms.set(roomId, newRoom);

        ws.send(JSON.stringify({
            type: "ROOM_CREATED",
            room: newRoom.toJSON()
        }));

        // Auto-join the created room
        setTimeout(() => {
            handleJoinRoom(ws, { roomId, password });
        }, 100);
    }

    function handleListRooms(ws) {
        const publicRooms = Array.from(rooms.values())
            .filter(room => room.isPublic)
            .map(room => ({
                id: room.id,
                name: room.name,
                userCount: room.users.length,
                owner: room.owner,
                createdAt: room.createdAt
            }));

        ws.send(JSON.stringify({
            type: "ROOM_LIST",
            rooms: publicRooms
        }));
    }

    function handleLeaveRoom(ws) {
        if (currentRoomId && currentUser) {
            const room = rooms.get(currentRoomId);
            if (room) {
                room.removeUser(currentUser);
                broadcastToRoom(currentRoomId, {
                    type: "USER_LEFT",
                    user: currentUser,
                    roomId: currentRoomId
                });
                broadcastRoomState(currentRoomId);
            }

            currentRoomId = "public";
            clients.set(ws, { user: currentUser, roomId: currentRoomId });
            
            // Join default public room
            handleJoinRoom(ws, { roomId: "public" });
        }
    }
});

function broadcastToRoom(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (!room) return;

    const payload = JSON.stringify(message);
    
    wss.clients.forEach(client => {
        const clientData = clients.get(client);
        if (client.readyState === WebSocket.OPEN && 
            clientData && 
            clientData.roomId === roomId &&
            client !== excludeWs) {
            client.send(payload);
        }
    });
}

function broadcastRoomState(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    broadcastToRoom(roomId, {
        type: "ROOM_STATE",
        ...room.toJSON()
    });
}

// Periodic cleanup of empty private rooms
setInterval(() => {
    for (const [roomId, room] of rooms) {
        if (roomId !== "public" && !room.isPublic && room.users.length === 0) {
            // Check if room has been empty for more than 5 minutes
            const timeSinceEmpty = Date.now() - Math.max(
                ...room.users.map(u => u.lastSeen || 0),
                room.createdAt
            );
            
            if (timeSinceEmpty > 300000) { // 5 minutes
                rooms.delete(roomId);
                console.log(`Cleaned up empty room: ${roomId}`);
            }
        }
    }
}, 60000); // Check every minute

console.log("Server running on ws://localhost:8080");
