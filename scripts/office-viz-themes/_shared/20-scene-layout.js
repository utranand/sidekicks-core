      // ---- scene / lights ----------------------------------------------------------
      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 700);

      var hemi = new THREE.HemisphereLight(themeValue('scene.hemiSky', 0xcfe4f4), themeValue('scene.hemiGround', 0x6a7a62), themeValue('scene.hemiIntensity', 0.75));
      scene.add(hemi);
      var sun = new THREE.DirectionalLight(0xffffff, 1.0);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -120; sun.shadow.camera.right = 120;
      sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
      sun.shadow.camera.far = 500;
      scene.add(sun);
      scene.add(sun.target);
      scene.fog = new THREE.Fog(themeValue('scene.fog', 0x78a7ff), 190, 520);

      // square sun + moon billboards — the Minecraft sky
      var sunSquare = new THREE.Mesh(new THREE.PlaneGeometry(34, 34),
        new THREE.MeshBasicMaterial({ color: themeValue('scene.sunSquare', 0xfff6b0), fog: false, transparent: true, opacity: 0.95 }));
      scene.add(sunSquare);
      var moonSquare = new THREE.Mesh(new THREE.PlaneGeometry(24, 24),
        new THREE.MeshBasicMaterial({ color: themeValue('scene.moonSquare', 0xd8dcee), fog: false, transparent: true, opacity: 0 }));
      scene.add(moonSquare);

      // ---- world layout (rooms from the CONFIG TEMPLATE; desks from DATA.agents) ------
      var FOOTPRINT_SCALE = BLD.footprintScale != null ? BLD.footprintScale : 0.68;
      var W = Math.max(84, (BLD.width || 150) * FOOTPRINT_SCALE);
      var D = Math.max(64, (BLD.depth || 112) * FOOTPRINT_SCALE);
      var CORR = Math.max(6.2, (BLD.corridor || 10) * Math.max(0.62, FOOTPRINT_SCALE));
      var IWH = BLD.innerWallHeight || 1.7, OWH = BLD.outerWallHeight || 3.6, WT = 0.5;
      var rooms = [], agents = [], deskByAgent = {}, furnitureObjects = [];
      var allVisualDecorations = [];
      // interaction spots on assets: {x,z,assetX,assetZ,face,type,sit,seatY,busyBy,mat?,reactions?} —
      // officers claim one, walk to its asset-owned pose point, and PERFORM the activity there.
      var zones = { coffee: [], fun: [], lobby: [], meeting: [], cooler: [], watch: [], window: [] };
      var lobbyRoom = null;

      function deskSlotPosition(room, slotIndex) {
        var roomW = room.x1 - room.x0, roomD = room.z1 - room.z0;
        var padX = Math.min(6.4, Math.max(1.2, roomW * 0.24));
        var padN = Math.min(7.2, Math.max(1.2, roomD * 0.28));
        var padS = Math.min(5.4, Math.max(1.2, roomD * 0.22));
        var minX = room.x0 + padX, maxX = room.x1 - padX;
        var minZ = room.z0 + padN, maxZ = room.z1 - padS;
        var centerX = room.cx;
        if (minX > maxX) minX = maxX = centerX;
        if (minZ > maxZ) minZ = maxZ = room.cz;
        var centerZ = (minZ + maxZ) / 2;
        var stepX = 4.6, stepZ = 3.2;
        var slots = [];

        function addSlot(rx, rz) {
          var x = centerX + rx * stepX;
          var z = centerZ + rz * stepZ;
          if (x < minX || x > maxX || z < minZ || z > maxZ) return;
          slots.push({ x: x, z: z, rx: rx, rz: rz, dist: Math.hypot(rx, rz) });
        }

        for (var ring = 0; slots.length <= slotIndex && ring < 24; ring++) {
          for (var rz = -ring; rz <= ring; rz++) {
            for (var rx = -ring; rx <= ring; rx++) {
              if (Math.max(Math.abs(rx), Math.abs(rz)) !== ring) continue;
              addSlot(rx, rz);
            }
          }
          slots.sort(function (a, b) {
            return a.dist - b.dist || Math.abs(a.rz) - Math.abs(b.rz) || a.rx - b.rx || a.rz - b.rz;
          });
        }

        if (slots[slotIndex]) return { x: slots[slotIndex].x, z: slots[slotIndex].z };

        var perRow = Math.max(1, Math.floor((maxX - minX) / stepX) + 1);
        var row = Math.floor(slotIndex / perRow);
        var col = slotIndex % perRow;
        var rowOffset = row === 0 ? 0 : (row % 2 ? Math.ceil(row / 2) : -row / 2);
        return {
          x: Math.max(minX, Math.min(maxX, centerX + (col - (perRow - 1) / 2) * stepX)),
          z: Math.max(minZ, Math.min(maxZ, centerZ + rowOffset * stepZ)),
        };
      }

      function layout() {
        var agentsByDept = {};
        DATA.agents.forEach(function (a) { (agentsByDept[a.dept] = agentsByDept[a.dept] || []).push(a); });
        // north band: departments (from the template, auto-covering every live dept)
        var north = (CFG.deptRooms || []).filter(function (r) { return !r || r.display !== false; }).map(function (r) {
          return { id: 'dept:' + r.dept, kind: 'dept', label: r.label || r.dept, agents: agentsByDept[r.dept] || [], weight: Math.max(3, (agentsByDept[r.dept] || []).length + 2) };
        });
        // south band: common rooms from the template
        var south = (CFG.commonRooms || []).map(function (r) {
          return { id: r.id || r.kind, kind: r.kind || 'lobby', label: r.label || r.kind, agents: [], weight: r.weight || 5 };
        });

        function place(row, z0, depth, isNorth) {
          var wsum = row.reduce(function (s, r) { return s + r.weight; }, 0) || 1;
          var x = -W / 2;
          row.forEach(function (r) {
            var w = W * r.weight / wsum;
            var room = {
              id: r.id, kind: r.kind, label: r.label, x0: x, x1: x + w, z0: z0, z1: z0 + depth,
              isNorth: isNorth, agentsDef: r.agents, desks: [], furniture: [],
              door: { x: x + w / 2, zIn: isNorth ? z0 + depth - 2 : z0 + 2 },
              cx: x + w / 2, cz: z0 + depth / 2,
            };
            rooms.push(room);
            if (r.kind === 'lobby') lobbyRoom = room;
            x += w;
          });
        }
        place(north, -D / 2, D / 2 - CORR / 2, true);
        place(south, CORR / 2, D / 2 - CORR / 2, false);

        rooms.forEach(function (room) {
          if (room.kind !== 'dept') return;
          var n = room.agentsDef.length;
          if (!n) return;
          room.agentsDef.forEach(function (aDef, i) {
            var pos = deskSlotPosition(room, i);
            var desk = { x: pos.x, z: pos.z, agentId: aDef.id, state: aDef.state };
            room.desks.push(desk);
            deskByAgent[aDef.id] = desk;
          });
          room.board = { x: room.x0 + 4.4, z: room.isNorth ? room.z1 - 5.6 : room.z0 + 6.0 };
        });
        if (!lobbyRoom) lobbyRoom = rooms.filter(function (r) { return !r.isNorth; })[0] || rooms[0];
      }
      layout();
