      // ---- ground / lot --------------------------------------------------------------
      var groundW = Math.max(W + 56, 150), groundD = Math.max(D + 50, 116);
      var ground = new THREE.Mesh(new THREE.PlaneGeometry(groundW, groundD), texMat(tiledTex(TEX.grass, groundW / 3, groundD / 3)));
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);

      // cobblestone entrance path from the lobby's south door + a signpost
      var pathLen = Math.max(18, D * 0.22);
      var path = tiledBox(4.6, 0.12, pathLen, TEX.cobble);
      path.position.set(lobbyRoom.cx, 0.06, D / 2 + pathLen / 2);
      scene.add(path);
      var mat0 = texBox(6.4, 0.08, 2.6, TEX.planks); mat0.position.set(lobbyRoom.cx, 0.1, D / 2 + 1.6); scene.add(mat0);
      var mailbox = new THREE.Group(); // oak signpost by the path
      var mpost = texBox(0.35, 2.6, 0.35, TEX.bark); mpost.position.y = 1.3; mailbox.add(mpost);
      var mbox = texBox(1.9, 1.0, 0.2, TEX.planks); mbox.position.y = 2.9; mailbox.add(mbox);
      mailbox.position.set(lobbyRoom.cx + 4.0, 0, D / 2 + pathLen - 2);
      mailbox.rotation.y = Math.PI;
      scene.add(mailbox);

      var trees = [];
      for (var ti = 0; ti < 16; ti++) {
        var tg = new THREE.Group();
        // voxel oak: bark-cube trunk stack + a blocky leaf canopy
        var th = 3 + Math.floor(seeded() * 2);
        for (var tb = 0; tb < th; tb++) {
          var seg = texBox(1.0, 1.0, 1.0, TEX.bark);
          seg.position.y = 0.5 + tb;
          tg.add(seg);
        }
        var canopy = texBox(3.0, 1.0, 3.0, TEX.leaves); canopy.position.y = th + 0.5; tg.add(canopy);
        var canopy2 = texBox(2.0, 1.0, 2.0, TEX.leaves); canopy2.position.y = th + 1.5; tg.add(canopy2);
        var cap = texBox(1.0, 1.0, 1.0, TEX.leaves); cap.position.y = th + 2.5; tg.add(cap);
        var ang = seeded() * Math.PI * 2, rad = Math.max(W, D) * (0.58 + seeded() * 0.22);
        var tx = Math.cos(ang) * rad, tz = Math.sin(ang) * rad * 0.62;
        if (Math.abs(tx) < W / 2 + 9 && Math.abs(tz) < D / 2 + 9) { tx += (tx < 0 ? -1 : 1) * (W / 2 + 14); }
        tg.position.set(tx, 0, tz);
        tg.userData.phase = seeded() * Math.PI * 2;
        trees.push(tg);
        scene.add(tg);
      }

      // ---- house -----------------------------------------------------------------------
      var house = new THREE.Group();
      scene.add(house);
      var glassMats = [], bulbMats = [], roomLights = [];

      var corrFloor = tiledBox(W, 0.2, CORR, TEX.stone);
      corrFloor.position.set(0, 0.1, 0);
      house.add(corrFloor);
      // corridor runner carpet (red wool)
      if (DEC.rugs !== false) {
        var runner = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.05, 2.2), texMat(tiledTex(TEX.wool(themeValue('world.runner', 0xA43535)), 28, 1)));
        runner.position.set(0, 0.23, 0);
        house.add(runner);
      }

      // interior partition: dark-plank base course + plank wall above
      function innerWall(x0, x1, zOrX, alongX, accent) {
        if (Math.abs(x1 - x0) < 0.05) return;
        var len = Math.abs(x1 - x0), mid = (x0 + x1) / 2;
        var lower = tiledBox(alongX ? len : WT, 0.9, alongX ? WT : len, TEX.darkPlanks, 1);
        lower.position.set(alongX ? mid : zOrX, 0.45, alongX ? zOrX : mid);
        house.add(lower);
        var upper = tiledBox(alongX ? len : WT * 0.8, IWH - 0.9, alongX ? WT * 0.8 : len, TEX.planks, 1.2);
        upper.position.set(alongX ? mid : zOrX, 0.9 + (IWH - 0.9) / 2, alongX ? zOrX : mid);
        house.add(upper);
      }

      // per-room wool floor tint keyed to the template's dept floors, common rooms on planks
      var woolFloorTex = {};
      function floorTexFor(hex) {
        if (!woolFloorTex[hex]) woolFloorTex[hex] = TEX.wool(hex);
        return woolFloorTex[hex];
      }
      rooms.forEach(function (r, ri) {
        var fl;
        if (r.kind === 'coffee' || r.kind === 'lobby' || r.kind === 'fun') {
          fl = tiledBox(r.x1 - r.x0, 0.2, r.z1 - r.z0, TEX.planks);
        } else {
          var floorColor = r.kind === 'dept' ? DEPT_FLOORS[ri % DEPT_FLOORS.length] : DEPT_FLOORS[(ri + 2) % DEPT_FLOORS.length];
          fl = tiledBox(r.x1 - r.x0, 0.2, r.z1 - r.z0, floorTexFor(floorColor));
        }
        fl.position.set(r.cx, 0.1, r.cz);
        fl.receiveShadow = true;
        house.add(fl);
        var accent = ACCENTS[ri % ACCENTS.length];
        // corridor-side wall with door gap
        var wz = r.isNorth ? r.z1 : r.z0;
        var g = 3.4;
        innerWall(r.x0, r.door.x - g, wz, true, accent);
        innerWall(r.door.x + g, r.x1, wz, true, accent);
        // side partitions
        innerWall(r.z0, r.z1, r.x0, false, accent);
        innerWall(r.z0, r.z1, r.x1, false, accent);
        r.accent = accent;
      });
      // corridor end caps
      innerWall(-CORR / 2, CORR / 2, W / 2, false, null);
      innerWall(-CORR / 2, CORR / 2, -W / 2, false, null);

      // ---- perimeter walls with windows + paintings, Sims auto-cutaway -----------------
      function makeArtCanvas(seedN) {
        // 16×12 pixel painting, rendered blocky via NearestFilter on the texture
        var rnd = mulberry(seedN);
        var cv = document.createElement('canvas');
        cv.width = 16; cv.height = 12;
        var cx = cv.getContext('2d');
        cx.fillStyle = '#c8b590';
        cx.fillRect(0, 0, 16, 12);
        var cols = themeArray('world.paintingColors', ['#3aafa9', '#b1508c', '#5b9e3c', '#c8963c', '#7b5bc8', '#c85b5b']);
        for (var i = 0; i < 4 + Math.floor(rnd() * 3); i++) {
          cx.fillStyle = cols[Math.floor(rnd() * cols.length)];
          cx.fillRect(Math.floor(rnd() * 12), Math.floor(rnd() * 9), 2 + Math.floor(rnd() * 4), 2 + Math.floor(rnd() * 3));
        }
        return cv;
      }
      function artTexture(seedN) {
        var tex = new THREE.CanvasTexture(makeArtCanvas(seedN));
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        return tex;
      }
      var perim = [
        { n: { x: 0, z: -1 }, group: new THREE.Group(), mats: [] },  // north
        { n: { x: 0, z: 1 }, group: new THREE.Group(), mats: [] },   // south
        { n: { x: 1, z: 0 }, group: new THREE.Group(), mats: [] },   // east
        { n: { x: -1, z: 0 }, group: new THREE.Group(), mats: [] },  // west
      ];
      perim.forEach(function (p) { scene.add(p.group); });
      function pMat(color, opts) {
        var m = lam(color, opts);
        m.transparent = true;
        return m;
      }
      function addTo(p, mesh) { p.group.add(mesh); mesh.material.transparent = true; p.mats.push(mesh.material); }

      function outerWallSeg(p, x0, x1, fixed, alongX) {
        if (Math.abs(x1 - x0) < 0.05) return;
        var len = Math.abs(x1 - x0), mid = (x0 + x1) / 2;
        var m = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : WT + 0.2, OWH, alongX ? WT + 0.2 : len),
          texMat(tiledTex(TEX.stoneBrick, len / 1.2, OWH / 1.2), { transparent: true }));
        m.position.set(alongX ? mid : fixed, OWH / 2, alongX ? fixed : mid);
        m.castShadow = true; m.receiveShadow = true;
        addTo(p, m);
      }
      function windowAt(p, x, z, alongX) {
        if (DEC.windows === false) return;
        var frame = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 2.6 : WT + 0.4, 1.7, alongX ? WT + 0.4 : 2.6),
          texMat(tiledTex(TEX.planks, 2, 2), { transparent: true }));
        frame.position.set(x, 2.2, z);
        addTo(p, frame);
        var glass = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 2.1 : WT + 0.5, 1.25, alongX ? WT + 0.5 : 2.1),
          pMat(themeValue('world.windowGlass', 0x9cc4d8), { emissive: 0x000000 }));
        glass.position.set(x, 2.2, z);
        addTo(p, glass);
        glassMats.push(glass.material);
        // a gaze spot just inside the window — officers come to look at the weather
        zones.window.push({
          x: x - p.n.x * 2.2, z: z - p.n.z * 2.2,
          face: Math.atan2(p.n.x, p.n.z), type: 'window', sit: false, busyBy: null,
          reactions: ['window-gaze', 'window-stretch', 'window-weather'],
        });
      }
      function paintingAt(p, x, z, facing, seedN) {
        var art = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.5),
          new THREE.MeshLambertMaterial({ map: artTexture(seedN), transparent: true }));
        var fr = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.8, 0.08), pMat(0x6b563a));
        fr.position.set(x, 2.15, z);
        fr.rotation.y = facing;
        addTo(p, fr);
        art.position.set(x + Math.sin(facing) * 0.06, 2.15, z + Math.cos(facing) * 0.06);
        art.rotation.y = facing;
        p.group.add(art);
        p.mats.push(art.material);
      }
      // north wall: solid + a window and paintings per north room
      outerWallSeg(perim[0], -W / 2, W / 2, -D / 2, true);
      rooms.filter(function (r) { return r.isNorth; }).forEach(function (r, i) {
        windowAt(perim[0], r.cx, -D / 2, true);
        var nP = Math.max(0, DEC.paintingsPerRoom != null ? DEC.paintingsPerRoom : 2);
        for (var k = 0; k < Math.min(nP, 2); k++) {
          paintingAt(perim[0], r.cx + (k === 0 ? -4.5 : 4.5), -D / 2 + WT + 0.12, 0, hash(r.id) + k * 7);
        }
      });
      // south wall: gap at the lobby entrance
      outerWallSeg(perim[1], -W / 2, lobbyRoom.cx - 2.8, D / 2, true);
      outerWallSeg(perim[1], lobbyRoom.cx + 2.8, W / 2, D / 2, true);
      rooms.filter(function (r) { return !r.isNorth; }).forEach(function (r, i) {
        if (Math.abs(r.cx - lobbyRoom.cx) > 4) windowAt(perim[1], r.cx, D / 2, true);
        var nP = Math.max(0, DEC.paintingsPerRoom != null ? DEC.paintingsPerRoom : 2);
        for (var k = 0; k < Math.min(nP, 2); k++) {
          var px = r.cx + (k === 0 ? -4.5 : 4.5);
          if (Math.abs(px - lobbyRoom.cx) < 4.4) continue; // keep the doorway clear
          paintingAt(perim[1], px, D / 2 - WT - 0.12, Math.PI, hash(r.id) + 31 + k * 7);
        }
      });
      // east + west walls with two windows each
      outerWallSeg(perim[2], -D / 2, D / 2, W / 2, false);
      windowAt(perim[2], W / 2, -D / 4, false);
      windowAt(perim[2], W / 2, D / 4, false);
      outerWallSeg(perim[3], -D / 2, D / 2, -W / 2, false);
      windowAt(perim[3], -W / 2, -D / 4, false);
      windowAt(perim[3], -W / 2, D / 4, false);

      function updateCutaway() {
        var cx2 = camera.position.x, cz2 = camera.position.z;
        var len = Math.hypot(cx2, cz2) || 1;
        var dx = cx2 / len, dz = cz2 / len;
        perim.forEach(function (p) {
          var dot = dx * p.n.x + dz * p.n.z;
          var wantO = dot > 0.18 ? 0.10 : 1;
          p.mats.forEach(function (m) {
            m.opacity += (wantO - m.opacity) * 0.16;
            m.depthWrite = m.opacity > 0.5;
          });
        });
      }
