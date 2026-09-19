      // ---- movement / behavior ----------------------------------------------------------
      function roomOf(x, z) {
        for (var i = 0; i < rooms.length; i++) {
          var r = rooms[i];
          if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return r;
        }
        return null;
      }
      function clamp01(v) {
        return Math.max(0, Math.min(1, v));
      }
      function smooth01(v) {
        v = clamp01(v);
        return v * v * (3 - 2 * v);
      }
      var NAV_MARGIN = 0.72;
      var navBlocks = null;
      function rectBlock(x, z, hx, hz, pad) {
        pad = pad == null ? NAV_MARGIN : pad;
        navBlocks.push({ x0: x - hx - pad, x1: x + hx + pad, z0: z - hz - pad, z1: z + hz + pad });
      }
      function buildNavBlocks() {
        navBlocks = [];
        rooms.forEach(function (r) {
          (r.desks || []).forEach(function (d) { rectBlock(d.x, d.z, 1.75, 0.9, 0.55); });
          if (r.board) rectBlock(r.board.x, r.board.z, 1.65, 0.25, 0.55);
          if (r.kind === 'lobby') {
            var sx = r.x0 + (r.x1 - r.x0) * 0.26, sz = r.cz - 2.5;
            var loungeX = Math.min(r.x1 - 4.2, sx + 4.6), loungeZ = sz - 2.2;
            var shelfX = r.x1 - 3.1, shelfZ = r.cz + 3.2;
            rectBlock(r.cx, r.cz + 2.0, 3.35, 0.9, 0.55); // reception desk
            rectBlock(sx, sz - 2, 2.8, 1.05, 0.45);
            rectBlock(sx - 3.6, sz + 1.4, 1.05, 2.8, 0.45);
            rectBlock(sx, sz + 0.6, 1.1, 0.7, 0.45);
            rectBlock(loungeX, loungeZ, 1.15, 1.05, 0.42);
            rectBlock(loungeX + 1.9, loungeZ + 0.8, 0.55, 0.55, 0.35);
            rectBlock(shelfX, shelfZ, 0.75, 1.3, 0.4);
            rectBlock(r.x0 + 2, r.z1 - 2, 0.65, 0.65, 0.45);
            rectBlock(r.x1 - 2, r.z0 + 2, 0.65, 0.65, 0.45);
          } else if (r.kind === 'meeting') {
            var credZ = r.isNorth ? r.z1 - 1.7 : r.z0 + 1.7;
            var ideaX = r.x0 + 3.4;
            rectBlock(r.cx, r.cz, 3.7, 1.55, 0.65);
            rectBlock(r.x1 - 2.7, credZ, 1.35, 0.45, 0.4);
            rectBlock(ideaX, r.cz, 1.2, 0.65, 0.45);
            rectBlock(r.x0 + 2, r.isNorth ? r.z0 + 2 : r.z1 - 2, 0.65, 0.65, 0.45);
          } else if (r.kind === 'presentation') {
            var scrZ = r.isNorth ? r.z0 + 1.0 : r.z1 - 1.0;
            rectBlock(r.cx, scrZ, 4.2, 0.35, 0.55);
            rectBlock(r.cx - 3.6, scrZ + (r.isNorth ? 2.4 : -2.4), 0.75, 0.65, 0.55);
            rectBlock(r.cx + 3.3, scrZ + (r.isNorth ? 2.7 : -2.7), 1.55, 0.9, 0.45);
          } else if (r.kind === 'coffee') {
            var cLen = Math.min(8, (r.x1 - r.x0) - 5);
            var cz2 = r.isNorth ? r.z0 + 2.2 : r.z1 - 2.2;
            var wcX = r.x1 - 2.4, wcZ = r.isNorth ? r.z0 + 2.4 : r.z1 - 2.4;
            var snackX = r.x0 + 2.0, snackZ = r.isNorth ? r.z1 - 2.6 : r.z0 + 2.6;
            rectBlock(r.cx, cz2, cLen / 2 + 0.25, 0.9, 0.55);
            rectBlock(wcX, wcZ, 0.8, 0.8, 0.45);
            rectBlock(snackX, snackZ, 1.05, 0.45, 0.42);
            for (var ci = 0; ci < 2; ci++) {
              var tx2 = r.x0 + (r.x1 - r.x0) * (0.32 + ci * 0.36);
              var tz2 = r.isNorth ? r.cz + 2.4 : r.cz - 2.4;
              rectBlock(tx2, tz2, 1.05, 1.05, 0.5);
              rectBlock(tx2 - 1.5, tz2, 0.55, 0.55, 0.35);
              rectBlock(tx2 + 1.5, tz2, 0.55, 0.55, 0.35);
            }
            rectBlock(r.x0 + 1.8, r.isNorth ? r.z1 - 2 : r.z0 + 2, 0.65, 0.65, 0.45);
          } else if (r.kind === 'fun') {
            for (var ai = 0; ai < 2; ai++) rectBlock(r.x0 + 2.4 + ai * 2.6, r.isNorth ? r.z0 + 2.0 : r.z1 - 2.0, 0.95, 0.75, 0.55);
            rectBlock(r.cx + 1.5, r.cz + (r.isNorth ? 1.6 : -1.6), 2.45, 1.45, 0.65);
            rectBlock(r.x0 + 3.2, r.isNorth ? r.z1 - 3.1 : r.z0 + 3.1, 1.7, 0.95, 0.45);
            rectBlock(r.x1 - 2.2, r.isNorth ? r.z0 + 2.3 : r.z1 - 2.3, 0.85, 0.55, 0.45);
            rectBlock(r.x0 + 1.6, r.isNorth ? r.z0 + 4.2 : r.z1 - 4.2, 0.65, 0.65, 0.45);
            [[-0.32, 2.6], [0.4, 4.0]].forEach(function (o) {
              var bx = r.x1 - 3 + o[0], bz = (r.isNorth ? r.z1 - 4 : r.z0 + 4) + (r.isNorth ? -o[1] + 2 : o[1] - 2);
              rectBlock(bx, bz, 0.9, 0.9, 0.45);
            });
          }
          if (r.kind === 'dept') {
            rectBlock(r.x0 + 3.4, r.isNorth ? r.z0 + 3.2 : r.z1 - 3.2, 1.2, 0.65, 0.45);
            rectBlock(r.x1 - 2, r.isNorth ? r.z1 - 2.6 : r.z0 + 2.6, 0.65, 0.65, 0.45);
          }
        });
      }
      function nearPoint(x, z, p, radius) {
        return p && Math.hypot(x - p.x, z - p.z) <= radius;
      }
      function inCorridor(x, z) {
        return x >= -W / 2 + NAV_MARGIN && x <= W / 2 - NAV_MARGIN && z >= -CORR / 2 + NAV_MARGIN && z <= CORR / 2 - NAV_MARGIN;
      }
      function inRoomWalkable(x, z) {
        var r = roomOf(x, z);
        if (!r) return null;
        if (x < r.x0 + NAV_MARGIN || x > r.x1 - NAV_MARGIN || z < r.z0 + NAV_MARGIN || z > r.z1 - NAV_MARGIN) return null;
        return r;
      }
      function walkableSpace(x, z, allow) {
        if (nearPoint(x, z, allow, 1.15)) return true;
        
        // Door transitions (room to corridor)
        for (var i = 0; i < rooms.length; i++) {
          var r = rooms[i];
          var wz = r.isNorth ? r.z1 : r.z0;
          if (Math.abs(x - r.door.x) < 2.0 && Math.abs(z - wz) < NAV_MARGIN + 0.1) {
            return true;
          }
        }
        
        // Lobby entrance transition (lobby to street)
        if (Math.abs(x - lobbyRoom.cx) < 2.0 && Math.abs(z - lobbyRoom.z1) < NAV_MARGIN + 0.1) {
          return true;
        }

        var r = inRoomWalkable(x, z);
        if (r) return true;
        if (inCorridor(x, z)) return true;
        
        // Street path outside the lobby entrance
        var pathLen = Math.max(18, D * 0.22);
        if (x >= lobbyRoom.cx - 2.3 + NAV_MARGIN && x <= lobbyRoom.cx + 2.3 - NAV_MARGIN &&
            z >= lobbyRoom.z1 && z <= lobbyRoom.z1 + pathLen - NAV_MARGIN) {
          return true;
        }
        
        return false;
      }
      function inBlock(x, z, allow, allow2) {
        if (!navBlocks) buildNavBlocks();
        if (nearPoint(x, z, allow, 1.15) || nearPoint(x, z, allow2, 1.15)) return false;
        for (var i = 0; i < navBlocks.length; i++) {
          var b = navBlocks[i];
          if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return true;
        }
        return false;
      }
      function canStandAt(x, z, allow, allow2) {
        return walkableSpace(x, z, allow) && !inBlock(x, z, allow, allow2);
      }
      function segmentClear(x0, z0, x1, z1, allow, allow2) {
        var d = Math.hypot(x1 - x0, z1 - z0);
        var steps = Math.max(1, Math.ceil(d / 0.55));
        for (var i = 1; i <= steps; i++) {
          var t = i / steps;
          if (!canStandAt(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, allow, allow2)) return false;
        }
        return true;
      }
      function adjustStandPoint(x, z) {
        if (canStandAt(x, z, null)) return { x: x, z: z };
        for (var ring = 1; ring <= 5; ring++) {
          var rad = ring * 0.8;
          for (var i = 0; i < 16; i++) {
            var a = i * Math.PI * 2 / 16;
            var px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
            if (canStandAt(px, pz, null)) return { x: px, z: pz };
          }
        }
        return { x: x, z: z };
      }
      function findNavPath(sx, sz, tx, tz) {
        var target = { x: tx, z: tz };
        var startPt = { x: sx, z: sz };
        if (segmentClear(sx, sz, tx, tz, target, startPt)) return [{ x: tx, z: tz }];
        var step = 2.0, minX = -W / 2 + NAV_MARGIN, maxX = W / 2 - NAV_MARGIN;
        var minZ = -D / 2 + NAV_MARGIN, maxZ = D / 2 - NAV_MARGIN;
        function snap(v) { return Math.round(v / step) * step; }
        function key(x, z) { return x.toFixed(1) + ',' + z.toFixed(1); }
        function pointFor(x, z) { return { x: Math.max(minX, Math.min(maxX, snap(x))), z: Math.max(minZ, Math.min(maxZ, snap(z))) }; }
        var start = pointFor(sx, sz);
        var end = pointFor(tx, tz);
        var open = [{ x: start.x, z: start.z, g: 0, f: Math.hypot(end.x - start.x, end.z - start.z), prev: null }];
        var seen = {};
        var best = null;
        for (var guard = 0; open.length && guard < 3000; guard++) {
          open.sort(function (a, b) { return a.f - b.f; });
          var cur = open.shift();
          var ck = key(cur.x, cur.z);
          if (seen[ck]) continue;
          seen[ck] = cur;
          if (!best || Math.hypot(end.x - cur.x, end.z - cur.z) < Math.hypot(end.x - best.x, end.z - best.z)) best = cur;
          if (Math.hypot(end.x - cur.x, end.z - cur.z) <= step * 0.75 && segmentClear(cur.x, cur.z, tx, tz, target, startPt)) { best = { x: tx, z: tz, prev: cur }; break; }
          for (var ox = -1; ox <= 1; ox++) for (var oz = -1; oz <= 1; oz++) {
            if (!ox && !oz) continue;
            var nx = cur.x + ox * step, nz = cur.z + oz * step;
            if (nx < minX || nx > maxX || nz < minZ || nz > maxZ) continue;
            if (!canStandAt(nx, nz, target, startPt) || !segmentClear(cur.x, cur.z, nx, nz, target, startPt)) continue;
            var nk = key(nx, nz);
            if (seen[nk]) continue;
            var cost = cur.g + Math.hypot(ox, oz) * step;
            open.push({ x: nx, z: nz, g: cost, f: cost + Math.hypot(end.x - nx, end.z - nz), prev: cur });
          }
        }
        if (!best) return [{ x: tx, z: tz }];
        var out = [];
        for (var n = best; n && n.prev; n = n.prev) out.push({ x: n.x, z: n.z });
        out.reverse();
        out.push({ x: tx, z: tz });
        return out;
      }
      function fuzzyWalkInit(a) {
        a.walkT = 0;
        a.walkPauseT = Math.random() < 0.18 ? 0.1 + Math.random() * 0.28 : 0;
        a.walkStyle = {
          cruise: 0.88 + Math.random() * 0.24,
        };
      }
      function routeTo(a, tx, tz) {
        navBlocks = null;
        var target = adjustStandPoint(tx, tz);
        tx = target.x; tz = target.z;
        var from = roomOf(a.x, a.z), to = roomOf(tx, tz);
        var p = [];
        
        // Handle starting from the street outside
        if (!from && a.z > lobbyRoom.z1 - 0.2) {
          p.push({ x: lobbyRoom.cx, z: lobbyRoom.z1 + 1.0 }); // just outside lobby door
          p.push({ x: lobbyRoom.cx, z: lobbyRoom.z1 - 2.0 }); // just inside lobby
          from = lobbyRoom;
        }
        
        if (from && from !== to) { p.push({ x: from.door.x, z: from.door.zIn }); p.push({ x: from.door.x, z: 0 }); }
        if (to && from !== to) { p.push({ x: to.door.x, z: 0 }); p.push({ x: to.door.x, z: to.door.zIn }); }
        p.push({ x: tx, z: tz });
        var routed = [], sx = a.x, sz = a.z;
        for (var i = 0; i < p.length; i++) {
          var leg = findNavPath(sx, sz, p[i].x, p[i].z);
          routed = routed.concat(leg);
          sx = p[i].x; sz = p[i].z;
        }
        p = routed;
        a.path = p;
        a.mode = 'walk';
        fuzzyWalkInit(a);
      }
      // --- activity engine: claim a free spot on an asset, walk there, DO the thing -------
      var ACT_ICON = {
        brew: '☕', stool: '☕', drinkwater: '🚰', watch: '📽️', meet: '📋', sofa: '😌',
        bean: '😌', seat: '🪑', arcade: '🎮', pool: '🎱', board: '✍️', stand: '🤔', perch: '💬',
        lounge: '📖', shelf: '📚', plant: '🪴', 'design-table': '🧩', 'focus-desk': '💻',
        'snack-shelf': '🍪', jukebox: '🎵',
      };
      var REACTION_ICON = {
        'brew-press': '☕', 'brew-steam': '♨️', 'brew-sniff': '😌',
        'drink-sip': '🚰', 'drink-refill': '💧', 'drink-shake': '🥤',
        'stool-sip': '☕', 'stool-chat': '💬', 'stool-snack': '🍪',
        'watch-nod': '📽️', 'watch-clap': '👏', 'watch-note': '📝',
        'meet-nod': '⏳', 'meet-note': '📝', 'meet-point': '👉',
        'sofa-relax': '😌', 'sofa-phone': '📱', 'sofa-stretch': '🙆',
        'bean-lounge': '😌', 'bean-phone': '📱', 'bean-think': '💡',
        'seat-sit': '🪑', 'seat-relax': '😌', 'seat-chat': '💬',
        'arcade-mash': '🎮', 'arcade-lean': '🕹️', 'arcade-cheer': '✨',
        'pool-aim': '🎱', 'pool-chalk': '🧊', 'pool-celebrate': '✨',
        'board-write': '✍️', 'board-point': '👉', 'board-erase': '🧽',
        'window-gaze': '🌤', 'window-stretch': '🙆', 'window-weather': '☂️',
        'perch-chat': '💬', 'perch-think': '💡', 'perch-point': '👉',
        'stand-think': '🤔', 'stand-scan': '👀', 'stand-wave': '👋',
        'lounge-read': '📖', 'lounge-scroll': '📱', 'lounge-nap': '😴', 'lounge-wave': '👋',
        'shelf-browse': '📚', 'shelf-pick': '📘', 'shelf-tidy': '🧹', 'shelf-point': '👉',
        'plant-water': '💧', 'plant-prune': '✂️', 'plant-smell': '🌿',
        'table-sketch': '✏️', 'table-build': '🧱', 'table-point': '👉', 'table-photo': '📸',
        'table-dice': '🎲', 'table-highfive': '🙌',
        'desk-type': '💻', 'desk-review': '👀', 'desk-doodle': '✏️', 'desk-stand': '🧍',
        'snack-pick': '🍪', 'snack-share': '🤝', 'snack-crunch': '😋',
        'jukebox-pick': '🎵', 'jukebox-dance': '💃', 'jukebox-bop': '🕺', 'jukebox-airdrum': '🥁',
      };
      // per-activity dwell window in sim-seconds [min, max] — applied on ARRIVAL (see step()),
      // so the walk over never eats the activity time and officers actually DO the thing
      var ACT_DWELL = {
        brew: [7, 12], stool: [16, 26], drinkwater: [6, 10], watch: [18, 30], meet: [16, 26],
        sofa: [16, 26], bean: [18, 28], seat: [16, 26], arcade: [16, 26], pool: [16, 26], board: [12, 20],
        stand: [6, 10], perch: [10, 16], window: [9, 15], lounge: [16, 26], shelf: [8, 14],
        plant: [7, 12], 'design-table': [14, 24], 'focus-desk': [10, 18], 'snack-shelf': [6, 11], jukebox: [12, 20],
      };
      function dwellFor(type) {
        var w = ACT_DWELL[type] || [8, 12];
        return w[0] + Math.random() * (w[1] - w[0]);
      }
      function pickReaction(spot) {
        var list = spot && spot.reactions && spot.reactions.length ? spot.reactions : [spot ? spot.type : 'stand'];
        return list[Math.floor(Math.random() * list.length)];
      }
      function releaseSpot(a) {
        if (a.spot && a.spot.busyBy === a) a.spot.busyBy = null;
        a.spot = null;
        a.reaction = null;
      }
      function clearSocial(a) {
        a.socialT = 0;
        a.socialKind = null;
        a.socialRole = null;
        a.socialPartner = null;
        a.socialIcon = null;
        a.chatT = 0;
        a.socialCooldown = 5 + Math.random() * 8;
      }
      function clearAbility(a) {
        if (a && a.abilityFx && a.abilityFx.parent && typeof removeAbilityFx === 'function') removeAbilityFx(a);
        a.abilityT = 0;
        a.abilityKind = null;
        a.abilityIcon = null;
        a.abilityTarget = null;
      }
      function clearDuelAfter(a) {
        a.duelAfterT = 0;
        a.duelAfterRole = null;
        a.duelAfterKind = null;
        a.duelAfterBeat = 0;
        a.duelAfterSpawned = false;
        a.duelAfterX = 0;
        a.duelAfterZ = 0;
      }
      function clearManual(a) {
        a.manualT = 0;
        a.manualKind = null;
        a.manualIcon = null;
      }
      var SOCIAL_KINDS = [
        { kind: 'chat', weight: 24, dur: 2.4 },
        { kind: 'duel', weight: 9, dur: 3.8 },
        { kind: 'duet', weight: 12, dur: 3.0 },
        { kind: 'highfive', weight: 16, dur: 2.0 },
        { kind: 'rps', weight: 15, dur: 3.4 },
        { kind: 'hug', weight: 11, dur: 2.7 },
        { kind: 'argument', weight: 12, dur: 3.1 },
        { kind: 'runaway', weight: 7, dur: 2.5 },
        { kind: 'slap', weight: 5, dur: 1.8 },
        { kind: 'kick', weight: 4, dur: 1.8 },
        { kind: 'spar', weight: 6, dur: 3.0 },
      ];
      function socialChoice(a, b) {
        var tense = a.def.state === 'blocked' || b.def.state === 'blocked' || a.def.state === 'failed' || b.def.state === 'failed';
        if (tense && Math.random() < 0.34) {
          return Math.random() < 0.46 ? 'argument' : (Math.random() < 0.55 ? 'runaway' : 'spar');
        }
        var total = 0;
        SOCIAL_KINDS.forEach(function (s) { total += s.weight; });
        var pick = Math.random() * total;
        for (var i = 0; i < SOCIAL_KINDS.length; i++) {
          pick -= SOCIAL_KINDS[i].weight;
          if (pick <= 0) return SOCIAL_KINDS[i].kind;
        }
        return 'chat';
      }
      function socialDuration(kind) {
        for (var i = 0; i < SOCIAL_KINDS.length; i++) if (SOCIAL_KINDS[i].kind === kind) return SOCIAL_KINDS[i].dur;
        return 2.4;
      }
      function socialIcon(kind, role) {
        if (kind === 'chat') return '💬';
        if (kind === 'duel') return '⚔️';
        if (kind === 'duet') return '🎭';
        if (kind === 'highfive') return '🙌';
        if (kind === 'rps') return ['✊', '✋', '✌️'][Math.floor(Math.random() * 3)];
        if (kind === 'hug') return '🤗';
        if (kind === 'argument') return role === 'lead' ? '💢' : '❗';
        if (kind === 'runaway') return role === 'target' ? '🏃' : '😱';
        if (kind === 'slap') return role === 'lead' ? '🖐️' : '😵';
        if (kind === 'kick') return role === 'lead' ? '🦶' : '💥';
        if (kind === 'spar') return '🥊';
        return '💬';
      }
      function abilityDuration(kind) {
        if (kind === 'speed-blur') return 1.6;
        if (kind === 'flight-burst') return 2.2;
        if (kind === 'solar-flare' || kind === 'storm-call' || kind === 'lightning-shout') return 2.8;
        return 2.0 + Math.random() * 1.2;
      }
      function abilityPower(kind) {
        var table = {
          'solar-flare': 9, 'storm-call': 9, 'lightning-shout': 8, 'repulsor-blast': 7, 'tech-cannon': 7,
          'shadow-glide': 5, 'web-sling': 6, 'arrow-swarm': 6, 'sonic-arrow': 6, 'shield-bounce': 7,
          'arc-shield': 7, 'peace-pulse': 4, 'freeze-field': 7, 'cold-ray': 7, 'tide-wave': 7,
          'waterjet': 7, 'lasso-bind': 8, 'scarab-swarm': 8, 'kinetic-pounce': 7, 'blade-flurry': 7,
          'chaos-slash': 8, 'claw-rush': 8, 'acrobat-strike': 5, 'widow-sting': 6, 'radar-sense': 4,
          'shrink-burst': 5, 'speed-blur': 5, 'flight-burst': 6, 'fate-weave': 8, 'hex-wave': 8,
          'shadow-portal': 8, 'plasma-forge': 8, 'star-burst': 8, 'artillery-barrage': 8, 'burst-wave': 5,
        };
        return table[kind] != null ? table[kind] : 5;
      }
      function startAbility(a, target) {
        if (!a || a.remove || a.departing || a.socialT > 0 || a.abilityT > 0) return false;
        var kind = a.traits && a.traits.ability ? a.traits.ability : 'burst-wave';
        a.abilityKind = kind;
        a.abilityIcon = a.traits && a.traits.abilityIcon ? a.traits.abilityIcon : '✨';
        a.abilityT = abilityDuration(kind);
        a.abilityTarget = target || null;
        a.abilityCooldown = 8 + Math.random() * 12;
        a.chatT = 0;
        a.decideT = Math.max(a.decideT, a.abilityT + 0.4);
        return true;
      }
      function startAbilityForKind(a, kind, target) {
        if (!a || a.remove || a.departing) return false;
        clearSocial(a);
        clearAbility(a);
        clearDuelAfter(a);
        a.abilityKind = kind;
        a.abilityIcon = a.traits && a.traits.abilityIcon ? a.traits.abilityIcon : '✨';
        a.abilityT = abilityDuration(kind);
        a.abilityTarget = target || null;
        a.abilityCooldown = 8 + Math.random() * 6;
        a.chatT = 0;
        a.mode = 'stand';
        a.after = 'stand';
        a.destIcon = a.abilityIcon;
        a.decideT = Math.max(a.abilityT + 0.4, 2);
        return true;
      }
      function instantWorking(a) {
        if (!a || a.remove || a.departing) return false;
        clearSocial(a);
        clearAbility(a);
        clearDuelAfter(a);
        releaseSpot(a);
        a.mode = 'sit';
        a.after = 'sit';
        a.destIcon = '💻';
        a.decideT = 10 + Math.random() * 8;
        return true;
      }
      function instantRelax(a) {
        if (!a || a.remove || a.departing) return false;
        clearSocial(a);
        clearAbility(a);
        clearDuelAfter(a);
        releaseSpot(a);
        a.mode = 'stand';
        a.after = 'stand';
        a.destIcon = '😌';
        a.decideT = 6 + Math.random() * 5;
        return true;
      }
      function startManualDuel(a, b) {
        if (!a || !b || a === b || a.remove || b.remove) return false;
        clearSocial(a);
        clearSocial(b);
        clearAbility(a);
        clearAbility(b);
        clearDuelAfter(a);
        clearDuelAfter(b);
        releaseSpot(a);
        releaseSpot(b);
        var kind = a.traits && a.traits.ability ? a.traits.ability : 'burst-wave';
        var midX = (a.x + b.x) / 2;
        var midZ = (a.z + b.z) / 2;
        a.socialKind = b.socialKind = 'duel';
        a.socialT = b.socialT = 2.8;
        a.socialPartner = b;
        b.socialPartner = a;
        a.socialRole = 'lead';
        b.socialRole = 'target';
        a.socialIcon = a.traits && a.traits.abilityIcon ? a.traits.abilityIcon : socialIcon('duel', 'lead');
        b.socialIcon = b.traits && b.traits.abilityIcon ? b.traits.abilityIcon : socialIcon('duel', 'target');
        a.facing = Math.atan2(b.x - a.x, b.z - a.z);
        b.facing = Math.atan2(a.x - b.x, a.z - b.z);
        a.duelAfterT = b.duelAfterT = 0;
        a.duelAfterRole = 'winner';
        b.duelAfterRole = 'loser';
        a.duelAfterKind = a.traits && a.traits.ability ? a.traits.ability : kind;
        b.duelAfterKind = b.traits && b.traits.ability ? b.traits.ability : kind;
        a.duelAfterX = b.duelAfterX = midX;
        a.duelAfterZ = b.duelAfterZ = midZ;
        a.duelAfterSpawned = false;
        b.duelAfterSpawned = false;
        a.abilityCooldown = 10 + Math.random() * 8;
        b.abilityCooldown = 10 + Math.random() * 8;
        a.decideT = b.decideT = 3.2;
        return true;
      }
      function startManualMode(a, kind) {
        if (!a || a.remove || a.departing) return false;
        clearSocial(a);
        clearAbility(a);
        clearDuelAfter(a);
        clearManual(a);
        a.manualKind = kind;
        a.manualIcon = kind === 'working' ? '💻' : '😌';
        a.manualT = kind === 'working' ? 6.5 : 5.2;
        a.mode = kind === 'working' ? 'sit' : 'stand';
        a.after = a.mode;
        a.destIcon = a.manualIcon;
        a.decideT = Math.max(a.manualT + 0.6, 2);
        return true;
      }
      function canSocialize(a, b) {
        return a && b && a !== b && !a.remove && !b.remove && !a.departing && !b.departing &&
          a.mode === 'stand' && b.mode === 'stand' &&
          a.def.state !== 'asleep' && b.def.state !== 'asleep' &&
          a.socialT <= 0 && b.socialT <= 0 &&
          a.socialCooldown <= 0 && b.socialCooldown <= 0;
      }
      function startSocialPair(a, b) {
        var kind = socialChoice(a, b);
        var dur = socialDuration(kind);
        var aLead = Math.random() < 0.5;
        var aRole = aLead ? 'lead' : 'target';
        var bRole = aLead ? 'target' : 'lead';
        releaseSpot(a);
        releaseSpot(b);
        a.socialKind = b.socialKind = kind;
        a.socialT = b.socialT = dur;
        a.socialPartner = b;
        b.socialPartner = a;
        a.socialRole = aRole;
        b.socialRole = bRole;
        a.socialIcon = kind === 'duel' ? (a.traits && a.traits.abilityIcon) : socialIcon(kind, aRole);
        b.socialIcon = kind === 'duel' ? (b.traits && b.traits.abilityIcon) : socialIcon(kind, bRole);
        a.chatT = b.chatT = 0;
        a.decideT = b.decideT = Math.max(dur + 0.6, 2);
        a.facing = Math.atan2(b.x - a.x, b.z - a.z);
        b.facing = Math.atan2(a.x - b.x, a.z - b.z);
      }
      function socialStepAway(a, from, far) {
        var dx = a.x - from.x, dz = a.z - from.z;
        var d = Math.hypot(dx, dz) || 1;
        var dist = far ? 6.4 : 2.2;
        var p = adjustStandPoint(a.x + dx / d * dist, a.z + dz / d * dist);
        routeTo(a, p.x, p.z);
        a.after = 'stand';
        a.destIcon = far ? '🏃' : '💥';
        a.decideT = far ? 5 : 3;
      }
      function finishSocialPair(a) {
        var b = a.socialPartner;
        var kind = a.socialKind;
        var aRole = a.socialRole;
        var bRole = b && b.socialRole;
        var aKind = a.traits && a.traits.ability;
        var bKind = b && b.traits && b.traits.ability;
        clearSocial(a);
        if (b) clearSocial(b);
        if (!b || b.remove || b.departing) return;
        if (kind === 'runaway') {
          socialStepAway(aRole === 'target' ? a : b, aRole === 'target' ? b : a, true);
        } else if (kind === 'slap' || kind === 'kick') {
          socialStepAway(aRole === 'target' ? a : b, aRole === 'target' ? b : a, false);
        } else if (kind === 'argument' && Math.random() < 0.28) {
          var walker = Math.random() < 0.5 ? a : b;
          socialStepAway(walker, walker === a ? b : a, false);
        } else if (kind === 'spar' && bRole) {
          a.decideT = Math.max(a.decideT, 2);
          b.decideT = Math.max(b.decideT, 2);
        } else if (kind === 'duel') {
          // Pure coin flip: duels should feel unpredictable, not ability-biased.
          var winner = Math.random() < 0.5 ? a : b;
          var loser = winner === a ? b : a;
          var midX = (a.x + b.x) / 2;
          var midZ = (a.z + b.z) / 2;
          winner.duelAfterT = 2.2;
          winner.duelAfterRole = 'winner';
          winner.duelAfterKind = winner.traits && winner.traits.ability;
          winner.duelAfterBeat = 0;
          winner.duelAfterSpawned = false;
          winner.duelAfterX = midX;
          winner.duelAfterZ = midZ;
          loser.duelAfterT = 2.8;
          loser.duelAfterRole = 'loser';
          loser.duelAfterKind = loser.traits && loser.traits.ability;
          loser.duelAfterBeat = 0;
          loser.duelAfterSpawned = true;
          loser.duelAfterX = midX;
          loser.duelAfterZ = midZ;
          if (loser === a) socialStepAway(a, b, false);
          else socialStepAway(b, a, false);
          winner.decideT = Math.max(winner.decideT, 2.5);
          loser.decideT = Math.max(loser.decideT, 3.0);
        }
      }
      function goSpot(a, list) {
        var free = list.filter(function (s) { return !s.busyBy; });
        if (!free.length) return false;
        var s = free[Math.floor(Math.random() * free.length)];
        releaseSpot(a);
        s.busyBy = a;
        a.spot = s;
        routeTo(a, s.x, s.z);
        a.after = 'act';
        a.afterFace = s.face;
        a.destIcon = ACT_ICON[s.type] || '🚶';
        return true;
      }
      function goDesk(a, icon) {
        releaseSpot(a);
        routeTo(a, a.desk.x, a.desk.z + 1.55);
        a.after = 'sit';
        a.destIcon = icon || '💻';
      }
      function goPerch(a) {
        releaseSpot(a);
        a.spot = { x: a.desk.x + 1.9, z: a.desk.z - 0.2, face: Math.atan2(-1.9, 1.75), type: 'perch', sit: true, seatY: 0.42, busyBy: a, reactions: ['perch-chat', 'perch-think', 'perch-point'] }; // perched on the desk edge, turned toward the chair
        routeTo(a, a.spot.x, a.spot.z + 1.2);
        a.after = 'act';
        a.afterFace = a.spot.face;
        a.destIcon = '💬';
      }
      function wanderPoint(room) {
        return { x: room.x0 + 4 + Math.random() * (room.x1 - room.x0 - 8), z: room.z0 + 5 + Math.random() * (room.z1 - room.z0 - 9) };
      }
      function wanderStreetPoint() {
        var pathLen = Math.max(18, D * 0.22);
        var minX = lobbyRoom.cx - 1.5;
        var maxX = lobbyRoom.cx + 1.5;
        var minZ = lobbyRoom.z1 + 1.5;
        var maxZ = lobbyRoom.z1 + pathLen - 2.5;
        return {
          x: minX + Math.random() * (maxX - minX),
          z: minZ + Math.random() * (maxZ - minZ)
        };
      }
      function pickMate(a) {
        var mates = agents.filter(function (b) { return b !== a && b.room === a.room; });
        return mates.length ? mates[Math.floor(Math.random() * mates.length)] : null;
      }
      function goBoard(a) {
        if (!(a.room && a.room.boardSpot && !a.room.boardSpot.busyBy)) return false;
        releaseSpot(a);
        var s = a.room.boardSpot;
        s.busyBy = a; a.spot = s;
        routeTo(a, s.x, s.z);
        a.after = 'act'; a.afterFace = s.face; a.destIcon = '✍️';
        return true;
      }
      // pick(a, [[probability, fn], ...]) — first hit wins; falls through to desk
      function pickPlan(a, plan, deskIcon) {
        var rnd = Math.random(), acc = 0;
        for (var i = 0; i < plan.length; i++) {
          acc += plan[i][0];
          if (rnd < acc && plan[i][1]()) return;
        }
        goDesk(a, deskIcon);
      }
      function decide(a) {
        var st = a.def.state, rnd = Math.random();
        if (st === 'asleep') { a.mode = 'sit'; a.decideT = 6; return; }
        if (st === 'coffee') {
          // brew first, then settle on a stool with the cup
          pickPlan(a, [
            [0.5, function () { return goSpot(a, zones.coffee.filter(function (s) { return s.type === 'brew'; })); }],
            [0.24, function () { return goSpot(a, zones.coffee.filter(function (s) { return s.type === 'stool'; })); }],
            [0.18, function () { return goSpot(a, zones.coffee.filter(function (s) { return s.type === 'snack-shelf'; })); }],
          ], '☕');
          a.decideT = 8 + rnd * 8;
          return;
        }
        if (st === 'blocked') {
          // Blocked agents wander around outside the front door on the street path
          releaseSpot(a);
          var p = wanderStreetPoint();
          routeTo(a, p.x, p.z);
          a.after = 'stand';
          a.destIcon = '❗';
          a.decideT = 5 + rnd * 6;
          return;
        }
        if (st === 'failed') {
          pickPlan(a, [
            [0.3, function () { return goSpot(a, zones.window); }],
            [0.2, function () { var p = wanderPoint(a.room || lobbyRoom); routeTo(a, p.x, p.z); a.after = 'stand'; a.destIcon = '💥'; releaseSpot(a); return true; }],
          ], '💥');
          a.decideT = 5 + rnd * 6;
          return;
        }
        if (st === 'idle') {
          pickPlan(a, [
            [0.22, function () { return goSpot(a, zones.lobby); }],
            [0.18, function () { return goSpot(a, zones.fun); }],
            [0.15, function () { return goSpot(a, zones.watch); }],
            [0.12, function () { return goSpot(a, zones.window); }],
            [0.1, function () { return a.def.lead ? goBoard(a) : goPerch(a); }],
            [0.13, function () { var m = pickMate(a); if (!m) return false; releaseSpot(a); routeTo(a, m.desk.x + 2.4, m.desk.z + 1.8); a.after = 'stand'; a.destIcon = '💬'; return true; }],
          ], '🤔');
          a.decideT = 8 + rnd * 8;
          return;
        }
        // working — mostly typing, with believable breaks at real assets
        if (rnd < 0.56) { goDesk(a, '💻'); a.decideT = 11 + rnd * 16; return; }
        pickPlan(a, [
          [0.22, function () { return goSpot(a, zones.coffee.filter(function (s) { return s.type === 'brew'; })); }],
          [0.16, function () { return goSpot(a, zones.cooler); }],
          [0.14, function () { return goSpot(a, zones.fun.filter(function (s) { return s.type === 'arcade' || s.type === 'pool' || s.type === 'design-table' || s.type === 'jukebox'; })); }],
          [0.12, function () { return goSpot(a, zones.watch); }],
          [0.1, function () { return goSpot(a, zones.window); }],
          [0.1, function () { return goPerch(a); }],
          [0.16, function () { var m = pickMate(a); if (!m) return false; releaseSpot(a); routeTo(a, m.desk.x + 2.4, m.desk.z + 1.8); a.after = 'stand'; a.destIcon = '💬'; return true; }],
        ], '💻');
        a.decideT = 6 + rnd * 5;
      }
      function step(a, dt) {
        a.decideT -= dt;
        a.chatT -= dt;
        if (a.socialCooldown > 0) a.socialCooldown -= dt;
        if (a.abilityCooldown > 0) a.abilityCooldown -= dt;
        if (a.manualT > 0) {
          a.manualT -= dt;
          if (a.manualT <= 0) clearManual(a);
          return;
        }
        if (a.duelAfterT > 0) {
          a.duelAfterT -= dt;
          if (a.duelAfterT <= 0) clearDuelAfter(a);
          return;
        }
        if (a.departing) {
          a.departT -= dt;
          if (a.departT <= 0) { a.remove = true; return; } // never got there — leave anyway
        }
        if (a.abilityT > 0) {
          a.abilityT -= dt;
          if (a.abilityT <= 0) clearAbility(a);
          return;
        }
        if (a.socialT > 0) {
          a.socialT -= dt;
          if (a.socialPartner && !a.socialPartner.remove) a.facing = Math.atan2(a.socialPartner.x - a.x, a.socialPartner.z - a.z);
          if (a.socialT <= 0) finishSocialPair(a);
          return;
        }
        if (a.mode === 'walk') {
          var t = a.path[0];
          if (!t) {
            a.mode = a.after || 'stand'; a.walkPhase = 0;
            if (a.mode === 'depart') { a.remove = true; return; } // reached the exit
            if (a.mode === 'sit') { releaseSpot(a); a.x = a.desk.x; a.z = a.desk.z + 1.55; a.facing = Math.PI; }
            else if (a.afterFace != null) { a.facing = a.afterFace; a.afterFace = null; }
            if (a.mode === 'act' && a.spot && (a.spot.sit || a.spot.type === 'seat')) { a.x = a.spot.x; a.z = a.spot.z; }
            // reset the dwell clock ON ARRIVAL — decideT was set when the trip was chosen,
            // so a long walk used to leave near-zero time at the asset (visit-and-leave)
            if (a.mode === 'act' && a.spot) { a.reaction = pickReaction(a.spot); a.decideT = dwellFor(a.spot.type); }
            else if (a.mode === 'stand') a.decideT = Math.max(a.decideT, 6 + Math.random() * 5);
            return;
          }
          if (a.walkPauseT > 0) { a.walkPauseT -= dt; return; }
          a.walkT = (a.walkT || 0) + dt;
          var dx = t.x - a.x, dz = t.z - a.z, d = Math.hypot(dx, dz);
          var style = a.walkStyle || { cruise: 1 };
          var startEase = smooth01(a.walkT / 0.75);
          var arrivalEase = smooth01(d / 3.4);
          var moodPace = a.def.state === 'failed' ? 0.82 : (a.def.state === 'blocked' ? 0.92 : 1);
          var crowdBrake = 1;
          for (var wi = 0; wi < agents.length; wi++) {
            var other = agents[wi];
            if (other === a || other.remove) continue;
            var od = Math.hypot(other.x - a.x, other.z - a.z);
            if (od > 0 && od < 2.1) crowdBrake = Math.min(crowdBrake, 0.68 + od * 0.12);
          }
          var fuzzyPace = (0.42 + startEase * 0.58) * (0.52 + arrivalEase * 0.48) * style.cruise * moodPace * crowdBrake;
          var sd = Math.max(0.35, a.speed * fuzzyPace) * dt;
          if (d <= sd) { a.x = t.x; a.z = t.z; a.path.shift(); }
          else {
            var nx = dx / d, nz = dz / d;
            var nextX = a.x + nx * sd;
            var nextZ = a.z + nz * sd;
            if (!walkableSpace(nextX, nextZ, t)) {
              var finalTarget = a.path[a.path.length - 1] || t;
              routeTo(a, finalTarget.x, finalTarget.z);
              return;
            }
            a.x = nextX; a.z = nextZ; a.facing = Math.atan2(dx, dz); a.walkPhase += dt * (8.3 + fuzzyPace * 2.4);
          }
          return;
        }
        if (a.decideT <= 0 && !reduced) decide(a);
        if (a.mode !== 'walk' && a.socialT <= 0 && a.abilityT <= 0 && a.manualT <= 0 && a.duelAfterT <= 0 && a.abilityCooldown <= 0 && a.chatT <= 0 && Math.random() < dt * 0.22) {
          if (startAbility(a)) return;
        }
        // two officers standing close = a paired social beat
        if (a.mode === 'stand' && a.chatT <= 0 && a.socialCooldown <= 0 && Math.random() < dt * 0.42) {
          for (var i = 0; i < agents.length; i++) {
            var b = agents[i];
            if (canSocialize(a, b) && Math.hypot(b.x - a.x, b.z - a.z) < 4.2) {
              startSocialPair(a, b);
              break;
            }
          }
        }
      }

      var zzzs = [];
      function syncZzz(a) {
        var has = zzzs.some(function (sp) { return sp.userData.a === a; });
        if (a.def.state === 'asleep' && !has) {
          for (var i = 0; i < 3; i++) {
            var sp = textSprite('z', { fs: 40, scale: 0.02, bg: false, color: '#B9C2D9' });
            sp.userData = { a: a, off: i / 3 };
            scene.add(sp);
            zzzs.push(sp);
          }
        } else if (a.def.state !== 'asleep' && has) {
          zzzs = zzzs.filter(function (sp) {
            if (sp.userData.a !== a) return true;
            scene.remove(sp);
            sp.material.dispose();
            return false;
          });
        }
      }
      agents.forEach(syncZzz);

      // Initially line up the agents on the street path and route them to their desks
      if (!reduced) {
        agents.forEach(function (a) {
          routeTo(a, a.desk.x, a.desk.z + 1.55);
          a.after = 'sit';
          a.destIcon = '💼';
        });
      }
