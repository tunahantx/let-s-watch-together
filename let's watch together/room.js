// public/room.js
const socket = io();

// parse room id and name from URL
const path = window.location.pathname;
const roomId = path.split('/').pop();
const params = new URLSearchParams(window.location.search);
const name = params.get('name') || ('User' + Math.floor(Math.random()*1000));

document.getElementById('roomId').innerText = `Room: ${roomId}`;

// UI refs
const videoUrlInput = document.getElementById('videoUrl');
const loadBtn = document.getElementById('loadBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const usersEl = document.getElementById('users');
const chatBox = document.getElementById('chatBox');
const chatInput = document.getElementById('chatInput');
const sendChat = document.getElementById('sendChat');

let player;
let ready = false;
let ignoreEvents = false;

function extractYouTubeID(urlOrId) {
  if(!urlOrId) return null;
  if(/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId;
  const m = urlOrId.match(/(?:v=|\/v\/|\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function onYouTubeIframeAPIReady() {
  player = new YT.Player('player', {
    height: '360',
    width: '640',
    videoId: '',
    playerVars: { controls: 1, modestbranding: 1 },
    events: {
      onReady: () => { ready = true; socket.emit('request-sync'); },
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerStateChange(e) {
  if(!ready) return;
  if(ignoreEvents) return;
  const state = e.data;
  const time = player.getCurrentTime();
  if(state === 1) {
    socket.emit('play', { time });
  } else if(state === 2) {
    socket.emit('pause', { time });
  }
}

socket.on('connect', () => {
  socket.emit('join-room', { roomId, name });
});

socket.on('users', ({ count }) => {
  usersEl.innerText = `Users: ${count}`;
});

socket.on('room-state', ({ videoId, time, playing, moderatorId }) => {
  if(videoId) loadRemoteVideo(videoId, time, playing);
  // optional: show moderator badge
  if(moderatorId && moderatorId === socket.id) {
    // you are moderator
  }
});

socket.on('load-video', ({ videoId }) => {
  loadRemoteVideo(videoId, 0, false);
});

socket.on('play', ({ time }) => {
  applyRemote(() => {
    if(player) { player.seekTo(time, true); player.playVideo(); }
  });
});

socket.on('pause', ({ time }) => {
  applyRemote(() => {
    if(player) { player.seekTo(time, true); player.pauseVideo(); }
  });
});

socket.on('seek', ({ time }) => {
  applyRemote(() => {
    if(player) player.seekTo(time, true);
  });
});

socket.on('chat', ({ name: from, text }) => {
  addChat(from, text);
});

socket.on('error', ({ message }) => {
  alert('Hata: ' + message);
});

function loadRemoteVideo(videoId, time = 0, playing = false) {
  if(!player) return;
  applyRemote(() => {
    player.loadVideoById(videoId, time);
    if(!playing) player.pauseVideo();
  });
}

function applyRemote(fn) {
  ignoreEvents = true;
  try { fn(); } catch (e) { console.error(e); }
  setTimeout(() => ignoreEvents = false, 300);
}

function addChat(from, text) {
  const el = document.createElement('div');
  el.className = 'chat-line';
  el.innerHTML = `<b>${escapeHtml(from)}:</b> ${escapeHtml(text)}`;
  chatBox.appendChild(el);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

loadBtn.onclick = () => {
  const id = extractYouTubeID(videoUrlInput.value.trim());
  if(!id) return alert('Geçerli bir YouTube linki veya id gir.');
  socket.emit('load-video', { videoId: id });
};
videoUrlInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') loadBtn.click(); });

playBtn.onclick = () => { if(player) player.playVideo(); };
pauseBtn.onclick = () => { if(player) player.pauseVideo(); };

sendChat.onclick = sendMessage;
chatInput.addEventListener('keydown', (e) => { if(e.key==='Enter') sendMessage(); });
function sendMessage(){
  const text = chatInput.value.trim();
  if(!text) return;
  socket.emit('chat', { text });
  chatInput.value = '';
}

window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;
