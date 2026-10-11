const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 5 * 1024 * 1024 });
app.use(express.static(path.join(__dirname, 'public')));

const W = 960, H = 540, GROUND_Y = 470, GRAVITY = 2200;
const TICK_RATE = 60, TICK_MS = 1000 / TICK_RATE, MAX_TIME = 60, ROUNDS_TO_WIN = 2, ROUND_END_DELAY = 3;
const rooms = new Map();
const globalLeaderboard = [];
const MAX_LEADERBOARD = 50;

function makeCode() { let c; do { c = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (rooms.has(c)); return c; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rectOverlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

class Fighter {
  constructor(id, name, photo) {
    this.id = id; this.name = name; this.photo = photo || null;
    this.x = id === 0 ? 280 : 680; this.y = GROUND_Y; this.vx = 0; this.vy = 0;
    this.facing = id === 0 ? 1 : -1; this.hp = 100; this.energy = 0;
    this.onGround = true; this.blocking = false; this.hitStun = 0; this.state = 'idle';
    this.attackType = null; this.attackElapsed = 0; this.attackStartup = 0; this.attackActive = 0;
    this.attackRecovery = 0; this.attackDamage = 0; this.attackKnockback = 0; this.attackRange = 0;
    this.hasHit = false; this.hitFlash = 0; this.comboHits = 0; this.comboResetTimer = 0;
  }
  get bodyBox() { return { x: this.x - 25, y: this.y - 110, w: 50, h: 110 }; }
  update(dt, other, input) {
    if (this.hitFlash > 0) this.hitFlash -= dt;
    if (this.comboResetTimer > 0) { this.comboResetTimer -= dt; if (this.comboResetTimer <= 0) this.comboHits = 0; }
    if (this.state !== 'attack' && this.hitStun <= 0) this.facing = other.x >= this.x ? 1 : -1;
    if (this.hitStun > 0) { this.hitStun -= dt; this.physics(dt); return; }
    if (this.state === 'attack') { this.updateAttack(dt, other); this.physics(dt); return; }
    this.blocking = !!input.block && this.onGround;
    let mx = 0; if (!this.blocking) { if (input.left) mx -= 1; if (input.right) mx += 1; }
    this.vx = mx * 240;
    if (input.jump && this.onGround && !this.blocking) { this.vy = -820; this.onGround = false; }
    if (!this.blocking) {
      if (input.light) this.startAttack('light');
      else if (input.heavy) this.startAttack('heavy');
      else if (input.special && this.energy >= 100) { this.startAttack('special'); this.energy = 0; }
    }
    this.physics(dt);
  }
  physics(dt) {
    this.vy += GRAVITY * dt; this.x += this.vx * dt; this.y += this.vy * dt;
    if (this.y >= GROUND_Y) { this.y = GROUND_Y; this.vy = 0; this.onGround = true; } else this.onGround = false;
    this.x = clamp(this.x, 50, W - 50);
    if (this.onGround && (this.state === 'attack' || this.hitStun > 0)) this.vx *= 0.82;
  }
  startAttack(type) {
    this.state = 'attack'; this.attackType = type; this.attackElapsed = 0; this.hasHit = false;
    if (type === 'light') { this.attackStartup = 0.07; this.attackActive = 0.08; this.attackRecovery = 0.14; this.attackDamage = 6; this.attackKnockback = 200; this.attackRange = 70; }
    else if (type === 'heavy') { this.attackStartup = 0.16; this.attackActive = 0.1; this.attackRecovery = 0.3; this.attackDamage = 13; this.attackKnockback = 380; this.attackRange = 88; }
    else { this.attackStartup = 0.28; this.attackActive = 0.22; this.attackRecovery = 0.45; this.attackDamage = 26; this.attackKnockback = 560; this.attackRange = 120; }
  }
  updateAttack(dt, other) {
    this.attackElapsed += dt;
    const total = this.attackStartup + this.attackActive + this.attackRecovery;
    if (this.attackElapsed >= this.attackStartup && this.attackElapsed <= this.attackStartup + this.attackActive) {
      if (!this.hasHit && rectOverlap(this.getHitbox(), other.bodyBox)) { this.hasHit = true; this.dealDamage(other); }
    }
    if (this.attackElapsed < this.attackStartup) this.vx = this.facing * 70; else this.vx *= 0.7;
    if (this.attackElapsed >= total) { this.state = 'idle'; this.attackType = null; }
  }
  getHitbox() { const cx = this.x + this.facing * (25 + this.attackRange * 0.5); return { x: cx - this.attackRange/2, y: this.y - 70 - 30, w: this.attackRange, h: 60 }; }
  dealDamage(other) {
    let dmg = this.attackDamage, kb = this.attackKnockback; const blocked = other.blocking;
    if (blocked) { dmg *= 0.25; kb *= 0.25; }
    if (!blocked) { if (other.comboResetTimer > 0) other.comboHits++; else other.comboHits = 1; other.comboResetTimer = 1.0; dmg *= (1 + Math.min(other.comboHits - 1, 5) * 0.1); }
    other.hp = Math.max(0, other.hp - dmg); other.hitStun = blocked ? 0.1 : 0.3; other.hitFlash = 0.18;
    other.vx = this.facing * kb; if (!blocked) { other.vy = -180; other.onGround = false; } other.blocking = false;
    if (this.attackType !== 'special') this.energy = Math.min(100, this.energy + 14); other.energy = Math.min(100, other.energy + 8);
  }
}

class Room {
  constructor(code) {
    this.code = code; this.players = []; this.state = 'waiting'; this.countdown = 3; this.time = MAX_TIME;
    this.lastTick = Date.now(); this.interval = null; this.effects = []; this.demand = null;
    this.roundNum = 1; this.wins = [0, 0]; this.roundHistory = []; this.matchWinner = null;
    this.roundEndTimer = 0; this.lastRoundResult = null; this.demandHistory = []; this.matchHistory = []; this.victoryAnim = 0;
  }
  addPlayer(ws, name, photo) {
    if (this.players.length >= 2) return null;
    const id = this.players.length;
    const fighter = new Fighter(id, name || (id === 0 ? 'WangYongQi' : 'hana'), photo);
    const player = { ws, id, name: fighter.name, fighter, input: { left:false, right:false, jump:false, block:false, light:false, heavy:false, special:false } };
    this.players.push(player);
    this.players.forEach(p => { const other = this.players.find(x => x !== p); if (other) p.ws.send(JSON.stringify({ type: 'opponentInfo', name: other.name, photo: other.fighter.photo })); });
    if (this.players.length === 2) { this.state = 'countdown'; this.countdown = 3; this.startLoop(); }
    return player;
  }
  removePlayer(ws) {
    const idx = this.players.findIndex(p => p.ws === ws);
    if (idx >= 0) { this.players.splice(idx, 1); this.broadcast({ type: 'opponentLeft' }); if (this.players.length < 2) this.state = 'waiting'; if (this.players.length === 0) this.stopLoop(); }
  }
  startLoop() { if (this.interval) return; this.lastTick = Date.now(); this.interval = setInterval(() => this.tick(), TICK_MS); }
  stopLoop() { if (this.interval) { clearInterval(this.interval); this.interval = null; } }
  tick() {
    const now = Date.now(); const dt = Math.min(0.05, (now - this.lastTick) / 1000); this.lastTick = now;
    if (this.state === 'countdown') { this.countdown -= dt; if (this.countdown <= 0) { this.countdown = 0; this.state = 'fighting'; } }
    else if (this.state === 'fighting' && this.players.length === 2) {
      const p0 = this.players[0].fighter, p1 = this.players[1].fighter; const before0 = p0.hp, before1 = p1.hp;
      p0.update(dt, p1, this.players[0].input); p1.update(dt, p0, this.players[1].input); this.time -= dt;
      if (before0 !== p0.hp) this.effects.push({ x: p0.x, y: p0.y - 70, life: 0.3, owner: 1 });
      if (before1 !== p1.hp) this.effects.push({ x: p1.x, y: p1.y - 70, life: 0.3, owner: 0 });
      if (p0.hp <= 0 || p1.hp <= 0 || this.time <= 0) { this.time = Math.max(0, this.time); this.finishRound(); }
    } else if (this.state === 'roundEnd') { this.roundEndTimer -= dt; if (this.roundEndTimer <= 0) this.startNextRound(); }
    else if (this.state === 'matchEnd') { if (this.victoryAnim > 0) this.victoryAnim -= dt; }
    this.effects.forEach(e => e.life -= dt); this.effects = this.effects.filter(e => e.life > 0);
    this.broadcastState();
  }
  finishRound() {
    const p0 = this.players[0].fighter, p1 = this.players[1].fighter; let winnerId;
    if (p0.hp <= 0 && p1.hp <= 0) winnerId = -1; else if (p0.hp <= 0) winnerId = 1; else if (p1.hp <= 0) winnerId = 0;
    else if (p0.hp > p1.hp) winnerId = 0; else if (p1.hp > p0.hp) winnerId = 1; else winnerId = -1;
    const winnerName = winnerId === -1 ? '平局' : this.players[winnerId].name;
    const rec = { round: this.roundNum, winnerId, winnerName, winnerHp: Math.round(winnerId === 0 ? p0.hp : winnerId === 1 ? p1.hp : Math.max(p0.hp, p1.hp)), loserHp: Math.round(winnerId === 0 ? p1.hp : winnerId === 1 ? p0.hp : Math.min(p0.hp, p1.hp)), duration: Math.round((MAX_TIME - this.time) * 10) / 10, p0Name: this.players[0].name, p1Name: this.players[1].name };
    this.roundHistory.push(rec); this.lastRoundResult = rec;
    if (winnerId >= 0) this.wins[winnerId]++;
    if (this.wins[0] >= ROUNDS_TO_WIN || this.wins[1] >= ROUNDS_TO_WIN || this.roundNum >= 3) {
      this.state = 'matchEnd'; this.matchWinner = this.wins[0] > this.wins[1] ? 0 : this.wins[1] > this.wins[0] ? 1 : -1; this.victoryAnim = 3.0;
      if (this.matchWinner >= 0) {
        const winner = this.players[this.matchWinner], loser = this.players[1 - this.matchWinner];
        globalLeaderboard.unshift({ winner: winner.name, winnerId: this.matchWinner, loser: loser.name, score: [this.wins[0], this.wins[1]], rounds: this.roundHistory.length, duration: this.roundHistory.reduce((s, r) => s + r.duration, 0), time: Date.now() });
        if (globalLeaderboard.length > MAX_LEADERBOARD) globalLeaderboard.length = MAX_LEADERBOARD;
      }
      this.stopLoop();
    } else { this.state = 'roundEnd'; this.roundEndTimer = ROUND_END_DELAY; }
  }
  startNextRound() {
    this.roundNum++; this.players.forEach((p, i) => { p.fighter = new Fighter(i, p.name, p.fighter.photo); });
    this.countdown = 3; this.time = MAX_TIME; this.lastRoundResult = null; this.state = 'countdown'; if (!this.interval) this.startLoop();
  }
  broadcastState() {
    this.broadcast({ type: 'state', roomState: this.state, countdown: this.countdown, time: this.time, effects: this.effects, demand: this.demand, roundNum: this.roundNum, wins: this.wins, roundHistory: this.roundHistory, matchWinner: this.matchWinner, lastRoundResult: this.lastRoundResult, roundEndTimer: this.roundEndTimer, victoryAnim: this.victoryAnim, leaderboard: globalLeaderboard.slice(0, 10), demandHistory: this.demandHistory, fighters: this.players.map(p => ({ id: p.fighter.id, name: p.fighter.name, x: p.fighter.x, y: p.fighter.y, facing: p.fighter.facing, hp: p.fighter.hp, energy: p.fighter.energy, blocking: p.fighter.blocking, hitStun: p.fighter.hitStun, state: p.fighter.state, attackType: p.fighter.attackType, attackElapsed: p.fighter.attackElapsed, attackStartup: p.fighter.attackStartup, attackActive: p.fighter.attackActive, attackRecovery: p.fighter.attackRecovery, attackRange: p.fighter.attackRange, hitFlash: p.fighter.hitFlash, onGround: p.fighter.onGround, comboHits: p.fighter.comboHits, comboResetTimer: p.fighter.comboResetTimer })) });
  }
  broadcast(msg) { const data = JSON.stringify(msg); this.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(data); }); }
  handleMessage(ws, msg) {
    const player = this.players.find(p => p.ws === ws); if (!player) return;
    if (msg.type === 'input') player.input = msg.input;
    else if (msg.type === 'rematch' && this.state === 'matchEnd') {
      this.players.forEach((p, i) => { p.fighter = new Fighter(i, p.name, p.fighter.photo); });
      this.roundNum = 1; this.wins = [0, 0]; this.roundHistory = []; this.matchWinner = null; this.lastRoundResult = null; this.demand = null; this.victoryAnim = 0;
      this.state = 'countdown'; this.countdown = 3; this.time = MAX_TIME; this.startLoop();
    } else if (msg.type === 'demand' && this.state === 'matchEnd') {
      this.demand = { text: String(msg.text || '').slice(0, 200), from: player.name, playerId: player.id };
      this.demandHistory.push({ text: this.demand.text, from: player.name, playerId: player.id, time: Date.now(), score: [this.wins[0], this.wins[1]], rounds: this.roundHistory.map(r => ({ round: r.round, winnerName: r.winnerName })) });
      this.broadcast({ type: 'demand', demand: this.demand });
    }
  }
}

wss.on('connection', (ws) => {
  let room = null, player = null;
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch(e) { return; }
    if (msg.type === 'create') {
      const code = makeCode(); room = new Room(code); rooms.set(code, room);
      player = room.addPlayer(ws, msg.name, msg.photo); ws.send(JSON.stringify({ type: 'created', code, playerId: player.id }));
    } else if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase(); const r = rooms.get(code);
      if (!r) return ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
      if (r.players.length >= 2) return ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
      room = r; player = room.addPlayer(ws, msg.name, msg.photo); if (!player) return;
      ws.send(JSON.stringify({ type: 'joined', code, playerId: player.id })); room.broadcast({ type: 'playerJoined', name: player.name });
    } else if (room && player) { room.handleMessage(ws, msg); }
  });
  ws.on('close', () => { if (room) { room.removePlayer(ws); if (room.players.length === 0) { room.stopLoop(); rooms.delete(room.code); } } });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on ' + PORT));