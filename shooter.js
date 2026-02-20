console.log("[shooter] loaded");

(() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const len = (x, y) => Math.hypot(x, y);

  function makeDiv(className, parent) {
    const d = document.createElement("div");
    d.className = className;
    parent.appendChild(d);
    return d;
  }

  // --- inject minimal CSS (battle-only DOM sprites) ---
  function ensureCss() {
    if (document.getElementById("shooterCss")) return;
    const style = document.createElement("style");
    style.id = "shooterCss";
    style.textContent = `
      #field { position: relative; overflow:hidden; }
      .eEnemy, .eBullet, .eBoss, .eBossBullet, .eObstacle, .eBubble {
        position:absolute; left:0; top:0;
        user-select:none; -webkit-user-select:none;
      }
      .eEnemy{
        width:22px; height:22px; border-radius:999px;
        background: rgba(255,255,255,0.85);
        opacity: 0.9;
      }
      .eBullet{
        width:8px; height:8px; border-radius:999px;
        background: rgba(255,255,255,0.85);
      }
      .eBoss{
        width:90px; height:46px; border-radius:14px;
        background: rgba(255,255,255,0.25);
        border: 1px solid rgba(255,255,255,0.35);
        backdrop-filter: blur(2px);
      }
      .eBossBullet{
        width:10px; height:10px; border-radius:999px;
        background: rgba(255,255,255,0.65);
      }
      .eObstacle{
        width:46px; height:46px; border-radius:12px;
        border: 1px solid rgba(255,255,255,0.35);
        background: rgba(255,255,255,0.12);
      }
      .eObstacle[data-color="red"]{ background: rgba(255,80,80,0.18); }
      .eObstacle[data-color="blue"]{ background: rgba(80,160,255,0.18); }
      .eObstacle[data-color="green"]{ background: rgba(100,255,140,0.18); }

      .eBubble{
        padding: 6px 8px;
        border-radius: 999px;
        background: rgba(0,0,0,0.55);
        border: 1px solid rgba(255,255,255,0.25);
        color: #fff;
        font-size: 12px;
        white-space: nowrap;
        pointer-events:none;
      }
    `;
    document.head.appendChild(style);
  }

  const Shooter = {
    _mounted: false,
    _paused: false,
    _running: false,
    _raf: 0,
    _lastT: 0,

    // refs
    field: null,
    playerEl: null,

    // callbacks from index
    getPlayerPos: null,
    getState: null,
    setState: null,
    onMessage: null,
    onRequestHudRefresh: null,

    // reward accumulation (index側で “積む”)
    onReward: null,

    // entities
    enemies: [],
    bullets: [],
    obstacles: [],
    boss: null,
    bossBullets: [],

    // timers
    tEnemy: 0,
    tBossShot: 0,
    tBossSummon: 0,
    tPlayerShot: 0,

    // ---------- API ----------
    mount(opts) {
      ensureCss();

      this.field = opts.field;
      this.playerEl = opts.playerEl;

      this.getPlayerPos = opts.getPlayerPos;
      this.getState = opts.getState;
      this.setState = opts.setState;

      this.onMessage = opts.onMessage || (() => {});
      this.onRequestHudRefresh = opts.onRequestHudRefresh || (() => {});
      this.onReward = opts.onReward || (() => {});

      this._mounted = true;

      // obstacle tap
      // ★クリックが “戦闘中だけ” 有効になるように _onFieldClick 側で _running を見る
      this.field.addEventListener("click", this._onFieldClick, { passive: true });
    },

    unmount() {
      if (!this._mounted) return;
      this.stopStage();

      this._mounted = false;
      this._paused = false;

      this._clearAll();
      this.field?.removeEventListener("click", this._onFieldClick);

      this.field = null;
      this.playerEl = null;

      this.getPlayerPos = null;
      this.getState = null;
      this.setState = null;
      this.onMessage = null;
      this.onRequestHudRefresh = null;
      this.onReward = null;
    },

    startStage() {
      if (!this._mounted) return;

      // ★HP0で開始すると即 defeat になりやすいので最低限の安全弁
      //   （本当の復帰制御は index 側でやる前提。ここは “事故防止”）
      const d = this.getState?.() || {};
      if ((d.hp ?? 0) <= 0) {
        // ここで復帰したい/したくないは index が判断するはず。
        // shooter側では “開始できない” を通知して止めるだけにする。
        this.onMessage?.("HPが0のため戦闘を開始できません（復帰/回復が必要）");
        return;
      }

      this._clearAll();
      this._paused = false;
      this._running = true;
      this._lastT = performance.now();

      const stageLv = d.stageLv ?? 1;
      this.onMessage?.(`Stage ${stageLv} 開始！`);

      this._spawnBoss(stageLv);

      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(this._loop);
    },

    stopStage() {
      this._running = false;
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      this._clearAll();
    },

    setPaused(v) { this._paused = !!v; },
    isPaused() { return !!this._paused; },

    // ---------- internals ----------
    _clearAll() {
      for (const e of this.enemies) e.el.remove();
      for (const b of this.bullets) b.el.remove();
      for (const o of this.obstacles) { o.el.remove(); o.bubble?.remove(); }
      for (const bb of this.bossBullets) bb.el.remove();
      if (this.boss?.el) this.boss.el.remove();

      this.enemies = [];
      this.bullets = [];
      this.obstacles = [];
      this.bossBullets = [];
      this.boss = null;

      this.tEnemy = 0;
      this.tBossShot = 0;
      this.tBossSummon = 0;
      this.tPlayerShot = 0;
    },

    _loop: (t) => {
      const S = Shooter;
      if (!S._mounted) return;
      if (!S._running) return;

      const dt = Math.min(0.033, (t - S._lastT) / 1000);
      S._lastT = t;

      if (!S._paused) S._update(dt);

      if (!S._running) return;
      S._raf = requestAnimationFrame(S._loop);
    },

    _update(dt) {
      const d = this.getState();
      const stageLv = d.stageLv ?? 1;

      // ---- player auto-shot ----
      this.tPlayerShot -= dt;
      if (this.tPlayerShot <= 0) {
        this.tPlayerShot = 0.20 + Math.random() * 0.05;
        this._firePlayerBullet();
      }

      // ---- spawn enemies ----
      const maxSimul = 3 + Math.floor((stageLv - 1) * 0.8);
      this.tEnemy -= dt;
      if (this.tEnemy <= 0 && this.enemies.length < maxSimul) {
        this.tEnemy = Math.max(0.25, 1.0 - stageLv * 0.05);
        this._spawnEnemy(stageLv);
      }

      // ---- boss behavior ----
      if (this.boss) this._updateBoss(dt, stageLv);

      // ---- move ----
      this._stepBullets(dt);
      this._stepEnemies(dt);
      this._stepBossBullets(dt);

      // ---- collisions ----
      this._collidePlayerBulletsVsEnemies();
      this._collidePlayerBulletsVsBoss();
      this._collideEnemyVsPlayer();
      this._collideBossBulletsVsPlayer();

      // ---- obstacle: bubble show/hide ----
      this._updateObstacleBubbles();

      // ---- death check ----
      if ((d.hp ?? 0) <= 0) this._onDefeat("HPが0になった…");
    },

    _fieldSize() {
      const r = this.field.getBoundingClientRect();
      return { w: r.width, h: r.height };
    },

    _playerPos() {
      return this.getPlayerPos ? this.getPlayerPos() : { x: 0, y: 0 };
    },

    _firePlayerBullet() {
      const { x, y } = this._playerPos();
      const vx = 0;
      const vy = -520;

      const el = makeDiv("eBullet", this.field);
      const b = { x, y, vx, vy, r: 4, el };
      this.bullets.push(b);
      this._syncEl(el, x, y, 8, 8);
    },

    _spawnEnemy(stageLv) {
      const { w, h } = this._fieldSize();
      const p = this._playerPos();

      const side = Math.floor(Math.random() * 4);
      let x = 0, y = 0;
      if (side === 0) { x = Math.random() * w; y = -20; }
      if (side === 1) { x = w + 20; y = Math.random() * h; }
      if (side === 2) { x = Math.random() * w; y = h + 20; }
      if (side === 3) { x = -20; y = Math.random() * h; }

      const dx = p.x - x;
      const dy = p.y - y;
      const dist = Math.max(1, len(dx, dy));
      const spd = 90 + stageLv * 10;

      const vx = dx / dist * spd;
      const vy = dy / dist * spd;

      const el = makeDiv("eEnemy", this.field);
      const e = { x, y, vx, vy, r: 11, el, dmg: 10 };
      this.enemies.push(e);
      this._syncEl(el, x, y, 22, 22);
    },

    _spawnBoss(stageLv) {
      const { w } = this._fieldSize();
      const el = makeDiv("eBoss", this.field);

      const hpMax = 250 + stageLv * 120;
      this.boss = {
        x: w / 2,
        y: 60,
        vx: 140 + stageLv * 6,
        r: 36,
        hp: hpMax,
        hpMax,
        el,
      };
      this._syncEl(el, this.boss.x, this.boss.y, 90, 46);

      this._spawnObstaclePack(stageLv, true);
    },

    _updateBoss(dt, stageLv) {
      const { w } = this._fieldSize();
      const b = this.boss;

      b.x += b.vx * dt;
      if (b.x < 50) { b.x = 50; b.vx *= -1; }
      if (b.x > w - 50) { b.x = w - 50; b.vx *= -1; }
      this._syncEl(b.el, b.x, b.y, 90, 46);

      this.tBossShot -= dt;
      if (this.tBossShot <= 0) {
        this.tBossShot = Math.max(0.35, 1.2 - stageLv * 0.05);
        this._fireBossRadial(stageLv);
      }

      this.tBossSummon -= dt;
      if (this.tBossSummon <= 0) {
        this.tBossSummon = Math.max(1.2, 3.5 - stageLv * 0.1);
        this._spawnObstaclePack(stageLv, true);
      }
    },

    _fireBossRadial(stageLv) {
      const b = this.boss;
      if (!b) return;
      const n = 10 + Math.floor(stageLv * 0.8);
      const speed = 120 + stageLv * 8;

      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const vx = Math.cos(a) * speed;
        const vy = Math.sin(a) * speed;
        const el = makeDiv("eBossBullet", this.field);
        const bb = { x: b.x, y: b.y + 10, vx, vy, r: 5, el, dmg: 8 + stageLv };
        this.bossBullets.push(bb);
        this._syncEl(el, bb.x, bb.y, 10, 10);
      }
    },

    _spawnObstaclePack(stageLv, fromBoss) {
      const { w, h } = this._fieldSize();
      const count = 1 + Math.floor(stageLv / 3);

      for (let i = 0; i < count; i++) {
        const x = 40 + Math.random() * (w - 80);
        const y = h * (0.45 + Math.random() * 0.45);

        const colors = ["red", "blue", "green"];
        const color = colors[Math.floor(Math.random() * colors.length)];

        const el = makeDiv("eObstacle", this.field);
        el.dataset.color = color;

        const life = fromBoss ? (4.0 + stageLv * 0.3) : 999;
        const o = { x, y, r: 23, el, color, life, fromBoss, bubble: null };
        this.obstacles.push(o);
        this._syncEl(el, x, y, 46, 46);
      }
    },

    _stepBullets(dt) {
      const { w, h } = this._fieldSize();
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        this._syncEl(b.el, b.x, b.y, 8, 8);

        if (b.x < -30 || b.x > w + 30 || b.y < -30 || b.y > h + 30) {
          b.el.remove();
          this.bullets.splice(i, 1);
        }
      }
    },

    _stepEnemies(dt) {
      const { w, h } = this._fieldSize();
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        this._syncEl(e.el, e.x, e.y, 22, 22);

        if (e.x < -60 || e.x > w + 60 || e.y < -60 || e.y > h + 60) {
          e.el.remove();
          this.enemies.splice(i, 1);
        }
      }
    },

    _stepBossBullets(dt) {
      const { w, h } = this._fieldSize();
      for (let i = this.bossBullets.length - 1; i >= 0; i--) {
        const b = this.bossBullets[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        this._syncEl(b.el, b.x, b.y, 10, 10);

        if (b.x < -40 || b.x > w + 40 || b.y < -40 || b.y > h + 40) {
          b.el.remove();
          this.bossBullets.splice(i, 1);
        }
      }

      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        const o = this.obstacles[i];
        if (o.life !== 999) {
          o.life -= dt;
          if (o.life <= 0) {
            o.el.remove();
            o.bubble?.remove();
            this.obstacles.splice(i, 1);
          }
        }
      }
    },

    _collidePlayerBulletsVsEnemies() {
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        let hit = false;

        for (let j = this.bullets.length - 1; j >= 0; j--) {
          const b = this.bullets[j];
          const d2 = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
          if (d2 <= (e.r + b.r) ** 2) {
            b.el.remove();
            this.bullets.splice(j, 1);
            hit = true;
            break;
          }
        }

        if (hit) {
          e.el.remove();
          this.enemies.splice(i, 1);

          this.setState((d) => { d.exp = (d.exp ?? 0) + 5; });
          this.onRequestHudRefresh?.();
        }
      }
    },

    _collidePlayerBulletsVsBoss() {
      const boss = this.boss;
      if (!boss) return;

      for (let j = this.bullets.length - 1; j >= 0; j--) {
        const b = this.bullets[j];
        const d2 = (boss.x - b.x) ** 2 + (boss.y - b.y) ** 2;
        if (d2 <= (boss.r + b.r) ** 2) {
          b.el.remove();
          this.bullets.splice(j, 1);

          boss.hp -= 6;
          if (boss.hp <= 0) {
            this._onBossDefeat();
            return;
          }
        }
      }
    },

    _collideEnemyVsPlayer() {
      const p = this._playerPos();
      for (let i = this.enemies.length - 1; i >= 0; i--) {
        const e = this.enemies[i];
        const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
        if (d2 <= (e.r + 18) ** 2) {
          e.el.remove();
          this.enemies.splice(i, 1);

          this.setState((d) => { d.hp = Math.max(0, (d.hp ?? 0) - e.dmg); });
          this.onRequestHudRefresh?.();
        }
      }
    },

    _collideBossBulletsVsPlayer() {
      const p = this._playerPos();
      for (let i = this.bossBullets.length - 1; i >= 0; i--) {
        const b = this.bossBullets[i];
        const d2 = (b.x - p.x) ** 2 + (b.y - p.y) ** 2;
        if (d2 <= (b.r + 18) ** 2) {
          b.el.remove();
          this.bossBullets.splice(i, 1);

          this.setState((d) => { d.hp = Math.max(0, (d.hp ?? 0) - b.dmg); });
          this.onRequestHudRefresh?.();
        }
      }
    },

    _updateObstacleBubbles() {
      const p = this._playerPos();
      for (const o of this.obstacles) {
        const near = len(o.x - p.x, o.y - p.y) <= 70;

        if (near && !o.bubble) {
          const b = makeDiv("eBubble", this.field);
          b.textContent = `${o.color}：タップで破壊`;
          o.bubble = b;
        } else if (!near && o.bubble) {
          o.bubble.remove();
          o.bubble = null;
        }

        if (o.bubble) {
          o.bubble.style.left = (o.x - 40) + "px";
          o.bubble.style.top  = (o.y - 44) + "px";
        }
      }
    },

    _onFieldClick: (ev) => {
      const S = Shooter;
      if (!S._mounted || S._paused) return;
      if (!S._running) return; // ★戦闘中だけ反応

      const rect = S.field.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      const p = S._playerPos();

      for (let i = S.obstacles.length - 1; i >= 0; i--) {
        const o = S.obstacles[i];
        const near = len(o.x - p.x, o.y - p.y) <= 80;
        if (!near) continue;

        if (Math.abs(x - o.x) <= 23 && Math.abs(y - o.y) <= 23) {
          o.el.remove();
          o.bubble?.remove();
          S.obstacles.splice(i, 1);

          const rewardEnergy = 5 + Math.floor(Math.random() * 6);
          const cats = ["1","2","3","4","8"];
          const cat = cats[Math.floor(Math.random() * cats.length)];

          // ★即付与は禁止。index側に「積む」
          S.onReward?.({ energy: rewardEnergy, cat });

          S.onMessage?.(`設置物破壊！ +${rewardEnergy} energy / カードカテゴリ${cat}`);
          S.onRequestHudRefresh?.();
          return;
        }
      }
    },

    _onDefeat(reason) {
      this.onMessage?.(reason);

      // ★積み方式なので shooter 側で energy を半減させない（index側のルールに任せる）
      // this.setState((d) => { d.energy = Math.floor((d.energy ?? 0) * 0.5); });

      this.onRequestHudRefresh?.();

      this.stopStage();
      if (typeof this.onDefeatCallback === "function") this.onDefeatCallback();
    },

    _onBossDefeat() {
      this.onMessage?.("ボス撃破！ 次へ進む？ 脱出する？");

      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        const o = this.obstacles[i];
        if (o.fromBoss) {
          o.el.remove();
          o.bubble?.remove();
          this.obstacles.splice(i, 1);
        }
      }

      this.stopStage();
      if (typeof this.onBossDefeatCallback === "function") this.onBossDefeatCallback();
    },

    _syncEl(el, cx, cy, w, h) {
      el.style.left = (cx - w / 2) + "px";
      el.style.top  = (cy - h / 2) + "px";
    },
  };

  window.Shooter = Shooter;
})();
