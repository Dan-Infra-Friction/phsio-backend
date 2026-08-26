"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketService = void 0;
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || 'physiobot_jwt_secret_key_2026_change_me';
class SocketService {
    static initialize(server) {
        this.io = new socket_io_1.Server(server, {
            cors: {
                origin: process.env.FRONTEND_URL || 'http://localhost:3000',
                methods: ['GET', 'POST'],
                credentials: true,
            },
        });
        // Socket auth middleware
        this.io.use((socket, next) => {
            const token = socket.handshake.auth?.token || socket.handshake.query?.token;
            if (!token) {
                return next(new Error('Authentication error: Token missing'));
            }
            try {
                const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
                socket.data.userId = decoded.id;
                next();
            }
            catch (err) {
                return next(new Error('Authentication error: Invalid token'));
            }
        });
        this.io.on('connection', (socket) => {
            const userId = socket.data.userId;
            console.log(`[Socket] Client connected: ${socket.id} (User: ${userId})`);
            // Register socket ID under the corresponding user ID
            const sockets = this.userSockets.get(userId) || [];
            this.userSockets.set(userId, [...sockets, socket.id]);
            socket.on('disconnect', () => {
                console.log(`[Socket] Client disconnected: ${socket.id}`);
                const userSocks = this.userSockets.get(userId) || [];
                this.userSockets.set(userId, userSocks.filter((id) => id !== socket.id));
            });
        });
        return this.io;
    }
    /**
     * Emit a real-time event to all active sessions/tabs of a specific user.
     */
    static sendToUser(userId, event, data) {
        if (!this.io) {
            console.warn('[Socket] Socket server not initialized.');
            return;
        }
        const sockets = this.userSockets.get(userId);
        if (sockets && sockets.length > 0) {
            sockets.forEach((socketId) => {
                this.io.to(socketId).emit(event, data);
            });
        }
    }
    /**
     * Broadcast an event to all connected sockets.
     */
    static broadcast(event, data) {
        if (this.io) {
            this.io.emit(event, data);
        }
    }
}
exports.SocketService = SocketService;
SocketService.io = null;
SocketService.userSockets = new Map(); // userId -> socketIds[]
