// BUN-FIGHT server
// Consolidated Node/Express + Socket.IO backend.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_NAME_LENGTH = 6;
const ROUND_RESULT_DELAY_MS = 2000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: CORS_ORIGIN },
    pingInterval: 8000,
    pingTimeout: 5000
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let gameState = {
    game_mode: "WAITING", // WAITING, MATCH_IN_PROGRESS, ROUND_OVER
    queue: [],            // [{ id, name }]
    leaderboard: [],      // [{ id, name, esp_rating, streak }]
    champion: null,       // { id, name, streak }
    match: null           // match object
};

let autoAdvanceTimeout = null;

function clearAdvanceTimeout() {
    if (autoAdvanceTimeout) {
        clearTimeout(autoAdvanceTimeout);
        autoAdvanceTimeout = null;
    }
}

function broadcastState() {
    io.emit('state_update', buildPublicState());
}

function buildPublicState() {
    if (!gameState.match) return gameState;
    const bothChosen = gameState.match.p1_choice_made && gameState.match.p2_choice_made;
    if (bothChosen) return gameState;
    return {
        ...gameState,
        match: {
            ...gameState.match,
            p1_choice: null,
            p2_choice: null
        }
    };
}

function sanitizeName(rawName) {
    if (typeof rawName !== 'string') return '';
    return rawName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, MAX_NAME_LENGTH);
}

function namesMatch(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isNameTaken(name, excludeSocketId) {
    for (const [id, s] of io.sockets.sockets) {
        if (id !== excludeSocketId && s.playerName && namesMatch(s.playerName, name)) {
            return true;
        }
    }
    return false;
}

function resolveCanonicalName(name) {
    if (gameState.champion && namesMatch(gameState.champion.name, name)) {
        return gameState.champion.name;
    }
    if (gameState.match) {
        if (namesMatch(gameState.match.challenger_name, name)) return gameState.match.challenger_name;
        if (namesMatch(gameState.match.champ_name, name)) return gameState.match.champ_name;
    }
    const inQueue = gameState.queue.find(q => namesMatch(q.name, name));
    if (inQueue) return inQueue.name;
    const onLeaderboard = gameState.leaderboard.find(p => namesMatch(p.name, name));
    if (onLeaderboard) return onLeaderboard.name;
    return name;
}

function updateLeaderboard(name, espChange, streakChange) {
    let player = gameState.leaderboard.find(p => namesMatch(p.name, name));
    if (!player) {
        player = { id: '', name: name, esp_rating: 100, streak: 0 };
        gameState.leaderboard.push(player);
    }
    player.esp_rating = Math.max(0, player.esp_rating + espChange);
    player.streak = Math.max(0, player.streak + streakChange);
    gameState.leaderboard.sort((a, b) => b.esp_rating - a.esp_rating);
}

function startNextMatch() {
    clearAdvanceTimeout();

    // Assign champion if missing from queue or anywhere else
    if (!gameState.champion && gameState.queue.length > 0) {
        const newChamp = gameState.queue.shift();
        gameState.champion = { id: newChamp.id, name: newChamp.name, streak: 0 };
    }

    // Clean active champion out of the queue safely
    if (gameState.champion) {
        gameState.queue = gameState.queue.filter(q => !namesMatch(q.name, gameState.champion.name));
    }

    if (gameState.queue.length === 0 || !gameState.champion) {
        gameState.game_mode = "WAITING";
        gameState.match = null;
        broadcastState();
        return;
    }

    const challenger = gameState.queue.shift();

    gameState.game_mode = "MATCH_IN_PROGRESS";
    gameState.match = {
        challenger_id: challenger.id,
        challenger_name: challenger.name,
        champ_id: gameState.champion.id,
        champ_name: gameState.champion.name,
        p1_wins: 0,
        p2_wins: 0,
        round_num: 1,
        p1_choice: null,
        p2_choice: null,
        p1_choice_made: false,
        p2_choice_made: false,
        match_winner: null,
        history: []
    };

    broadcastState();
}

function advanceRound() {
    clearAdvanceTimeout();

    if (!gameState.match) return;
    const match = gameState.match;

    // Tie scenario
    if (match.match_winner && match.match_winner.includes("Tie")) {
        match.p1_choice = null;
        match.p2_choice = null;
        match.p1_choice_made = false;
        match.p2_choice_made = false;
        match.match_winner = null;
        gameState.game_mode = "MATCH_IN_PROGRESS";
        broadcastState();
        return;
    }

    // Match Complete (Best 2 out of 3)
    if (match.p1_wins >= 2 || match.p2_wins >= 2) {
        const loserName = match.p1_wins >= 2 ? match.champ_name : match.challenger_name;
        const loserId = match.p1_wins >= 2 ? match.champ_id : match.challenger_id;

        // Push loser back to the queue securely without duplication
        if (!gameState.queue.some(q => namesMatch(q.name, loserName)) && !namesMatch(gameState.champion?.name, loserName)) {
            gameState.queue.push({ id: loserId, name: loserName });
        }
        startNextMatch();
    } else {
        // Next round in same match
        match.round_num++;
        match.p1_choice = null;
        match.p2_choice = null;
        match.p1_choice_made = false;
        match.p2_choice_made = false;
        match.match_winner = null;
        gameState.game_mode = "MATCH_IN_PROGRESS";
        broadcastState();
    }
}

io.on('connection', (socket) => {
    socket.on('join_game', (data) => {
        const rawName = sanitizeName(data && data.name);
        if (!rawName) {
            socket.emit('join_error', { message: 'Enter a nickname (letters only, up to 6 characters) to join.' });
            return;
        }

        if (isNameTaken(rawName, socket.id)) {
            socket.emit('join_error', { message: `"${rawName}" is already in the arena. Pick another nickname.` });
            return;
        }

        const name = resolveCanonicalName(rawName);
        socket.playerName = name;
        updateLeaderboard(name, 0, 0);

        let isMatchPlayer = false;
        if (gameState.match) {
            if (namesMatch(gameState.match.challenger_name, name)) {
                gameState.match.challenger_id = socket.id;
                isMatchPlayer = true;
            } else if (namesMatch(gameState.match.champ_name, name)) {
                gameState.match.champ_id = socket.id;
                isMatchPlayer = true;
            }
        }

        if (gameState.champion && namesMatch(gameState.champion.name, name)) {
            gameState.champion.id = socket.id;
        }

        gameState.queue = gameState.queue.filter(q => !namesMatch(q.name, name));

        if (!gameState.champion) {
            gameState.champion = { id: socket.id, name: name, streak: 0 };
        } else if (!namesMatch(gameState.champion.name, name) && !isMatchPlayer) {
            if (!gameState.queue.some(q => namesMatch(q.name, name))) {
                gameState.queue.push({ id: socket.id, name: name });
            }
        }

        // Only auto-start if waiting and we have enough players
        if (gameState.game_mode === "WAITING" && gameState.champion && gameState.queue.length > 0) {
            startNextMatch();
        } else {
            broadcastState();
        }
    });

    socket.on('make_choice', (data) => {
        if (!gameState.match) {
            console.log(`[DROPPED CHOICE] From ${socket.playerName}: No active match exists.`);
            return;
        }
        
        if (gameState.game_mode !== "MATCH_IN_PROGRESS") {
            console.log(`[DROPPED CHOICE] From ${socket.playerName}: game_mode is currently ${gameState.game_mode}`);
            return;
        }

        const choice = data && data.choice;
        if (!['BUN', 'CROISSANT', 'TORTILLA'].includes(choice)) return;

        const match = gameState.match;
        const name = socket.playerName;

        if (namesMatch(name, match.challenger_name)) {
            match.challenger_id = socket.id;
            match.p1_choice = choice;
            match.p1_choice_made = true;
        } else if (namesMatch(name, match.champ_name)) {
            match.champ_id = socket.id;
            match.p2_choice = choice;
            match.p2_choice_made = true;
        } else {
            console.log(`[DROPPED CHOICE] Unknown or spectator player trying to play: ${name}`);
            return; 
        }

        if (!(match.p1_choice_made && match.p2_choice_made)) {
            broadcastState();
            return;
        }

        let roundWinnerName = null;

        if (match.p1_choice === match.p2_choice) {
            match.match_winner = "Tie (Re-throw!)";
            match.history.push({
                round_num: match.round_num,
                p1_choice: match.p1_choice,
                p2_choice: match.p2_choice,
                winner: "Tie"
            });
            gameState.game_mode = "ROUND_OVER";
        } else if (
            (match.p1_choice === 'BUN' && match.p2_choice === 'CROISSANT') ||
            (match.p1_choice === 'TORTILLA' && match.p2_choice === 'BUN') ||
            (match.p1_choice === 'CROISSANT' && match.p2_choice === 'TORTILLA')
        ) {
            match.p1_wins++;
            roundWinnerName = match.challenger_name;
        } else {
            match.p2_wins++;
            roundWinnerName = match.champ_name;
        }

        if (roundWinnerName) {
            match.history.push({
                round_num: match.round_num,
                p1_choice: match.p1_choice,
                p2_choice: match.p2_choice,
                winner: roundWinnerName
            });

            updateLeaderboard(roundWinnerName, 50, 0);
            match.match_winner = roundWinnerName;
            gameState.game_mode = "ROUND_OVER";

            if (match.p1_wins >= 2 || match.p2_wins >= 2) {
                const finalWinner = match.p1_wins >= 2 ? match.challenger_name : match.champ_name;
                match.match_winner = finalWinner;

                if (namesMatch(finalWinner, match.challenger_name)) {
                    gameState.champion = { id: match.challenger_id, name: match.challenger_name, streak: 1 };
                    updateLeaderboard(match.challenger_name, 150, 1);
                    updateLeaderboard(match.champ_name, 0, -1);
                } else {
                    if (gameState.champion) gameState.champion.streak++;
                    updateLeaderboard(match.champ_name, 150, 1);
                    updateLeaderboard(match.challenger_name, 0, -1);
                }
            }
        }

        broadcastState();

        clearAdvanceTimeout();
        autoAdvanceTimeout = setTimeout(() => {
            advanceRound();
        }, ROUND_RESULT_DELAY_MS);
    });

    socket.on('reset_game', () => {
        clearAdvanceTimeout();

        gameState = {
            game_mode: "WAITING",
            queue: [],
            leaderboard: [],
            champion: null,
            match: null
        };

        const connectedSockets = Array.from(io.sockets.sockets.values());
        connectedSockets.forEach((s) => {
            if (s.playerName) {
                updateLeaderboard(s.playerName, 0, 0);

                if (!gameState.champion) {
                    gameState.champion = { id: s.id, name: s.playerName, streak: 0 };
                } else {
                    if (!gameState.queue.some(q => namesMatch(q.name, s.playerName))) {
                        gameState.queue.push({ id: s.id, name: s.playerName });
                    }
                }
            }
        });

        if (gameState.champion && gameState.queue.length > 0) {
            startNextMatch();
        } else {
            broadcastState();
        }
    });

    socket.on('disconnect', () => {
        const name = socket.playerName;
        if (!name) return;

        // Keep queue clean, but avoid destroying active matches instantly on minor drops 
        // unless explicitly needed. Match persistence protects active games.
        gameState.queue = gameState.queue.filter(q => !namesMatch(q.name, name));
        broadcastState();
    });

    socket.on('start_match_manual', () => {
        if (gameState.game_mode === "ROUND_OVER") {
            advanceRound();
        } else if (gameState.game_mode === "WAITING" && gameState.champion && gameState.queue.length > 0) {
            startNextMatch();
        }
    });

    socket.on('next_round_manual', () => {
        if (gameState.game_mode === "ROUND_OVER") {
            advanceRound();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`BUN-FIGHT server running on port ${PORT}`);
});