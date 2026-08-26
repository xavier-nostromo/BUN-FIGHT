// BUN-FIGHT server
// Consolidated Node/Express + Socket.IO backend (replaces the old Flask/app.py twin).

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Config (env-driven so the same code works locally and on a free host)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
// Lock this down to your deployed frontend origin in production, e.g.
// CORS_ORIGIN=https://your-app.onrender.com
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_NAME_LENGTH = 6;
const ROUND_RESULT_DELAY_MS = 2000; // Shortened to 2 seconds for snappier pacing

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: CORS_ORIGIN },
    // Defaults (pingInterval 25s + pingTimeout 20s) mean a dropped connection
    // can take up to ~45s to be reaped, during which a rejoin under the same
    // name gets a false "name taken" rejection (see README's known
    // limitation). Tightening this shrinks that window to ~13s without being
    // so aggressive that normal network jitter causes false disconnects.
    pingInterval: 8000,
    pingTimeout: 5000
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------------------------------------------------------------------------
// Game state (in-memory — this is a party-game scoreboard, not a durable
// store. A restart/redeploy clears it. See README for details.)
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

// gameState.match.p1_choice / p2_choice hold the real picks as soon as a
// player locks in, but the UI is only meant to reveal "locked in" vs
// "choosing" until both sides have answered. Because previous versions
// broadcast the full gameState verbatim, anyone with devtools open (the
// opponent included) could read state.match.p1_choice/p2_choice straight
// off the socket payload before making their own pick - a real fairness
// hole for a rock-paper-scissors-style game. This strips the choice
// values from the broadcast copy until both are in; the *_choice_made
// booleans (which the UI actually uses) are left untouched.
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

// ---------------------------------------------------------------------------
// Name handling — prevents two connected players from colliding on identity.
// A name is "taken" if a currently-connected socket other than the one
// asking already claims it. This intentionally favors correctness (no
// double-booked players) over a perfectly seamless refresh; a genuine
// reconnect after a real disconnect always succeeds.
// ---------------------------------------------------------------------------
function sanitizeName(rawName) {
    if (typeof rawName !== 'string') return '';
    // Retro arcade high-score handle: A-Z only, max 6 chars, always upper.
    // Stripping everything but letters also means no HTML-special
    // character (<, >, quotes, etc.) can ever survive sanitization, so
    // this subsumes the earlier angle-bracket strip as a stronger
    // defense against the nickname being used to inject markup.
    return rawName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, MAX_NAME_LENGTH);
}

// All player-identity comparisons in this file should go through this
// helper. Names are matched case-insensitively so "Bob" and "BOB" are
// treated as the same person everywhere (join checks, leaderboard,
// champion/match/queue lookups) instead of only in isNameTaken - a
// mismatch there let a rejoin with different casing fork into a
// duplicate identity (a stale champion slot + a fresh queue entry, or a
// second leaderboard row that resets ESP/streak to zero).
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

// If this name (case-insensitively) already corresponds to a known
// identity somewhere in game state, return that identity's original
// casing so state never fragments into two records for the same person.
// Otherwise, the name is genuinely new and is returned as-is.
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

        gameState.queue.push({ id: loserId, name: loserName });
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

function startNextMatch() {
    clearAdvanceTimeout();

    // Assign champion if missing
    if (!gameState.champion && gameState.queue.length > 0) {
        const newChamp = gameState.queue.shift();
        gameState.champion = { id: newChamp.id, name: newChamp.name, streak: 0 };
    }

    // Clean active champion out of the queue
    if (gameState.champion) {
        gameState.queue = gameState.queue.filter(q => q.name !== gameState.champion.name);
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

        // If this is a rejoin under different casing of an existing
        // identity (e.g. "Bob" -> "BOB"), snap back to the original casing
        // so we update that identity instead of forking a new one.
        const name = resolveCanonicalName(rawName);

        socket.playerName = name;
        updateLeaderboard(name, 0, 0);

        // Update active session IDs if rejoining
        if (gameState.match) {
            if (gameState.match.challenger_name === name) gameState.match.challenger_id = socket.id;
            if (gameState.match.champ_name === name) gameState.match.champ_id = socket.id;
        }

        if (gameState.champion && gameState.champion.name === name) {
            gameState.champion.id = socket.id;
        }

        // Clean name from queue to prevent duplicate entries
        gameState.queue = gameState.queue.filter(q => q.name !== name);

        const isMatchPlayer = gameState.match &&
            (gameState.match.challenger_name === name || gameState.match.champ_name === name);

        if (!gameState.champion) {
            gameState.champion = { id: socket.id, name: name, streak: 0 };
        } else if (gameState.champion.name !== name && !isMatchPlayer) {
            gameState.queue.push({ id: socket.id, name: name });
        }

        if (gameState.game_mode === "WAITING" && gameState.champion && gameState.queue.length > 0) {
            startNextMatch();
        } else {
            broadcastState();
        }
    });

    socket.on('make_choice', (data) => {
        if (!gameState.match || gameState.game_mode !== "MATCH_IN_PROGRESS") {
            console.log(`[IGNORED CHOICE] From ${socket.playerName}: game_mode is ${gameState.game_mode}`);
            return;
        }
        const choice = data && data.choice;
        if (!['BUN', 'CROISSANT', 'TORTILLA'].includes(choice)) return;

        const match = gameState.match;
        const name = socket.playerName;

        if (name === match.challenger_name) {
            match.challenger_id = socket.id;
            match.p1_choice = choice;
            match.p1_choice_made = true;
        } else if (name === match.champ_name) {
            match.champ_id = socket.id;
            match.p2_choice = choice;
            match.p2_choice_made = true;
        } else {
            console.log(`[IGNORED CHOICE] Unknown player trying to play: ${name}`);
            return; 
        }

        // Check if both have chosen; if not, broadcast immediately so the UI reflects the lock-in
        if (!(match.p1_choice_made && match.p2_choice_made)) {
            broadcastState();
            return;
        }

        // Both choices are in — evaluate round outcome instantly
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

                if (finalWinner === match.challenger_name) {
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

        // Broadcast final results for this round immediately
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
                    gameState.queue.push({ id: s.id, name: s.playerName });
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

        gameState.queue = gameState.queue.filter(q => q.name !== name);
        if (gameState.champion && gameState.champion.name === name) {
            clearAdvanceTimeout();
            gameState.champion = null;
            gameState.game_mode = "WAITING";
            gameState.match = null;
        } else if (gameState.match && (gameState.match.challenger_name === name || gameState.match.champ_name === name)) {
            clearAdvanceTimeout();
            gameState.game_mode = "WAITING";
            gameState.match = null;
        }
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