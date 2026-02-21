/* ============================================================
   PIXEL FLOW — script.js
   Pure vanilla JavaScript game logic
   ============================================================ */

// ─────────────────────────────────────────────
// CONSTANTS & CONFIG
// ─────────────────────────────────────────────

const COLORS = ['red', 'blue', 'green', 'yellow'];

// Neon colors for canvas drawing
const COLOR_MAP = {
  red:    '#ff4466',
  blue:   '#44aaff',
  green:  '#44ff88',
  yellow: '#ffdd44',
};

// How many grid columns and rows
const GRID_COLS = 8;
const GRID_ROWS = 6;

// Pixels per cell (matches CSS --cell)
const CELL = 36;

// Belt thickness (matches CSS --belt)
const BELT = 48;

// Shooter unit size on canvas
const UNIT_SIZE = 34;

// How many ammo shots each unit starts with
const BASE_AMMO = 4;

// How fast units move along the belt (pixels per frame)
const SPEED = 1.5;

// Game loop frame rate cap (ms per frame ≈ 60 fps)
const FRAME_MS = 16;

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────

let blocks      = [];      // array of { id, row, col, color, alive }
let units       = [];      // shooter units on the belt
let waitingPool = [];      // units that ran out of ammo, waiting to re-spawn
let score       = 0;
let level       = 1;
let gameRunning = false;
let animFrame   = null;
let lastTime    = 0;
let selectedColor = 'red';

// Belt path is a list of {x, y} waypoints (pixel coords of unit center)
// Built once after layout is calculated
let beltPath    = [];
let totalPathLen = 0;

// ─────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────

const gridEl       = document.getElementById('grid');
const canvas       = document.getElementById('conveyorCanvas');
const ctx          = canvas.getContext('2d');
const gameArea     = document.getElementById('gameArea');
const scoreEl      = document.getElementById('score');
const blockCountEl = document.getElementById('blockCount');
const levelEl      = document.getElementById('level');
const spawnBtn     = document.getElementById('spawnBtn');
const restartBtn   = document.getElementById('restartBtn');
const waitingList  = document.getElementById('waitingList');
const overlay      = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMsg   = document.getElementById('overlayMsg');
const overlayBtn   = document.getElementById('overlayBtn');
const colorBtns    = document.querySelectorAll('.color-btn');

// ─────────────────────────────────────────────
// LAYOUT SETUP
// ─────────────────────────────────────────────

function setupLayout() {
  // Total game area size: belt on all 4 sides + grid in middle
  const areaW = BELT * 2 + GRID_COLS * CELL + (GRID_COLS - 1) * 2;  // 2px gap
  const areaH = BELT * 2 + GRID_ROWS * CELL + (GRID_ROWS - 1) * 2;

  gameArea.style.width  = areaW + 'px';
  gameArea.style.height = areaH + 'px';

  // Position the grid inside, after the belt
  gridEl.style.left   = BELT + 'px';
  gridEl.style.top    = BELT + 'px';
  gridEl.style.width  = (GRID_COLS * CELL + (GRID_COLS - 1) * 2) + 'px';
  gridEl.style.height = (GRID_ROWS * CELL + (GRID_ROWS - 1) * 2) + 'px';
  gridEl.style.gridTemplateColumns = `repeat(${GRID_COLS}, ${CELL}px)`;
  gridEl.style.gridTemplateRows    = `repeat(${GRID_ROWS}, ${CELL}px)`;

  // Canvas covers the whole game area
  canvas.width  = areaW;
  canvas.height = areaH;

  // Belt path: counter-clockwise loop around the grid
  // Each waypoint is the CENTER of a unit position
  buildBeltPath(areaW, areaH);
}

function buildBeltPath(W, H) {
  /*
    Belt path goes counter-clockwise:
    Top edge (left→right), Right edge (top→bottom),
    Bottom edge (right→left), Left edge (bottom→top)
    Units travel along this path.
  */
  beltPath = [];

  const half = BELT / 2;  // center of belt strip

  // TOP: left to right
  for (let x = half; x <= W - half; x += 4) {
    beltPath.push({ x, y: half });
  }
  // RIGHT: top to bottom
  for (let y = half; y <= H - half; y += 4) {
    beltPath.push({ x: W - half, y });
  }
  // BOTTOM: right to left
  for (let x = W - half; x >= half; x -= 4) {
    beltPath.push({ x, y: H - half });
  }
  // LEFT: bottom to top
  for (let y = H - half; y >= half; y -= 4) {
    beltPath.push({ x: half, y });
  }

  totalPathLen = beltPath.length;
}

// ─────────────────────────────────────────────
// BLOCK GRID
// ─────────────────────────────────────────────

function buildGrid() {
  gridEl.innerHTML = '';
  blocks = [];

  // Density of blocks increases with level
  const density = Math.min(0.5 + level * 0.1, 1.0);

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (Math.random() > density) continue;

      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const id    = `block-${row}-${col}`;

      const el = document.createElement('div');
      el.className = `block ${color}`;
      el.id = id;
      el.style.gridRow    = row + 1;
      el.style.gridColumn = col + 1;

      gridEl.appendChild(el);

      blocks.push({ id, row, col, color, alive: true, el });
    }
  }

  updateHUD();
}

// ─────────────────────────────────────────────
// UNITS
// ─────────────────────────────────────────────

let unitIdCounter = 0;

function spawnUnit(color, ammo) {
  // Start at a random position on the belt path
  const startIndex = Math.floor(Math.random() * totalPathLen);

  units.push({
    id:         unitIdCounter++,
    color,
    ammo:       ammo || BASE_AMMO,
    pathIndex:  startIndex,
    shootTimer: 0,  // frames until next shot attempt
  });
}

function respawnWaiting(unitData) {
  // Remove from waiting pool and put back on belt
  waitingPool = waitingPool.filter(u => u.id !== unitData.id);
  spawnUnit(unitData.color, BASE_AMMO);  // fresh ammo
  renderWaitingList();
}

// ─────────────────────────────────────────────
// SHOOTING & MATCHING
// ─────────────────────────────────────────────

// Returns the grid cell that a unit is currently "facing"
// (the block closest to the unit's position)
function getTargetBlock(unit) {
  const pos = beltPath[Math.floor(unit.pathIndex) % beltPath.length];
  if (!pos) return null;

  // Convert unit canvas coords to grid coords
  const gridX = pos.x - BELT;
  const gridY = pos.y - BELT;

  // Determine which column/row is closest
  const col = Math.round(gridX / (CELL + 2));
  const row = Math.round(gridY / (CELL + 2));

  // Find a living block at that position with matching color
  return blocks.find(b =>
    b.alive &&
    b.color === unit.color &&
    Math.abs(b.col - col) <= 1 &&
    Math.abs(b.row - row) <= 1
  ) || null;
}

// Returns the closest alive matching block to a unit (line-of-sight style)
function findMatchingBlock(unit) {
  const pos = beltPath[Math.floor(unit.pathIndex) % beltPath.length];
  if (!pos) return null;

  let closest = null;
  let minDist  = Infinity;

  for (const block of blocks) {
    if (!block.alive || block.color !== unit.color) continue;

    // Block center in canvas coords
    const bx = BELT + block.col * (CELL + 2) + CELL / 2;
    const by = BELT + block.row * (CELL + 2) + CELL / 2;

    const dist = Math.hypot(pos.x - bx, pos.y - by);

    // Shoot range: belt thickness + 3 cells
    const maxRange = BELT + CELL * 3;
    if (dist < maxRange && dist < minDist) {
      minDist = dist;
      closest = { block, bx, by, dist };
    }
  }

  return closest;
}

function destroyBlock(block) {
  block.alive = false;
  block.el.classList.add('hit');

  // Remove element after animation
  setTimeout(() => block.el.remove(), 250);

  score += 10 * level;
  updateHUD();

  // Check win condition
  if (blocks.every(b => !b.alive)) {
    setTimeout(handleWin, 400);
  }
}

// ─────────────────────────────────────────────
// BULLET EFFECTS (visual only)
// ─────────────────────────────────────────────

let bullets = [];  // { x, y, tx, ty, color, progress }

function fireBullet(fromX, fromY, toX, toY, color) {
  bullets.push({ x: fromX, y: fromY, tx: toX, ty: toY, color, progress: 0 });
}

// ─────────────────────────────────────────────
// GAME LOOP
// ─────────────────────────────────────────────

function gameLoop(timestamp) {
  if (!gameRunning) return;

  const delta = Math.min(timestamp - lastTime, 50);  // cap delta
  lastTime = timestamp;

  update(delta);
  draw();

  animFrame = requestAnimationFrame(gameLoop);
}

function update(delta) {
  const moveAmount = SPEED * (delta / FRAME_MS);

  // ── Move units along belt ──
  for (const unit of units) {
    unit.pathIndex = (unit.pathIndex + moveAmount) % totalPathLen;

    // Shoot timer countdown
    unit.shootTimer -= delta;

    if (unit.shootTimer <= 0) {
      unit.shootTimer = 600;  // try shooting every 600ms

      const target = findMatchingBlock(unit);
      if (target) {
        // Fire bullet
        const upos = beltPath[Math.floor(unit.pathIndex)];
        fireBullet(upos.x, upos.y, target.bx, target.by, unit.color);

        // Destroy block after a short delay (bullet travel time)
        const capturedBlock = target.block;
        setTimeout(() => {
          if (capturedBlock.alive) {
            destroyBlock(capturedBlock);
          }
        }, 200);

        unit.ammo--;

        if (unit.ammo <= 0) {
          // Move to waiting pool
          waitingPool.push({ id: unit.id, color: unit.color });
          renderWaitingList();
        }
      }
    }
  }

  // Remove units with 0 ammo from active list
  units = units.filter(u => u.ammo > 0);

  // ── Animate bullets ──
  for (const b of bullets) {
    b.progress += delta / 200;  // bullet travels full distance in 200ms
  }
  bullets = bullets.filter(b => b.progress < 1);
}

// ─────────────────────────────────────────────
// DRAWING (Canvas)
// ─────────────────────────────────────────────

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawBeltArrows();
  drawBullets();
  drawUnits();
}

function drawBeltArrows() {
  // Draw small direction arrows on the belt to show movement direction
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const step = 40;
  for (let i = 0; i < beltPath.length; i += step) {
    const curr = beltPath[i];
    const next = beltPath[(i + 4) % beltPath.length];
    const angle = Math.atan2(next.y - curr.y, next.x - curr.x);

    ctx.save();
    ctx.translate(curr.x, curr.y);
    ctx.rotate(angle);
    ctx.fillText('▶', 0, 0);
    ctx.restore();
  }
}

function drawUnits(){
  for (const unit of units) {
    const idx = Math.floor(unit.pathIndex) % beltPath.length;
    const pos = beltPath[idx];
    if (!pos) continue;

    const color = COLOR_MAP[unit.color];
    const r = UNIT_SIZE / 2;

    // Glow
    ctx.shadowColor = color;
    ctx.shadowBlur  = 14;

    // Body circle
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color + '33';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Color dot in center
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Ammo bar
    const barW = UNIT_SIZE;
    const barH = 4;
    const barX = pos.x - barW / 2;
    const barY = pos.y + r + 4;
    const fillW = (unit.ammo / BASE_AMMO) * barW;

    ctx.fillStyle = '#222244';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = color;
    ctx.fillRect(barX, barY, fillW, barH);

    // Ammo number
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(unit.ammo, pos.x, pos.y);
  }
}

function drawBullets() {
  for (const b of bullets) {
    const x = b.x + (b.tx - b.x) * b.progress;
    const y = b.y + (b.ty - b.y) * b.progress;

    const color = COLOR_MAP[b.color];

    ctx.shadowColor = color;
    ctx.shadowBlur  = 10;

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.shadowBlur = 0;
  }
}

// ─────────────────────────────────────────────
// HUD
// ─────────────────────────────────────────────

function updateHUD() {
  scoreEl.textContent      = score;
  blockCountEl.textContent = blocks.filter(b => b.alive).length;
  levelEl.textContent      = level;
}

function renderWaitingList() {
  waitingList.innerHTML = '';

  if (waitingPool.length === 0) {
    waitingList.innerHTML = '<p style="color:#444466;font-size:0.65rem;text-align:center">Empty</p>';
    return;
  }

  for (const unit of waitingPool) {
    const div = document.createElement('div');
    div.className = 'waiting-unit';
    div.style.setProperty('--c', COLOR_MAP[unit.color]);
    div.innerHTML = `
      <span>${unit.color.toUpperCase()}</span>
      <span class="ammo-badge">↺ RE-SPAWN</span>
    `;
    div.addEventListener('click', () => respawnWaiting(unit));
    waitingList.appendChild(div);
  }
}

// ─────────────────────────────────────────────
// WIN / LOSE / RESTART
// ─────────────────────────────────────────────

function handleWin() {
  gameRunning = false;
  cancelAnimationFrame(animFrame);

  overlayTitle.textContent = '✨ YOU WIN!';
  overlayTitle.style.color = '#44ff88';
  overlayMsg.textContent   = `Level ${level} cleared! Score: ${score}`;
  overlay.classList.remove('hidden');
}

function nextLevel() {
  level++;
  startGame();
}

function startGame() {
  // Stop any existing loop
  gameRunning = false;
  cancelAnimationFrame(animFrame);

  // Reset state
  units       = [];
  waitingPool = [];
  bullets     = [];

  setupLayout();
  buildGrid();
  renderWaitingList();
  updateHUD();

  overlay.classList.add('hidden');

  // Spawn a couple of units to start
  spawnUnit('red');
  spawnUnit('blue');

  gameRunning = true;
  lastTime    = performance.now();
  animFrame   = requestAnimationFrame(gameLoop);
}

// ─────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────

// Color picker
colorBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    colorBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedColor = btn.dataset.color;
  });
});

// Spawn button
spawnBtn.addEventListener('click', () => {
  if (!gameRunning) return;

  // Limit belt to 6 active units to avoid crowding
  if (units.length >= 6) {
    spawnBtn.textContent = '⚠ Belt full!';
    setTimeout(() => spawnBtn.textContent = '⚡ SPAWN UNIT', 1200);
    return;
  }

  spawnUnit(selectedColor);
});

// Restart button
restartBtn.addEventListener('click', () => {
  level = 1;
  score = 0;
  startGame();
});

// Overlay play-again / next level
overlayBtn.addEventListener('click', () => {
  if (overlayTitle.textContent.includes('WIN')) {
    nextLevel();
  } else {
    level = 1;
    score = 0;
    startGame();
  }
});

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────

startGame();
