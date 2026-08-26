import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'physiobot_jwt_secret_key_2026_change_me';

export class SocketService {
  private static io: Server | null = null;
  private static userSockets: Map<string, string[]> = new Map(); // userId -> socketIds[]

  public static initialize(server: HttpServer): Server {
    this.io = new Server(server, {
      cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    // Socket auth middleware
    this.io.use((socket: Socket, next) => {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;

      if (!token) {
        return next(new Error('Authentication error: Token missing'));
      }

      try {
        const decoded = jwt.verify(token, JWT_SECRET) as { id: string };
        socket.data.userId = decoded.id;
        next();
      } catch (err) {
        return next(new Error('Authentication error: Invalid token'));
      }
    });

    this.io.on('connection', (socket: Socket) => {
      const userId = socket.data.userId;
      console.log(`[Socket] Client connected: ${socket.id} (User: ${userId})`);

      // Register socket ID under the corresponding user ID
      const sockets = this.userSockets.get(userId) || [];
      this.userSockets.set(userId, [...sockets, socket.id]);

      socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);
        const userSocks = this.userSockets.get(userId) || [];
        this.userSockets.set(
          userId,
          userSocks.filter((id) => id !== socket.id)
        );
      });
    });

    return this.io;
  }

  /**
   * Emit a real-time event to all active sessions/tabs of a specific user.
   */
  public static sendToUser(userId: string, event: string, data: any) {
    if (!this.io) {
      console.warn('[Socket] Socket server not initialized.');
      return;
    }

    const sockets = this.userSockets.get(userId);
    if (sockets && sockets.length > 0) {
      sockets.forEach((socketId) => {
        this.io!.to(socketId).emit(event, data);
      });
    }
  }

  /**
   * Broadcast an event to all connected sockets.
   */
  public static broadcast(event: string, data: any) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }
}
