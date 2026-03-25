import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    path: "/api/socket.io",
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // WebRTC Signaling Server Logic
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room ${roomId}`);
      // Notify others in the room
      socket.to(roomId).emit("user-joined", socket.id);
    });

    socket.on("request-join", (data) => {
      console.log(`User ${socket.id} requesting to join ${data.roomId}`);
      socket.to(data.roomId).emit("join-request", { clientId: socket.id, password: data.password });
    });

    socket.on("join-response", (data) => {
      console.log(`Host responded to ${data.clientId} for room ${data.roomId}: ${data.allowed}`);
      socket.to(data.clientId).emit("join-response", { allowed: data.allowed, roomId: data.roomId });
    });

    socket.on("offer", (data) => {
      socket.to(data.roomId).emit("offer", {
        offer: data.offer,
        sender: socket.id
      });
    });

    socket.on("answer", (data) => {
      socket.to(data.roomId).emit("answer", {
        answer: data.answer,
        sender: socket.id
      });
    });

    socket.on("ice-candidate", (data) => {
      socket.to(data.roomId).emit("ice-candidate", {
        candidate: data.candidate,
        sender: socket.id
      });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      // In a real app, notify rooms that user left
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
