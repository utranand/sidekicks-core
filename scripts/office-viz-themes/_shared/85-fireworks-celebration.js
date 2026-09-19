      // ---- completion fireworks --------------------------------------------------------------
      var fireworks = [];
      var FIREWORK_COLORS = [0xff4f5e, 0xffb000, 0x3fa873, 0x4e92d1, 0xc77dff, 0xffffff];

      function fireworkMat(color, opacity) {
        return new THREE.MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: opacity,
          depthWrite: false,
        });
      }

      function launchFirework(a, delay, color) {
        var g = new THREE.Group();
        var start = new THREE.Vector3(a.x, 3.2 + Math.random() * 0.8, a.z);
        var burst = new THREE.Vector3(
          a.x + (Math.random() - 0.5) * 9,
          7.0 + Math.random() * 4.5,
          a.z - 5.5 - Math.random() * 7.5
        );
        var rocket = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), fireworkMat(color, 1));
        var glow = new THREE.PointLight(color, 0, 9);
        g.add(rocket);
        g.add(glow);
        scene.add(g);
        fireworks.push({
          kind: 'rocket',
          group: g,
          rocket: rocket,
          glow: glow,
          start: start,
          burst: burst,
          color: color,
          age: -delay,
          life: 0.68 + Math.random() * 0.26,
        });
      }

      function burstFirework(fw) {
        var g = new THREE.Group();
        var pieces = [];
        var geo = new THREE.SphereGeometry(0.09, 6, 6);
        for (var i = 0; i < 34; i++) {
          var color = FIREWORK_COLORS[(i + Math.floor(Math.random() * FIREWORK_COLORS.length)) % FIREWORK_COLORS.length];
          var p = new THREE.Mesh(geo, fireworkMat(color, 1));
          var theta = Math.random() * Math.PI * 2;
          var y = -0.35 + Math.random() * 1.55;
          var r = 2.2 + Math.random() * 4.0;
          p.userData.vx = Math.sin(theta) * r;
          p.userData.vy = y * r + 1.3;
          p.userData.vz = Math.cos(theta) * r;
          p.userData.spin = (Math.random() - 0.5) * 8;
          g.add(p);
          pieces.push(p);
        }
        g.position.copy(fw.burst);
        scene.add(g);
        fireworks.push({ kind: 'burst', group: g, pieces: pieces, age: 0, life: 1.65 });
      }

      function disposeFirework(fw) {
        scene.remove(fw.group);
        fw.group.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
      }

      function launchCompletionFireworks(a) {
        if (reduced || !a || a.celebrated) return;
        a.celebrated = true;
        for (var i = 0; i < 5; i++) {
          launchFirework(a, i * 0.16, FIREWORK_COLORS[(i + hash(a.def.id)) % FIREWORK_COLORS.length]);
        }
      }

      function stepFireworks(dt) {
        if (!fireworks.length) return;
        var keep = [];
        for (var i = 0; i < fireworks.length; i++) {
          var fw = fireworks[i];
          fw.age += dt;
          if (fw.age < 0) { keep.push(fw); continue; }
          if (fw.kind === 'rocket') {
            var k = Math.min(1, fw.age / fw.life);
            var ease = 1 - Math.pow(1 - k, 3);
            fw.group.position.lerpVectors(fw.start, fw.burst, ease);
            fw.rocket.material.opacity = 1 - k * 0.35;
            fw.rocket.scale.setScalar(1 + k * 1.6);
            fw.glow.intensity = Math.sin(k * Math.PI) * 2.2;
            if (k >= 1) {
              burstFirework(fw);
              disposeFirework(fw);
            } else {
              keep.push(fw);
            }
          } else {
            var b = Math.min(1, fw.age / fw.life);
            for (var pi = 0; pi < fw.pieces.length; pi++) {
              var p = fw.pieces[pi];
              p.position.x = p.userData.vx * fw.age;
              p.position.y = p.userData.vy * fw.age - 3.6 * fw.age * fw.age;
              p.position.z = p.userData.vz * fw.age;
              p.rotation.x += p.userData.spin * dt;
              p.rotation.y += p.userData.spin * dt * 0.7;
              p.material.opacity = 1 - b;
              p.scale.setScalar(Math.max(0.2, 1 - b * 0.75));
            }
            if (b >= 1) disposeFirework(fw);
            else keep.push(fw);
          }
        }
        fireworks = keep;
      }
