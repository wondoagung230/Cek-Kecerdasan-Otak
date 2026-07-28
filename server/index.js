const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Arahkan folder statis public dengan benar dari dalam folder server/
app.use(express.static(path.join(__dirname, '../public')));

// --- CARI FILE QUESTIONS.JSON DI SEMUA KEMUNGKINAN LOKASI ---
let questionsPath = path.join(__dirname, '../public/questions.json');

if (!fs.existsSync(questionsPath)) {
  // Coba jika folder public sejajar dengan folder tempat server berjalan
  questionsPath = path.join(process.cwd(), 'public/questions.json');
}
if (!fs.existsSync(questionsPath)) {
  // Coba jika questions.json ada langsung di folder public tanpa ../
  questionsPath = path.join(__dirname, 'public/questions.json');
}
if (!fs.existsSync(questionsPath)) {
  // Coba jika questions.json ada di root folder
  questionsPath = path.join(process.cwd(), 'questions.json');
}

let questions = [];
try {
  if (fs.existsSync(questionsPath)) {
    questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
    console.log(`✅ BERHASIL! Memuat ${questions.length} soal dari path: ${questionsPath}`);
  } else {
    console.error(`❌ GAGAL! File questions.json TIDAK DITEMUKAN di path manapun!`);
  }
} catch (err) {
  console.error(`❌ ERROR SINTAKS JSON! Gagal membaca questions.json:`, err.message);
}

const rooms = new Map();
const MAX_QUESTIONS = 15;

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getPlayerList(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    nickname: p.nickname,
    score: room.scores[p.id] || 0
  }));
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', () => {
    const roomCode = generateCode();
    rooms.set(roomCode, {
      host: socket.id,
      players: new Map(),
      scores: {},
      currentQuestion: null,
      isPlaying: false,
      timer: null,
      nextTimeout: null,
      timeLeft: 0,
      answered: new Set(),
      usedQuestionIds: new Set(),
      questionCount: 0,
      category: 'Semua'
    });
    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
    console.log(`Room created: ${roomCode}`);
  });

  socket.on('joinRoom', ({ roomCode, nickname }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', 'Room tidak ditemukan');
      return;
    }
    if (room.isPlaying) {
      socket.emit('error', 'Game sudah dimulai, tidak bisa join');
      return;
    }

    for (const p of room.players.values()) {
      if (p.nickname.toLowerCase() === nickname.toLowerCase()) {
        socket.emit('error', 'Nama sudah dipakai, pilih nama lain');
        return;
      }
    }

    socket.join(roomCode);
    room.players.set(socket.id, { nickname, id: socket.id });
    room.scores[socket.id] = 0;

    io.to(roomCode).emit('playerList', getPlayerList(room));
    socket.emit('joined', { roomCode, nickname });
    console.log(`${nickname} joined ${roomCode}`);
  });

  socket.on('nextQuestion', ({ roomCode, category }) => {
    startNextQuestion(roomCode, category, socket);
  });

  function startNextQuestion(roomCode, category, socket) {
    const room = rooms.get(roomCode);
    if (!room || room.host !== socket.id) return;
    if (room.isPlaying) return;

    if (room.nextTimeout) {
      clearTimeout(room.nextTimeout);
      room.nextTimeout = null;
    }

    // Reset poin jika sudah mencapai 15 soal
    if (room.questionCount >= MAX_QUESTIONS) {
      for (const id of room.players.keys()) {
        room.scores[id] = 0;
      }
      room.questionCount = 0;
      room.usedQuestionIds.clear();
      io.to(roomCode).emit('gameReset', {
        message: '15 soal selesai! Semua poin di-reset. Game baru dimulai.'
      });
      io.to(roomCode).emit('playerList', getPlayerList(room));
    }

    // --- BAGIAN YANG DIPERBAIKI ---
    // Update kategori di objek room jika ada param category yang baru dikirim
    if (category) {
      room.category = category;
    }

    // Biar fleksibel, abaikan spasi & perbedaan huruf besar/kecil
    const selectedCategory = (room.category || 'Semua').trim().toUpperCase();

    let available = questions;
    if (selectedCategory !== 'SEMUA') {
      available = questions.filter(q => 
        q.category && q.category.trim().toUpperCase() === selectedCategory
      );
    }

    console.log(`[DEBUG] Total Soal di Server: ${questions.length}`);
    console.log(`[DEBUG] Kategori Dipilih: "${selectedCategory}" | Soal Ditemukan: ${available.length}`);

    let unused = available.filter(q => !room.usedQuestionIds.has(q.id));
    if (unused.length === 0) {
      room.usedQuestionIds.clear();
      unused = available;
    }

    if (unused.length === 0) {
      console.log(`[ERROR] Tidak ada soal untuk kategori: ${selectedCategory}`);
      socket.emit('error', `Tidak ada soal di kategori ${selectedCategory} (Total soal di database: ${questions.length})`);
      return;
    }

    const question = unused[Math.floor(Math.random() * unused.length)];
    room.currentQuestion = question;
    if (question.id) room.usedQuestionIds.add(question.id);
    room.isPlaying = true;
    room.answered.clear();
    room.timeLeft = 20;
    room.questionCount += 1;

    const shuffledOptions = shuffleArray(question.options);

    io.to(roomCode).emit('newQuestion', {
      text: question.text,
      options: shuffledOptions,
      category: question.category,
      timeLeft: room.timeLeft,
      questionNumber: room.questionCount,
      maxQuestions: MAX_QUESTIONS
    });

    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
      room.timeLeft--;
      io.to(roomCode).emit('timerUpdate', room.timeLeft);
      if (room.timeLeft <= 0) {
        endQuestion(roomCode);
      }
    }, 1000);
  }

function endQuestion(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.isPlaying) return;

    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }
    room.isPlaying = false;

    // Hitung total skor seluruh pemain saat ini
    const scores = getPlayerList(room).sort((a, b) => b.score - a.score);

    // Cek apakah ini sudah soal terakhir (15)
    const isFinalQuestion = room.questionCount >= MAX_QUESTIONS;

    // Kirim event soal berakhir ke semua orang
    io.to(roomCode).emit('questionEnded', {
      correct: room.currentQuestion.correct,
      explanation: room.currentQuestion.explanation || '',
      questionNumber: room.questionCount,
      maxQuestions: MAX_QUESTIONS,
      isFinalQuestion: isFinalQuestion // Penanda apakah game sudah tamat
    });

    if (isFinalQuestion) {
      // Tunggu jeda singkat (misal 3 detik) agar pemain sempat melihat jawaban benar soal ke-15
      room.nextTimeout = setTimeout(() => {
        // Tampilkan papan skor akhir keseluruhan
        io.to(roomCode).emit('gameFinished', {
          message: '15 Soal telah selesai! Berikut adalah hasil akhir permainan:',
          scores: scores // Kirim data skor akhir di sini
        });

        // Reset poin & counter untuk game selanjutnya
        for (const id of room.players.keys()) {
          room.scores[id] = 0;
        }
        room.questionCount = 0;
        room.usedQuestionIds.clear();
        io.to(roomCode).emit('playerList', getPlayerList(room));
      }, 3000);

      return;
    }

    // Jika belum soal ke-15, lanjut ke soal berikutnya secara otomatis setelah 5 detik
    room.nextTimeout = setTimeout(() => {
      if (rooms.has(roomCode)) {
        const r = rooms.get(roomCode);
        const hostSocket = [...io.sockets.sockets.values()].find(s => s.id === r.host);
        if (hostSocket) {
          startNextQuestion(roomCode, r.category, hostSocket);
        }
      }
    }, 5000);

      return;
    }

    room.nextTimeout = setTimeout(() => {
      if (rooms.has(roomCode)) {
        const r = rooms.get(roomCode);
        const hostSocket = [...io.sockets.sockets.values()].find(s => s.id === r.host);
        if (hostSocket) {
          startNextQuestion(roomCode, r.category, hostSocket);
        }
      }
    }, 7000);
  }

  socket.on('submitAnswer', ({ roomCode, answer }) => {
    const room = rooms.get(roomCode);
    if (!room || !room.isPlaying || room.answered.has(socket.id)) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    room.answered.add(socket.id);

    const isCorrect = answer === room.currentQuestion.correct;
    let points = 0;

    if (isCorrect) {
      points = Math.max(5, Math.floor(room.timeLeft * 0.8) + 5);
      room.scores[socket.id] = (room.scores[socket.id] || 0) + points;
    }

    socket.emit('answerFeedback', { isCorrect, points });

    io.to(room.host).emit('playerAnswered', {
      nickname: player.nickname,
      isCorrect,
      score: room.scores[socket.id],
      answeredCount: room.answered.size
    });

    if (room.answered.size === room.players.size) {
      endQuestion(roomCode);
    }
  });

  socket.on('getLeaderboard', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    const board = getPlayerList(room).sort((a, b) => b.score - a.score);
    io.to(roomCode).emit('leaderboard', board);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        delete room.scores[socket.id];
        io.to(code).emit('playerList', getPlayerList(room));
      }
      if (room.host === socket.id) {
        if (room.timer) clearInterval(room.timer);
        if (room.nextTimeout) clearTimeout(room.nextTimeout);
        rooms.delete(code);
        io.to(code).emit('error', 'Host telah keluar, room ditutup');
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n=== Kuis Pendidikan (SD + SMP + SMA) ===`);
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Host  → http://localhost:${PORT}/host.html`);
  console.log(`Player→ http://localhost:${PORT}/player.html\n`);
});