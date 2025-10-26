// server.js (ESM)
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const app = express();
app.use(helmet());
app.use(express.json());
app.use(cors({ origin: CLIENT_ORIGIN }));
// basic rate limit
app.use(rateLimit({
  windowMs: 10 * 1000, // 10s
  max: 200
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] }
});

// Redis client
const redis = new Redis(REDIS_URL);
redis.on('error', (err) => console.error('Redis error', err));
redis.on('connect', () => console.log('Connected to Redis'));

// static
app.use(express.static(path.join(__dirname, 'public')));

// health
app.get('/health', (req, res) => res.json({ ok: true }));

// serve room page
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// helpers
const ROOM_PREFIX = 'room:';

async function getRoom(roomId) {
  const key = ROOM_PREFIX + roomId;
  const data = await redis.hgetall(key);
  if (!Object.keys(data).length) return null;
  // parse numeric fields
  return {
    videoId: data.videoId || '',
    time: Number(data.time || 0),
    playing: data.playing === 'true',
    membersCount: Number(data.membersCount || 0),
    moderatorId: data.moderatorId || '',
    queue: data.queue ? JSON.parse(data.queue) : []
  };
}

async function setRoom(roomId, state) {
  const key = ROOM_PREFIX + roomId;
  const payload = {
    videoId: state.videoId || '',
    time: String(state.time || 0),
    playing: state.playing ? 'true' : 'false',
    membersCount: String(state.membersCount || 0),
    moderatorId: state.moderatorId || '',
    queue: JSON.stringify(state.queue || [])
  };
  await redis.hset(key, payload);
  // set TTL to auto-expire empty rooms after 24h (safety)
  if (state.membersCount === 0) {
    await redis.expire(key, 60 * 60 * 24);
  } else {
    await redis.persist(key);
  }
}

async function ensureRoomExists(roomId, creatorSocketId = '') {
  const existing = await getRoom(roomId);
  if (existing) return existing;
  const initial = { videoId: '', time: 0, playing: false, membersCount: 0, moderatorId: creatorSocketId, queue: [] };
  await setRoom(roomId, initial);
  return initial;
}

// basic YouTube ID validator (11 chars)
function isValidYouTubeId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

// Socket logic
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join-room', async ({ roomId, name }) => {
    if (!roomId) {
      socket.emit('error', { message: 'roomId required' });
      return;
    }
    socket.join(roomId);
    socket.data.name = name || `User${Math.floor(Math.random() * 9000) + 1000}`;
    socket.data.roomId = roomId;

    const room = await ensureRoomExists(roomId, socket.id);
    room.membersCount = (room.membersCount || 0) + 1;
    // first connected becomes moderator if none
    if (!room.moderatorId) room.moderatorId = socket.id;
    await setRoom(roomId, room);

    io.to(roomId).emit('users', { count: room.membersCount });

    // send current state to new user
    socket.emit('room-state', {
      videoId: room.videoId || null,
      time: room.time || 0,
      playing: room.playing || false,
      moderatorId: room.moderatorId || null,
      queue: room.queue || []
    });

    console.log(`${socket.id} joined ${roomId}`);
  });

  socket.on('load-video', async ({ videoId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = await getRoom(roomId);
    if (!room) return;

    // only moderator allowed to load new video by default
    if (room.moderatorId && socket.id !== room.moderatorId) {
      socket.emit('error', { message: 'Only moderator can load video' });
      return;
    }

    if (!isValidYouTubeId(videoId)) {
      socket.emit('error', { message: 'Invalid YouTube id' });
      return;
    }

    room.videoId = videoId;
    room.time = 0;
    room.playing = false;
    await setRoom(roomId, room);
    io.to(roomId).emit('load-video', { videoId });
  });

  socket.on('play', async ({ time }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = await getRoom(roomId);
    if (!room) return;

    room.time = Number(time || 0);
    room.playing = true;
    await setRoom(roomId, room);
    socket.to(roomId).emit('play', { time: room.time });
  });

  socket.on('pause', async ({ time }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = await getRoom(roomId);
    if (!room) return;

    room.time = Number(time || 0);
    room.playing = false;
    await setRoom(roomId, room);
    socket.to(roomId).emit('pause', { time: room.time });
  });

  socket.on('seek', async ({ time }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = await getRoom(roomId);
    if (!room) return;

    room.time = Number(time || 0);
    await setRoom(roomId, room);
    socket.to(roomId).emit('seek', { time: room.time });
  });

  socket.on('chat', ({ text }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !text) return;
    const name = socket.data.name || 'Anon';
    io.to(roomId).emit('chat', { name, text });
  });

  socket.on('request-sync', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = await getRoom(roomId);
    if (!room) return;
    socket.emit('room-state', {
      videoId: room.videoId || null,
      time: room.time || 0,
      playing: room.playing || false,
      moderatorId: room.moderatorId || null,
      queue: room.queue || []
    });
  });

  socket.on('disconnect', async () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = await getRoom(roomId);
    if (!room) return;

    room.membersCount = Math.max(0, (room.membersCount || 1) - 1);
    // if moderator left, assign a new moderator (choose random socket in room)
    if (room.moderatorId === socket.id) {
      const sockets = await io.in(roomId).fetchSockets();
      room.moderatorId = sockets.length ? sockets[0].id : '';
    }

    await setRoom(roomId, room);

    if (room.membersCount === 0) {
      // optional: keep room for 24h, expire already handled in setRoom
      console.log(`Room ${roomId} now empty`);
    } else {
      io.to(roomId).emit('users', { count: room.membersCount });
    }

    console.log('disconnect', socket.id);
  });
});

// graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await redis.quit();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
