      // ---- animate officers ----------------------------------------------------------------
      function syncPlumbobState(a) {
        var hex = STATE_HEX[a.def.state] || 0x9aa0a4;
        if (a.plumbob.userData.stateHex === hex) return;
        a.plumbob.userData.stateHex = hex;
        a.plumbob.material.color.setHex(hex);
        if (a.plumbob.material.emissive) a.plumbob.material.emissive.setHex(hex);
      }

      function abilityHash(kind) {
        var h = 2166136261;
        var s = String(kind || 'burst-wave');
        for (var i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
        }
        return h >>> 0;
      }

      function mixHex(a, b, t) {
        var ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
        var br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
        var r = Math.round(ar + (br - ar) * t);
        var g = Math.round(ag + (bg - ag) * t);
        var bl = Math.round(ab + (bb - ab) * t);
        return (r << 16) | (g << 8) | bl;
      }

      function abilityEffectSpec(kind, a) {
        var h = abilityHash(kind);
        var accent = a && a.traits && a.traits.accent ? a.traits.accent : 0xffffff;
        var primary = a && a.traits && a.traits.primary ? a.traits.primary : accent;
        var secondary = a && a.traits && a.traits.secondary ? a.traits.secondary : accent;
        var modes = ['flare', 'beam', 'shield', 'slash', 'swirl', 'pulse', 'shard', 'stream', 'spark', 'vortex'];
        var mode = modes[h % modes.length];
        return {
          mode: mode,
          color: mixHex(accent, 0xffffff, 0.08 + ((h >>> 3) & 7) / 40),
          altColor: mixHex(primary, secondary, 0.28 + ((h >>> 6) & 7) / 18),
          count: 7 + (h % 7),
          radius: 0.66 + ((h >>> 5) % 7) * 0.09,
          thickness: 0.03 + ((h >>> 2) % 4) * 0.01,
          segments: 10 + (h % 5) * 2,
          spin: 1.45 + ((h >>> 8) % 11) * 0.18,
          tilt: (((h >>> 12) % 9) - 4) * 0.055,
          pulse: 0.1 + ((h >>> 14) % 7) * 0.03,
          lift: 0.15 + ((h >>> 17) % 7) * 0.06,
          drift: (((h >>> 20) % 9) - 4) * 0.015,
          wobble: 1.1 + ((h >>> 23) % 5) * 0.32,
          wobbleAmt: 0.018 + ((h >>> 25) % 5) * 0.01,
          coreSize: 0.07 + ((h >>> 27) % 5) * 0.012,
          spread: 0.06 + ((h >>> 9) % 7) * 0.02,
          beamWidth: 0.18 + ((h >>> 15) % 5) * 0.05,
          lean: (((h >>> 10) % 7) - 3) * 0.015,
          reach: 0.14 + ((h >>> 18) % 7) * 0.025,
          twist: (((h >>> 21) % 7) - 3) * 0.02,
          flare: 0.1 + ((h >>> 24) % 7) * 0.02,
          scale: 1.0 + ((h >>> 28) % 5) * 0.03,
          speed: 0.9 + ((h >>> 13) % 7) * 0.12,
        };
      }

      function removeAbilityFx(a) {
        if (!a || !a.abilityFx) return;
        var fx = a.abilityFx;
        a.abilityFx = null;
        a.abilityFxSpec = null;
        a.abilityFxCore = null;
        a.abilityFxRing = null;
        a.abilityFxHalo = null;
        a.abilityFxParts = null;
        if (fx.parent) fx.parent.remove(fx);
        fx.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
          }
        });
      }

      function ensureAbilityFx(a, kind) {
        var spec = abilityEffectSpec(kind, a);
        if (!a.abilityFx || a.abilityFx.userData.kind !== kind) {
          removeAbilityFx(a);
          var fx = new THREE.Group();
          fx.userData.kind = kind;
          fx.userData.spec = spec;

          // Pick a random transition style for this summon
          var styles = ['default-front', 'forward-angle', 'overhead', 'giant', 'multi-summon', 'floor-splash', 'orbit-spin'];
          var style = styles[Math.floor(Math.random() * styles.length)];
          fx.userData.transitionStyle = style;

          var ringMat = new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity: 0.9, fog: false });
          var altMat = new THREE.MeshBasicMaterial({ color: spec.altColor, transparent: true, opacity: 0.85, fog: false });

          var pGeo;
          if (spec.mode === 'beam' || spec.mode === 'stream') {
            pGeo = new THREE.BoxGeometry(0.08, 0.22, 0.08);
          } else if (spec.mode === 'slash' || spec.mode === 'shield') {
            pGeo = new THREE.BoxGeometry(0.16, 0.05, 0.34);
          } else if (spec.mode === 'shard') {
            pGeo = new THREE.BoxGeometry(0.08, 0.18, 0.26);
          } else {
            pGeo = new THREE.SphereGeometry(0.05, 6, 6);
          }

          var parts = [];
          var cores = [];
          var rings = [];
          var halos = [];

          function addSubFx(parentGroup, offsetX, offsetY, offsetZ, scaleVal) {
            var sub = new THREE.Group();
            sub.position.set(offsetX, offsetY, offsetZ);
            sub.scale.setScalar(scaleVal);

            var ring = new THREE.Mesh(new THREE.TorusGeometry(spec.radius, spec.thickness, 4, Math.max(10, spec.segments)), ringMat);
            ring.rotation.x = spec.tilt;
            sub.add(ring);
            rings.push(ring);

            var halo = new THREE.Mesh(new THREE.TorusGeometry(spec.radius * 0.68, Math.max(0.018, spec.thickness * 0.7), 4, Math.max(8, spec.segments - 2)), altMat);
            halo.rotation.y = Math.PI / 2;
            halo.rotation.z = spec.twist;
            sub.add(halo);
            halos.push(halo);

            var core = new THREE.Mesh(new THREE.SphereGeometry(spec.coreSize, 8, 8), ringMat.clone());
            core.position.y = spec.lift;
            sub.add(core);
            cores.push(core);

            for (var i = 0; i < spec.count; i++) {
              var p = new THREE.Mesh(pGeo.clone(), new THREE.MeshBasicMaterial({
                color: i % 2 ? spec.altColor : spec.color,
                transparent: true,
                opacity: 0.95,
                fog: false,
              }));
              p.userData.phase = i / spec.count;
              p.userData.spin = 0.9 + (i % 5) * 0.12;
              sub.add(p);
              parts.push(p);
            }

            parentGroup.add(sub);
          }

          if (style === 'multi-summon') {
            addSubFx(fx, 0, 0, 1.4, 0.7);
            addSubFx(fx, -1.2, -0.2, 0.8, 0.6);
            addSubFx(fx, 1.2, -0.2, 0.8, 0.6);
          } else {
            addSubFx(fx, 0, 0, 0, 1.0);
          }

          a.group.add(fx);
          a.abilityFx = fx;
          a.abilityFxCore = cores[0];
          a.abilityFxRing = rings[0];
          a.abilityFxHalo = halos[0];
          a.abilityFxParts = parts;

          fx.userData.rings = rings;
          fx.userData.halos = halos;
          fx.userData.cores = cores;
        }
        a.abilityFxSpec = spec;
        return spec;
      }

      function updateAbilityFx(a, kind, beat, duelMode) {
        if (!a || !a.abilityFx) return;
        var fx = a.abilityFx;
        var spec = fx.userData.spec || abilityEffectSpec(kind, a);
        var style = fx.userData.transitionStyle || 'default-front';
        var pulse = 1 + Math.max(0, beat) * spec.pulse;

        if (style === 'overhead') {
          fx.position.set(0, 3.4 + Math.sin(simClock * 3.5) * 0.15, 0);
          fx.scale.setScalar(spec.scale * pulse * 0.95);
        } else if (style === 'giant') {
          fx.position.set(0, spec.lift + 1.2, 1.5);
          fx.scale.setScalar(spec.scale * pulse * 2.3);
        } else if (style === 'forward-angle') {
          var angleX = Math.sin(simClock * 2.2) * 0.35;
          var angleY = Math.cos(simClock * 2.2) * 0.25;
          var dist = 1.1 + Math.max(0, beat) * 1.4;
          fx.position.set(angleX * dist, spec.lift + 0.9 + angleY * dist, dist);
          fx.scale.setScalar(spec.scale * pulse);
        } else if (style === 'floor-splash') {
          var progress = (beat + 1) / 2;
          var height = 3.2 - progress * 3.1;
          var splashScale = progress > 0.65 ? 1.0 + (progress - 0.65) * 3.6 : 1.0;
          fx.position.set(0, Math.max(spec.lift, height), 1.1);
          fx.scale.setScalar(spec.scale * pulse * splashScale);
        } else if (style === 'orbit-spin') {
          var angle = simClock * 3.8 + a.x;
          fx.position.set(Math.sin(angle) * 1.5, spec.lift + 0.8, Math.cos(angle) * 1.5);
          fx.scale.setScalar(spec.scale * pulse * 0.85);
        } else if (style === 'multi-summon') {
          fx.position.set(0, spec.lift + 0.6, 0);
          fx.scale.setScalar(spec.scale * pulse);
        } else {
          fx.position.set(0, spec.lift + 0.9, 1.2);
          fx.scale.setScalar(spec.scale * pulse);
        }

        fx.rotation.y = simClock * spec.spin + spec.drift;
        fx.rotation.x = spec.tilt + Math.sin(simClock * spec.wobble) * spec.wobbleAmt;

        var rings = fx.userData.rings || [fx.userData.ring];
        var halos = fx.userData.halos || [fx.userData.halo];
        var cores = fx.userData.cores || [fx.userData.core];

        rings.forEach(function (ring) {
          if (ring) ring.rotation.z = simClock * (spec.spin * 0.25) + beat * spec.flare;
        });
        halos.forEach(function (halo) {
          if (halo) halo.rotation.z = -simClock * (spec.spin * 0.18);
        });
        cores.forEach(function (core) {
          if (core) {
            core.position.y = spec.lift + Math.sin(simClock * spec.wobble * 1.3) * spec.flare;
            core.scale.setScalar(0.82 + pulse * 0.32);
          }
        });

        var parts = a.abilityFxParts || [];
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          var phase = p.userData.phase || 0;
          var t = simClock * spec.speed + phase * Math.PI * 2;
          var side = phase < 0.5 ? -1 : 1;
          if (spec.mode === 'beam') {
            p.position.set((phase - 0.5) * (spec.beamWidth * 3.2), spec.lift + Math.sin(t) * 0.07, 0.14 + Math.cos(t) * 0.12);
            p.rotation.z = t;
          } else if (spec.mode === 'stream') {
            p.position.set(side * (0.18 + phase * 0.46), spec.lift + Math.sin(t * 1.3) * 0.06, Math.cos(t) * 0.08);
            p.rotation.y = t;
          } else if (spec.mode === 'shield') {
            p.position.set(Math.cos(t) * spec.radius, spec.lift + Math.sin(t * 2) * 0.05, Math.sin(t) * spec.radius);
            p.rotation.z = t * 0.5;
          } else if (spec.mode === 'slash') {
            p.position.set(Math.sin(t) * spec.radius, spec.lift + (phase - 0.5) * 0.26, Math.cos(t) * 0.16);
            p.rotation.z = t * 1.6;
          } else if (spec.mode === 'shard') {
            p.position.set(Math.cos(t) * spec.radius, spec.lift + Math.sin(t * 1.8) * 0.12, Math.sin(t) * spec.radius);
            p.rotation.x = t * 0.7;
            p.rotation.y = t * 0.9;
          } else if (spec.mode === 'vortex') {
            var rr = spec.radius * (0.5 + phase * 0.8);
            p.position.set(Math.cos(t) * rr, spec.lift + phase * 0.42 + Math.sin(t * 1.8) * 0.08, Math.sin(t) * rr);
            p.rotation.y = t * 1.2;
          } else {
            var orbit = spec.radius + Math.sin(t * 1.2) * spec.spread;
            p.position.set(Math.cos(t) * orbit, spec.lift + Math.sin(t * 1.7) * (0.12 + spec.reach), Math.sin(t) * orbit);
            p.rotation.x = t * 0.5;
            p.rotation.y = t * 0.8;
          }
          p.scale.setScalar(0.72 + pulse * 0.36 + (duelMode ? 0.04 : 0));
          p.material.opacity = 0.48 + pulse * 0.34;
        }
      }

      function applyDuelPose(a, beat) {
        var mirrored = a.socialRole === 'lead' ? 1 : -1;
        var pulse = Math.max(0, beat);
        a.bodyG.rotation.x = 0.12 + pulse * 0.06;
        a.bodyG.rotation.y = mirrored * 0.1;
        a.bodyG.rotation.z = mirrored * 0.08;
        a.group.position.x += mirrored * 0.08 + pulse * 0.02;
        a.group.position.z += -0.08 + pulse * 0.01;
        a.armL.rotation.x = -0.6 + pulse * 0.1;
        a.armR.rotation.x = -0.6 - pulse * 0.1;
        a.head.rotation.x = 0.06;
        a.head.rotation.z = mirrored * 0.02;
      }

      var duelBursts = [];
      function spawnDuelBurst(a) {
        if (reduced || !a || a.duelAfterSpawned || a.duelAfterRole !== 'winner') return;
        var kind = a.duelAfterKind || (a.traits && a.traits.ability) || 'burst-wave';
        var color = a.traits && a.traits.accent ? a.traits.accent : 0xffffff;
        var g = new THREE.Group();
        var pieces = [];
        var geo = new THREE.SphereGeometry(0.07, 6, 6);
        var light = new THREE.PointLight(color, 0, 14);
        g.position.set(a.duelAfterX || a.x, 2.3, a.duelAfterZ || a.z);
        g.add(light);
        for (var i = 0; i < 14; i++) {
          var p = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 1, fog: false }));
          var theta = Math.PI * 2 * i / 14;
          var radius = kind === 'speed-blur' || kind === 'flight-burst' ? 0.6 : 0.82;
          p.userData.vx = Math.cos(theta) * (2.4 + Math.random() * 1.8);
          p.userData.vy = 0.8 + Math.random() * 2.4;
          p.userData.vz = Math.sin(theta) * (2.4 + Math.random() * 1.8);
          p.userData.spin = (Math.random() - 0.5) * 10;
          p.position.set(Math.cos(theta) * radius, Math.sin(theta * 2) * 0.14, Math.sin(theta) * radius);
          g.add(p);
          pieces.push(p);
        }
        scene.add(g);
        duelBursts.push({ group: g, light: light, pieces: pieces, age: 0, life: 0.95 });
        a.duelAfterSpawned = true;
      }

      function stepDuelBursts(dt) {
        if (!duelBursts.length) return;
        var keep = [];
        for (var i = 0; i < duelBursts.length; i++) {
          var fw = duelBursts[i];
          fw.age += dt;
          var k = Math.min(1, fw.age / fw.life);
          var ease = 1 - Math.pow(1 - k, 2);
          fw.light.intensity = (1 - k) * 4.5;
          fw.group.scale.setScalar(0.9 + ease * 1.8);
          fw.group.rotation.y += dt * 3;
          for (var pi = 0; pi < fw.pieces.length; pi++) {
            var p = fw.pieces[pi];
            p.position.x = p.userData.vx * fw.age;
            p.position.y = p.userData.vy * fw.age - 2.2 * fw.age * fw.age;
            p.position.z = p.userData.vz * fw.age;
            p.rotation.x += p.userData.spin * dt;
            p.rotation.y += p.userData.spin * dt * 0.7;
            p.material.opacity = 1 - k;
            p.scale.setScalar(Math.max(0.15, 1 - k * 0.8));
          }
          if (k >= 1) {
            scene.remove(fw.group);
            fw.group.traverse(function (o) {
              if (o.geometry) o.geometry.dispose();
              if (o.material) o.material.dispose();
            });
          } else keep.push(fw);
        }
        duelBursts = keep;
      }

      function applyAbilityPose(a, ability, beat, duelMode) {
        var spec = abilityEffectSpec(ability, a);
        var mirrored = a.socialRole === 'lead' ? 1 : -1;
        var aimArm = mirrored > 0 ? 'armR' : 'armL';
        var offArm = aimArm === 'armR' ? 'armL' : 'armR';
        var pulse = Math.max(0, beat);
        a.bodyG.rotation.y = duelMode ? mirrored * (0.12 + spec.twist) : 0;
        if (ability === 'speed-blur' || ability === 'flight-burst') {
          a.group.position.y += spec.lift + (duelMode ? pulse * 0.04 : pulse * 0.12);
          a.group.position.x += mirrored * pulse * (0.025 + spec.reach);
          a.legL.rotation.x = pulse * 0.35;
          a.legR.rotation.x = -pulse * 0.35;
          a.armL.rotation.x = -0.15 + pulse * (0.14 + spec.lean);
          a.armR.rotation.x = -0.15 - pulse * (0.14 + spec.lean);
          a.bodyG.rotation.x = -0.02 + pulse * (0.03 + spec.flare);
          a.bodyG.rotation.z = mirrored * pulse * (0.04 + spec.twist);
          a.head.rotation.x = -0.04;
        } else if (/^(solar-flare|storm-call|lightning-shout|hex-wave|fate-weave|shadow-portal|plasma-forge|star-burst)$/.test(ability)) {
          a.bodyG.rotation.x = 0.16 + pulse * (0.06 + spec.lean);
          a.bodyG.rotation.z = mirrored * pulse * (0.1 + spec.twist);
          a.armL.rotation.x = -1.5 + pulse * (0.16 + spec.reach);
          a.armR.rotation.x = -1.5 - pulse * (0.16 + spec.reach);
          a.head.rotation.z = mirrored * pulse * 0.04;
          a.head.rotation.x = 0.12 + spec.flare * 0.3;
        } else if (/^(repulsor-blast|web-sling|arrow-swarm|sonic-arrow|artillery-barrage|tech-cannon)$/.test(ability)) {
          a.bodyG.rotation.x = 0.08 + pulse * (0.05 + spec.lean);
          a.bodyG.rotation.z = mirrored * (0.06 + spec.twist);
          a[aimArm].rotation.x = -1.7 - pulse * (0.5 + spec.reach);
          a[aimArm].rotation.z = mirrored * 0.1;
          a[offArm].rotation.x = -0.35 - spec.flare * 0.2;
          a.head.rotation.x = -0.08;
        } else if (/^(shield-bounce|arc-shield|peace-pulse|freeze-field|cold-ray|tide-wave|waterjet|lasso-bind|scarab-swarm)$/.test(ability)) {
          a.bodyG.rotation.x = 0.1 + pulse * (0.04 + spec.lean);
          a.bodyG.rotation.z = mirrored * (-0.1 + spec.twist);
          a.armL.rotation.x = -1.05 + pulse * (0.06 + spec.reach);
          a.armR.rotation.x = -1.05 - pulse * (0.06 + spec.reach);
          a.armL.rotation.z = mirrored * 0.08;
          a.armR.rotation.z = mirrored * -0.08;
          a.head.rotation.x = 0.04 + spec.flare * 0.2;
        } else if (/^(kinetic-pounce|blade-flurry|chaos-slash|claw-rush|acrobat-strike|widow-sting)$/.test(ability)) {
          a.bodyG.rotation.x = -0.1 + pulse * (0.05 + spec.lean);
          a.bodyG.rotation.z = mirrored * (0.12 + spec.twist);
          a.armL.rotation.x = -1.3 + pulse * (0.1 + spec.reach);
          a.armR.rotation.x = -1.3 - pulse * (0.1 + spec.reach);
          a.head.rotation.x = -0.02;
          a.legR.rotation.x = -0.45 + pulse * (0.12 + spec.flare);
          a.legL.rotation.x = 0.35 - pulse * (0.06 + spec.flare * 0.5);
        } else if (ability === 'radar-sense') {
          a.bodyG.rotation.x = 0.04 + spec.lean;
          a.bodyG.rotation.z = mirrored * (0.03 + spec.twist);
          a.armL.rotation.x = -0.2;
          a.armR.rotation.x = -0.2;
          a.head.rotation.x = 0.26 + spec.flare * 0.2;
        } else if (ability === 'shrink-burst') {
          a.bodyG.rotation.x = 0.18 + spec.lean;
          a.bodyG.rotation.z = mirrored * (0.08 + spec.twist);
          a.armL.rotation.x = -1.0 + pulse * (0.08 + spec.reach);
          a.armR.rotation.x = -1.0 - pulse * (0.08 + spec.reach);
          a.head.rotation.x = 0.08;
          a.group.scale.setScalar((duelMode ? 0.92 : 0.84 + pulse * 0.04) * spec.scale);
        } else {
          a.bodyG.rotation.x = 0.08 + pulse * (0.04 + spec.lean);
          a.bodyG.rotation.z = mirrored * pulse * (0.03 + spec.twist);
          a.armL.rotation.x = -0.6 + pulse * (0.06 + spec.reach);
          a.armR.rotation.x = -0.6 - pulse * (0.06 + spec.reach);
          a.head.rotation.x = 0.04;
        }
      }

      function applyDuelAfterPose(a, dt) {
        var role = a.duelAfterRole;
        var kind = a.duelAfterKind || (a.traits && a.traits.ability);
        var beat = Math.sin(simClock * 4.5 + a.x);
        var mirrored = a.socialRole === 'lead' ? 1 : -1;
        if (role === 'winner') {
          a.bodyG.rotation.x = 0.24;
          a.bodyG.rotation.y = mirrored * 0.08;
          a.bodyG.rotation.z = mirrored * 0.08;
          a.group.position.x += mirrored * 0.12 + beat * 0.03;
          a.group.position.z += -0.14 + beat * 0.02;
          a.armL.rotation.x = -0.25 + beat * 0.12;
          a.armR.rotation.x = -0.25 - beat * 0.12;
          a.armL.rotation.z = mirrored * -0.05;
          a.armR.rotation.z = mirrored * 0.05;
          a.head.rotation.x = -0.14;
          a.head.rotation.z = mirrored * 0.03;
          a.plumbob.scale.setScalar(1.85 + Math.max(0, beat) * 0.3);
          a.thought.scale.set(2.15 + Math.max(0, beat) * 0.2, 1.88 + Math.max(0, beat) * 0.18, 1);
          if (kind === 'speed-blur' || kind === 'flight-burst') a.group.position.y += Math.max(0, beat) * 0.08;
        } else if (role === 'loser') {
          a.bodyG.rotation.x = -0.36;
          a.bodyG.rotation.y = mirrored * -0.06;
          a.bodyG.rotation.z = mirrored * -0.18;
          a.group.position.x += mirrored * -0.18 - beat * 0.05;
          a.group.position.z += 0.18 - beat * 0.02;
          a.armL.rotation.x = -1.8 + Math.max(0, beat) * 0.08;
          a.armR.rotation.x = -1.8 - Math.max(0, beat) * 0.08;
          a.armL.rotation.z = mirrored * 0.08;
          a.armR.rotation.z = mirrored * -0.08;
          a.head.rotation.x = 0.34;
          a.head.rotation.z = mirrored * -0.06;
          a.plumbob.scale.setScalar(0.92 - Math.max(0, -beat) * 0.08);
          a.thought.scale.set(1.65, 1.44, 1);
          a.group.position.y += Math.max(0, -beat) * 0.06;
        }
      }

      function animateOfficer(a, dt) {
        a.group.position.set(a.x, 0.2, a.z);
        a.group.rotation.y = a.facing;
        syncPlumbobState(a);
        var acting = a.mode === 'act' && a.spot;
        var actType = acting ? a.spot.type : null;
        var reaction = acting ? (a.reaction || actType) : null;
        var manualKind = a.manualT > 0 ? a.manualKind : null;
        var abilityKind = a.abilityT > 0 ? a.abilityKind : null;
        var socialKind = a.socialT > 0 ? a.socialKind : null;
        var partner = a.socialPartner && !a.socialPartner.remove ? a.socialPartner : null;
        var spotSits = acting && (a.spot.sit || actType === 'seat');
        var sitting = a.mode === 'sit' || a.mode === 'sit-couch' || spotSits;
        var sitBase = a.mode === 'sit' ? 0.55 : -0.45;
        var sitY = acting && a.spot.seatY != null ? a.spot.seatY : sitBase;
        var sitClearance = 0.12;
        a.legL.visible = true;
        a.legR.visible = true;
        a.group.position.y = sitting ? sitY + sitClearance : 0.2;
        a.bodyG.rotation.x = 0;
        a.bodyG.rotation.y = 0;
        a.bodyG.rotation.z = 0;
        a.head.rotation.z = 0;
        a.armL.rotation.z = 0;
        a.armR.rotation.z = 0;
        a.legL.rotation.z = 0;
        a.legR.rotation.z = 0;
        a.group.scale.setScalar(1);
        if (a.duelAfterT > 0 && !reduced) {
          applyDuelAfterPose(a, dt);
        } else if (abilityKind && !reduced) {
          var abilityBeat = Math.sin(simClock * 7 + a.x + (a.socialRole === 'lead' ? 0 : Math.PI * 0.5));
          ensureAbilityFx(a, abilityKind);
          updateAbilityFx(a, abilityKind, abilityBeat, false);
          applyAbilityPose(a, abilityKind, abilityBeat, false);
        } else if (socialKind && !reduced) {
          var socialBeat = Math.sin(simClock * 6 + a.x + (a.socialRole === 'lead' ? 0 : Math.PI * 0.5));
          var mirrored = a.socialRole === 'lead' ? 1 : -1;
          var pairOpen = partner ? 0.08 : 0;
          a.legL.rotation.x = 0;
          a.legR.rotation.x = 0;
          if (socialKind === 'chat') {
            a.bodyG.rotation.x = 0.04 + pairOpen;
            a.bodyG.rotation.y = mirrored * 0.08;
            a.armR.rotation.x = -0.72 + socialBeat * 0.18 * mirrored;
            a.armL.rotation.x = -0.38 - socialBeat * 0.08 * mirrored;
            a.head.rotation.x = 0.04;
          } else if (socialKind === 'duel') {
            applyDuelPose(a, socialBeat);
            a.head.rotation.y = mirrored * 0.08;
          } else if (socialKind === 'duet') {
            a.bodyG.rotation.x = 0.1 + pairOpen;
            a.bodyG.rotation.y = mirrored * 0.14;
            a.armL.rotation.x = -1.0 + socialBeat * 0.22 * mirrored;
            a.armR.rotation.x = -1.0 - socialBeat * 0.22 * mirrored;
            a.head.rotation.x = 0.08 + socialBeat * 0.03;
          } else if (socialKind === 'argument') {
            a.bodyG.rotation.x = 0.08 + Math.max(0, socialBeat) * 0.05;
            a.bodyG.rotation.y = mirrored * 0.1;
            a.armR.rotation.x = a.socialRole === 'lead' ? -1.35 + socialBeat * 0.18 : -0.9 + socialBeat * 0.1;
            a.armL.rotation.x = a.socialRole === 'lead' ? -0.55 : -1.0 + socialBeat * 0.12;
            a.head.rotation.x = -0.08;
          } else if (socialKind === 'rps') {
            var throwBeat = Math.max(0, Math.sin(simClock * 5.4 + a.x));
            var throwArm = a.socialRole === 'lead' ? 'armR' : 'armL';
            var settleArm = throwArm === 'armR' ? 'armL' : 'armR';
            a[throwArm].rotation.x = -0.75 - throwBeat * 0.65;
            a[settleArm].rotation.x = -0.2;
            a.head.rotation.x = 0.02;
          } else if (socialKind === 'slap') {
            if (a.socialRole === 'lead') {
              a.armR.rotation.x = -0.55 - Math.max(0, socialBeat) * 1.2;
              a.armL.rotation.x = -0.2;
            } else {
              a.bodyG.rotation.x = -0.18;
              a.head.rotation.x = 0.24;
              a.armL.rotation.x = -0.5;
              a.armR.rotation.x = -0.5;
            }
          } else if (socialKind === 'kick') {
            if (a.socialRole === 'lead') {
              a.legR.rotation.x = -0.95 + Math.sin(simClock * 8) * 0.12;
              a.armL.rotation.x = -0.7;
              a.armR.rotation.x = -0.7;
            } else {
              a.bodyG.rotation.x = -0.22;
              a.armL.rotation.x = -1.25;
              a.armR.rotation.x = -0.75;
            }
          } else if (socialKind === 'runaway') {
            if (a.socialRole === 'target') {
              a.armL.rotation.x = -1.65 + socialBeat * 0.16;
              a.armR.rotation.x = -1.65 - socialBeat * 0.16;
              a.bodyG.rotation.x = -0.12;
            } else {
              a.armR.rotation.x = -1.15;
              a.armL.rotation.x = -0.3;
              a.head.rotation.x = -0.06;
            }
          } else if (socialKind === 'hug') {
            a.bodyG.rotation.x = 0.14 + pairOpen;
            a.bodyG.rotation.y = mirrored * 0.06;
            a.armL.rotation.x = -1.45;
            a.armR.rotation.x = -1.45;
            a.head.rotation.x = 0.08;
          } else if (socialKind === 'highfive') {
            var highBeat = Math.sin(simClock * 9 + a.x + (a.socialRole === 'lead' ? 0 : Math.PI / 2));
            var highArm = a.socialRole === 'lead' ? 'armR' : 'armL';
            var lowArm = highArm === 'armR' ? 'armL' : 'armR';
            a[highArm].rotation.x = -2.25 + highBeat * 0.08;
            a[lowArm].rotation.x = -0.35;
            a.bodyG.rotation.x = 0.05 + pairOpen;
            a.bodyG.rotation.y = mirrored * 0.08;
          } else if (socialKind === 'spar') {
            a.armL.rotation.x = -1.15 + socialBeat * 0.16 * mirrored;
            a.armR.rotation.x = -1.15 - socialBeat * 0.16 * mirrored;
            a.bodyG.rotation.x = 0.08 + Math.sin(simClock * 4 + a.z) * 0.05;
            a.head.rotation.x = -0.04;
          }
        } else if (a.mode === 'walk' && !reduced) {
          var sw = Math.sin(a.walkPhase);
          a.legL.rotation.x = sw * 0.65;
          a.legR.rotation.x = -sw * 0.65;
          a.armL.rotation.x = -sw * 0.4;
          a.armR.rotation.x = sw * 0.4;
          a.group.position.y = 0.2 + Math.abs(Math.sin(a.walkPhase * 2)) * 0.06;
        } else if (sitting && a.def.state === 'working' && a.mode === 'sit' && !reduced) {
          var t = Math.sin(simClock * 15 + a.x);
          a.armL.rotation.x = -0.9 + t * 0.12;
          a.armR.rotation.x = -0.9 - t * 0.12;
        } else if (acting && !reduced) {
          // per-asset activity poses
          if (reaction === 'brew-press' || (!a.reaction && actType === 'brew')) {
            var press = Math.max(0, Math.sin(simClock * 2.2 + a.x));
            a.armR.rotation.x = -1.1 - press * 0.35;   // pressing the machine button
            a.armL.rotation.x += (0 - a.armL.rotation.x) * dt * 5;
          } else if (reaction === 'brew-steam') {
            a.bodyG.rotation.x = 0.12;
            a.armL.rotation.x = -0.75;
            a.armR.rotation.x = -0.95;
            a.head.rotation.x = -0.12;
          } else if (reaction === 'brew-sniff') {
            a.bodyG.rotation.x = 0.18;
            a.armL.rotation.x = -0.35;
            a.armR.rotation.x = -0.35;
            a.head.rotation.x = 0.18;
          } else if (reaction === 'drink-sip' || reaction === 'stool-sip' || (!a.reaction && (actType === 'drinkwater' || actType === 'stool'))) {
            var sip = Math.sin(simClock * 1.2 + a.z) > 0.6 ? 1 : 0;
            a.armR.rotation.x = sip ? -2.1 : -1.0;     // raising the cup
            a.armL.rotation.x = 0;
          } else if (reaction === 'drink-refill' || reaction === 'drink-shake') {
            var shake = Math.sin(simClock * 8 + a.z) * 0.18;
            a.armR.rotation.x = -1.45 + shake;
            a.armL.rotation.x = -0.9 - shake;
          } else if (reaction === 'stool-chat') {
            a.armR.rotation.x = -0.7 + Math.sin(simClock * 3 + a.x) * 0.18;
            a.armL.rotation.x = -0.2;
            a.head.rotation.x = 0.05;
          } else if (reaction === 'stool-snack') {
            a.armR.rotation.x = -1.85;
            a.armL.rotation.x = -0.65;
          } else if (reaction === 'arcade-mash' || (!a.reaction && actType === 'arcade')) {
            var j = Math.sin(simClock * 18 + a.x);
            a.armL.rotation.x = -1.25 + j * 0.12;      // mashing buttons
            a.armR.rotation.x = -1.25 - j * 0.12;
          } else if (reaction === 'arcade-lean') {
            a.bodyG.rotation.x = 0.22;
            a.armL.rotation.x = -1.0;
            a.armR.rotation.x = -1.05;
          } else if (reaction === 'arcade-cheer') {
            a.armL.rotation.x = -2.45 + Math.sin(simClock * 8) * 0.1;
            a.armR.rotation.x = -2.45 - Math.sin(simClock * 8) * 0.1;
          } else if (reaction === 'pool-aim' || (!a.reaction && actType === 'pool')) {
            a.bodyG.rotation.x = 0.3;                  // leaning over the table
            var shot = Math.max(0, Math.sin(simClock * 1.4 + a.x));
            a.armR.rotation.x = -1.2 - shot * 0.5;     // cue thrust
            a.armL.rotation.x = -1.0;
          } else if (reaction === 'pool-chalk') {
            a.armL.rotation.x = -1.25 + Math.sin(simClock * 7) * 0.08;
            a.armR.rotation.x = -1.25 - Math.sin(simClock * 7) * 0.08;
          } else if (reaction === 'pool-celebrate') {
            a.armL.rotation.x = -2.15;
            a.armR.rotation.x = -0.55 + Math.sin(simClock * 5) * 0.2;
          } else if (reaction === 'jukebox-pick') {
            a.armR.rotation.x = -1.35 + Math.sin(simClock * 3 + a.x) * 0.1;
            a.armL.rotation.x = -0.35;
            a.head.rotation.x = -0.08;
          } else if (reaction === 'jukebox-dance' || reaction === 'jukebox-bop' || reaction === 'jukebox-airdrum') {
            var groove = Math.sin(simClock * 7 + a.x);
            a.bodyG.rotation.x = Math.sin(simClock * 4 + a.z) * 0.08;
            a.armL.rotation.x = reaction === 'jukebox-airdrum' ? -1.55 + groove * 0.28 : -0.8 + groove * 0.35;
            a.armR.rotation.x = reaction === 'jukebox-airdrum' ? -1.55 - groove * 0.28 : -0.8 - groove * 0.35;
          } else if (reaction === 'board-write' || (!a.reaction && actType === 'board')) {
            var wr = Math.sin(simClock * 3.5 + a.x);
            a.armR.rotation.x = -1.9 + wr * 0.15;      // writing on the whiteboard
            a.armL.rotation.x = 0;
          } else if (reaction === 'board-point') {
            a.armR.rotation.x = -1.45;
            a.armL.rotation.x = -0.2;
            a.head.rotation.x = -0.08;
          } else if (reaction === 'board-erase') {
            a.armR.rotation.x = -1.75 + Math.sin(simClock * 8 + a.x) * 0.25;
            a.armL.rotation.x = -0.5;
          } else if (reaction === 'watch-nod' || reaction === 'meet-nod' || (!a.reaction && (actType === 'watch' || actType === 'meet'))) {
            var nod = Math.sin(simClock * 0.9 + a.x);
            a.head.rotation.x = 0.08 + Math.max(0, nod) * 0.08;  // attentive nodding
            a.armL.rotation.x = 0; a.armR.rotation.x = 0;
          } else if (reaction === 'watch-clap') {
            var clap = Math.sin(simClock * 9 + a.x);
            a.armL.rotation.x = -1.25 + clap * 0.12;
            a.armR.rotation.x = -1.25 - clap * 0.12;
          } else if (reaction === 'watch-note' || reaction === 'meet-note') {
            a.head.rotation.x = 0.18;
            a.armL.rotation.x = -0.65;
            a.armR.rotation.x = -1.55 + Math.sin(simClock * 5) * 0.12;
          } else if (reaction === 'meet-point' || reaction === 'perch-point' || reaction === 'shelf-point' || reaction === 'table-point') {
            a.armR.rotation.x = -1.2;
            a.armL.rotation.x = -0.35;
            a.head.rotation.x = -0.06;
          } else if (reaction === 'desk-type' || (!a.reaction && actType === 'focus-desk')) {
            var typeTap = Math.sin(simClock * 13 + a.x);
            a.head.rotation.x = 0.1;
            a.armL.rotation.x = -1.0 + typeTap * 0.1;
            a.armR.rotation.x = -1.0 - typeTap * 0.1;
          } else if (reaction === 'desk-review') {
            a.head.rotation.x = -0.08 + Math.sin(simClock * 1.6 + a.x) * 0.04;
            a.armL.rotation.x = -0.25;
            a.armR.rotation.x = -0.35;
          } else if (reaction === 'desk-doodle') {
            a.head.rotation.x = 0.16;
            a.armR.rotation.x = -1.65 + Math.sin(simClock * 6) * 0.12;
            a.armL.rotation.x = -0.55;
          } else if (reaction === 'desk-stand') {
            a.bodyG.rotation.x = -0.05;
            a.armL.rotation.x = -0.3;
            a.armR.rotation.x = -0.3;
          } else if (reaction === 'table-sketch' || (!a.reaction && actType === 'design-table')) {
            a.head.rotation.x = 0.18;
            a.armR.rotation.x = -1.6 + Math.sin(simClock * 5.5 + a.x) * 0.16;
            a.armL.rotation.x = -0.7;
          } else if (reaction === 'table-build') {
            a.bodyG.rotation.x = 0.16;
            a.armL.rotation.x = -1.15 + Math.sin(simClock * 4) * 0.12;
            a.armR.rotation.x = -1.15 - Math.sin(simClock * 4) * 0.12;
          } else if (reaction === 'table-photo') {
            a.head.rotation.x = -0.06;
            a.armL.rotation.x = -1.15;
            a.armR.rotation.x = -1.15;
          } else if (reaction === 'table-dice') {
            a.armR.rotation.x = -1.35 + Math.max(0, Math.sin(simClock * 4 + a.z)) * 0.45;
            a.armL.rotation.x = -0.3;
          } else if (reaction === 'table-highfive') {
            a.armR.rotation.x = -2.25 + Math.sin(simClock * 8) * 0.08;
            a.armL.rotation.x = -0.55;
          } else if (reaction === 'sofa-relax' || reaction === 'bean-lounge' || reaction === 'lounge-read' || (!a.reaction && actType === 'lounge')) {
            a.bodyG.rotation.x = -0.12;
            a.armL.rotation.x = reaction === 'lounge-read' ? -0.8 : -0.25;
            a.armR.rotation.x = reaction === 'lounge-read' ? -0.8 : -0.25;
            a.head.rotation.x = reaction === 'lounge-read' ? 0.16 : 0;
          } else if (reaction === 'sofa-phone' || reaction === 'bean-phone' || reaction === 'lounge-scroll') {
            a.head.rotation.x = 0.22;
            a.armR.rotation.x = -1.75;
            a.armL.rotation.x = -0.4;
          } else if (reaction === 'lounge-nap') {
            a.bodyG.rotation.x = -0.25;
            a.head.rotation.x = 0.35;
            a.armL.rotation.x = -0.15;
            a.armR.rotation.x = -0.15;
          } else if (reaction === 'sofa-stretch' || reaction === 'window-stretch') {
            a.armL.rotation.x = -2.35 + Math.sin(simClock * 2) * 0.08;
            a.armR.rotation.x = -2.35 - Math.sin(simClock * 2) * 0.08;
          } else if (reaction === 'bean-think' || reaction === 'perch-think' || reaction === 'stand-think') {
            a.head.rotation.x = 0.12;
            a.armR.rotation.x = -0.85;
            a.armL.rotation.x = -0.2;
          } else if (reaction === 'lounge-wave' || reaction === 'stand-wave') {
            a.armR.rotation.x = -2.0 + Math.sin(simClock * 6 + a.x) * 0.24;
            a.armL.rotation.x = -0.2;
          } else if (reaction === 'shelf-browse' || (!a.reaction && actType === 'shelf')) {
            a.head.rotation.x = -0.08 + Math.sin(simClock * 1.5 + a.x) * 0.04;
            a.armL.rotation.x = -0.35;
            a.armR.rotation.x = -0.35;
          } else if (reaction === 'shelf-pick') {
            a.armR.rotation.x = -1.45 + Math.sin(simClock * 2.4 + a.x) * 0.16;
            a.armL.rotation.x = -0.55;
          } else if (reaction === 'shelf-tidy') {
            var tidy = Math.sin(simClock * 5 + a.z);
            a.armL.rotation.x = -1.15 + tidy * 0.14;
            a.armR.rotation.x = -1.15 - tidy * 0.14;
          } else if (reaction === 'plant-water' || (!a.reaction && actType === 'plant')) {
            a.bodyG.rotation.x = 0.12;
            a.armR.rotation.x = -1.55 + Math.sin(simClock * 3) * 0.1;
            a.armL.rotation.x = -0.45;
          } else if (reaction === 'plant-prune') {
            a.bodyG.rotation.x = 0.16;
            a.armL.rotation.x = -1.2 + Math.sin(simClock * 8) * 0.12;
            a.armR.rotation.x = -1.2 - Math.sin(simClock * 8) * 0.12;
          } else if (reaction === 'plant-smell') {
            a.bodyG.rotation.x = 0.22;
            a.head.rotation.x = 0.18;
            a.armL.rotation.x = -0.25;
            a.armR.rotation.x = -0.25;
          } else if (reaction === 'snack-pick' || (!a.reaction && actType === 'snack-shelf')) {
            a.armR.rotation.x = -1.45 + Math.sin(simClock * 3) * 0.12;
            a.armL.rotation.x = -0.3;
          } else if (reaction === 'snack-share') {
            a.armR.rotation.x = -1.1;
            a.armL.rotation.x = -0.55;
            a.head.rotation.x = -0.04;
          } else if (reaction === 'snack-crunch') {
            a.armR.rotation.x = -1.95;
            a.armL.rotation.x = -0.45;
            a.head.rotation.x = 0.1 + Math.sin(simClock * 9) * 0.03;
          } else if (reaction === 'window-gaze' || reaction === 'window-weather' || reaction === 'stand-scan') {
            a.head.rotation.x = -0.12 + Math.sin(simClock * 1.4 + a.x) * 0.04;
            a.armL.rotation.x = 0;
            a.armR.rotation.x = 0;
          } else if (reaction === 'perch-chat') {
            a.armR.rotation.x = -0.85 + Math.sin(simClock * 3) * 0.2;
            a.armL.rotation.x = -0.25;
          } else {
            a.armL.rotation.x += (0 - a.armL.rotation.x) * dt * 5;
            a.armR.rotation.x += (0 - a.armR.rotation.x) * dt * 5;
          }
        } else if (!reduced) {
          a.armL.rotation.x += (0 - a.armL.rotation.x) * dt * 5;
          a.armR.rotation.x += (0 - a.armR.rotation.x) * dt * 5;
          a.legL.rotation.x = 0; a.legR.rotation.x = 0;
        }
        if (sitting) {
          var legForward = a.def.state === 'working' ? -1.58 : -1.48;
          a.legL.rotation.x = legForward;
          a.legR.rotation.x = legForward;
        }
        if (manualKind && !reduced) {
          var manualBeat = Math.sin(simClock * 4 + a.x);
          if (manualKind === 'working') {
            a.bodyG.rotation.x = 0.02;
            a.head.rotation.x = 0.08;
            a.armL.rotation.x = -1.0 + manualBeat * 0.08;
            a.armR.rotation.x = -1.0 - manualBeat * 0.08;
            a.legL.rotation.x = -1.48;
            a.legR.rotation.x = -1.48;
          } else if (manualKind === 'relax') {
            a.bodyG.rotation.x = -0.16;
            a.head.rotation.x = 0.18;
            a.armL.rotation.x = -0.3;
            a.armR.rotation.x = -0.3;
            a.legL.rotation.x = -1.18;
            a.legR.rotation.x = -1.18;
            a.bodyG.rotation.z = Math.sin(simClock * 2 + a.z) * 0.03;
          }
        } else if (a.duelAfterT > 0 && !reduced) {
          if (a.duelAfterRole === 'winner' && !a.duelAfterSpawned) spawnDuelBurst(a);
          if (a.duelAfterRole === 'winner') {
            a.armL.rotation.x = Math.min(a.armL.rotation.x, -0.25);
            a.armR.rotation.x = Math.min(a.armR.rotation.x, -0.25);
          } else if (a.duelAfterRole === 'loser') {
            a.armL.rotation.x = Math.max(a.armL.rotation.x, -1.3);
            a.armR.rotation.x = Math.max(a.armR.rotation.x, -1.3);
          }
        }
        if ((!acting && !socialKind) || (acting && !(/^(watch|meet|board|sofa|bean|window|perch|stand|brew|lounge|shelf|plant|table|desk|snack|jukebox|duet)/.test(reaction || '')))) {
          if (a.def.state !== 'asleep' && !(a.def.state === 'failed' && a.mode === 'sit')) a.head.rotation.x = 0;
        }
        if (a.def.state === 'asleep') {
          a.head.rotation.x = 0.55;
          a.head.position.y = 2.6;
        }
        if (a.def.state === 'failed' && a.mode === 'sit') a.head.rotation.x = 0.35;
        a.plumbob.rotation.y += dt * (selected === a ? 3.2 : 1.6);
        a.plumbob.position.y = a.headTop + 0.6 + Math.sin(simClock * 2 + a.x) * 0.08;
        if (a.duelAfterT > 0 && a.duelAfterRole === 'winner') a.plumbob.scale.setScalar(1.85);
        else if (a.duelAfterT > 0 && a.duelAfterRole === 'loser') a.plumbob.scale.setScalar(0.92);
        else a.plumbob.scale.setScalar(selected === a ? 1.5 : 1);
        updateThought(a);
        a.thought.position.y = a.headTop + 1.35 + Math.sin(simClock * 1.7 + a.z) * 0.06;
        a.label.visible = hovered === a || selected === a;
        if (!a.label.userData.baseScale) a.label.userData.baseScale = a.label.scale.clone();
        var labelScale = selected === a ? 0.42 : 1;
        a.label.scale.copy(a.label.userData.baseScale).multiplyScalar(labelScale);
      }

      // ---- main loop ------------------------------------------------------------------------
      var simClock = 0, last = performance.now();
      function frame(ts) {
        var raw = Math.min(0.05, (ts - last) / 1000);
        last = ts;
        var dt = raw * speed;
        if (!reduced && speed > 0) {
          simClock += dt;
          agents.forEach(function (a) { step(a, dt); });
          if (agents.some(function (a) { return a.remove; })) removeDeparted();
          stepWeather(dt);
        }
        agents.forEach(function (a) { animateOfficer(a, dt); });
        stepDuelBursts(dt);
        zzzs.forEach(function (sp) {
          var ph = (simClock * 0.4 + sp.userData.off) % 1;
          var a = sp.userData.a;
          sp.position.set(a.x + 0.8 + ph * 0.8, 3.6 + ph * 1.6, a.z);
          sp.material.opacity = ph < 0.1 ? ph * 10 : 1 - ph;
        });
        stepProps(dt);
        stepFireworks(dt);
        stepDayNight();
        updateCamera(raw);
        updateCutaway();
        if (typeof updateOfficeMinimap === 'function') updateOfficeMinimap();
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
      }

      // ---- sizing -----------------------------------------------------------------------------
      function isFs() {
        return (document.fullscreenElement || document.webkitFullscreenElement) === sceneEl;
      }
      function fit() {
        var w, h;
        if (isFs()) {
          w = Math.max(320, window.innerWidth);
          h = Math.max(380, window.innerHeight);
        } else {
          var box = sceneEl.getBoundingClientRect();
          w = Math.max(320, box.width);
          h = Math.max(380, Math.min(720, w * 0.6));
        }
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, false);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      window.addEventListener('resize', fit);

      // ---- full screen ------------------------------------------------------------------------
      var fsBtn = document.getElementById('fs-btn');
      function toggleFs() {
        if (isFs()) {
          (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
        } else {
          (sceneEl.requestFullscreen || sceneEl.webkitRequestFullscreen || function () {}).call(sceneEl);
        }
      }
      function onFsChange() {
        var on = isFs();
        if (fsBtn) {
          fsBtn.setAttribute('aria-pressed', String(on));
          fsBtn.textContent = on ? '✕' : '⛶';
          fsBtn.title = on ? 'exit full screen (f)' : 'toggle full screen (f)';
        }
        fit();
      }
      if (fsBtn) { fsBtn.addEventListener('click', toggleFs); }
      document.addEventListener('fullscreenchange', onFsChange);
      document.addEventListener('webkitfullscreenchange', onFsChange);
      window.addEventListener('keydown', function (e) {
        if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
          var t = e.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
          e.preventDefault();
          toggleFs();
        }
      });

      // ---- boot ---------------------------------------------------------------------------------
      fit();
      applyView('iso');
      sph.r = want.r; sph.phi = want.phi; sph.theta = want.theta;
      if (reduced) {
        simClock = 3;
        stepDayNight(); stepProps(0.016); updateCamera(0.016); updateCutaway();
        stepFireworks(0.016);
        agents.forEach(function (a) { animateOfficer(a, 0.016); });
        if (typeof updateOfficeMinimap === 'function') updateOfficeMinimap();
        renderer.render(scene, camera);
        ['pointermove', 'pointerup', 'wheel', 'click'].forEach(function (ev) {
          canvas.addEventListener(ev, function () {
            updateCamera(0.05);
            updateCutaway();
            if (typeof updateOfficeMinimap === 'function') updateOfficeMinimap();
            renderer.render(scene, camera);
          });
        });
      } else {
        requestAnimationFrame(function (ts) { last = ts; requestAnimationFrame(frame); });
      }

      // ---- live updates (SSE — active only when the page is served via --serve) --------------
      // The static file:// path never reaches this: the protocol guard at the bottom skips it.
      // Server pushes a full payload; the client diffs by agent id — matched officers update in
      // place (plumbob/thought/screens/panel), new ones walk in through the lobby to a desk that
      // rolls in by the door, departed ones walk out to the lobby front and are removed.
      function removeDeparted() {
        var keep = [];
        agents.forEach(function (a) {
          if (!a.remove) { keep.push(a); return; }
          releaseSpot(a);
          if (selected === a) { deselect(); updatePanel(); }
          if (hovered === a) { hovered = null; tipEl.style.display = 'none'; }
          scene.remove(a.group);
          a.group.traverse(function (o) {
            if (o.geometry) o.geometry.dispose();
            // dispose materials but never their maps — thought textures are a shared cache
            if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
          });
          zzzs = zzzs.filter(function (sp) {
            if (sp.userData.a !== a) return true;
            scene.remove(sp);
            sp.material.dispose();
            return false;
          });
          delete agentById[a.def.id];
        });
        agents = keep;
        // picking indexes into the agents array — reindex after any removal
        agents.forEach(function (ag, i) { ag.group.traverse(function (o) { o.userData.agentIdx = i; }); });
      }

      function updateAgentDef(a, def) {
        var prev = a.def.state;
        a.def = def;
        if (prev !== def.state) {
          syncPlumbobState(a);
          if (prev === 'asleep') a.head.position.y = 2.75; // wake up — undo the slumped head
          syncZzz(a);
          a.decideT = 0.4 + Math.random() * 0.8; // act on the new state soon
        }
        if (selected === a) updatePanel();
      }

      function activeDeskUser(desk) {
        for (var i = 0; i < agents.length; i++) {
          var a = agents[i];
          if (a.desk === desk && !a.remove && !a.departing) return a;
        }
        return null;
      }

      function claimExistingDesk(room, def) {
        if (!room || deskByAgent[def.id]) return false;
        for (var i = 0; i < room.desks.length; i++) {
          var desk = room.desks[i];
          if (activeDeskUser(desk)) continue;
          if (desk.agentId && deskByAgent[desk.agentId] === desk) delete deskByAgent[desk.agentId];
          desk.agentId = def.id;
          desk.state = def.state;
          deskByAgent[def.id] = desk;
          furnitureObjects.forEach(function (item) {
            if (item && item.type === 'desk' && item.desk === desk) item.agentId = def.id;
          });
          return true;
        }
        return false;
      }

      function spawnAgent(def) {
        // Reuse a free desk in the department first; only grow the room when all desks are occupied.
        var room = null;
        for (var i = 0; i < rooms.length; i++) if (rooms[i].id === 'dept:' + def.dept) { room = rooms[i]; break; }
        if (room && !deskByAgent[def.id] && !claimExistingDesk(room, def)) {
          var pos = deskSlotPosition(room, room.desks.length);
          var desk = { x: pos.x, z: pos.z, agentId: def.id, state: def.state };
          room.desks.push(desk);
          deskByAgent[def.id] = desk;
          registerFurniture(room, createDeskFurniture(desk));
        }
        var a = buildOfficer(def); // sets userData.agentIdx = agents.length (its post-push index)
        agents.push(a);
        agentById[def.id] = a;
        syncZzz(a);
        if (reduced) return; // sits straight down; the static re-render after apply shows it
        a.x = lobbyRoom.cx; a.z = lobbyRoom.z1 + 6.0; // start on the street path!
        routeTo(a, a.desk.x, a.desk.z + 1.55);
        a.after = 'sit';
        a.destIcon = '💼';
      }

      function departAgent(a) {
        if (a.departing) return;
        a.departing = true;
        a.departT = 40; // safety: leave even if the walk stalls
        if (reduced) { a.remove = true; return; }
        releaseSpot(a);
        clearSocial(a);
        routeTo(a, lobbyRoom.cx, lobbyRoom.z1 + 6.0); // walk out to the street path!
        a.after = 'depart';
        a.destIcon = '👋';
      }

      // Live diff of a pushed payload — HUD counts are updated by the
      // shared page runtime before this is called; the theme only moves its officers.
      function applyPayload(p) {
        var incoming = {};
        var celebrating = {};
        var completions = {};
        (p.agents || []).forEach(function (d) { incoming[d.id] = d; });
        (p.celebrations || []).forEach(function (id) { celebrating[id] = true; });
        (p.completions || []).forEach(function (d) { if (d && d.id) completions[d.id] = d; });
        agents.forEach(function (a) {
          var d = incoming[a.def.id];
          if (a.departing) {
            if (d) { // came back mid-walkout — turn around
              a.departing = false; a.remove = false;
              updateAgentDef(a, d);
              goDesk(a);
            }
            return;
          }
          if (d) updateAgentDef(a, d);
          else {
            var completed = completions[a.def.id] || null;
            if (celebrating[a.def.id]) {
              launchCompletionFireworks(a);
              if (completed) showCompletionPopup(a, completed);
            }
            departAgent(a);
          }
        });
        (p.agents || []).forEach(function (d) { if (!agentById[d.id]) spawnAgent(d); });
        if (reduced) {
          if (agents.some(function (a) { return a.remove; })) removeDeparted();
          stepProps(0.016);
          agents.forEach(function (a) { animateOfficer(a, 0.016); });
          if (typeof updateOfficeMinimap === 'function') updateOfficeMinimap();
          renderer.render(scene, camera);
        }
      }

      return { applyPayload: applyPayload };
    }
  }

  var REG = window.OFFICE_THEMES = window.OFFICE_THEMES || {};
  REG[themeValue('id', 'darken-theme')] = {
    label: themeValue('label', 'Darken Theme'),
    boot: function (ctx) {
      return new DefaultOfficeTheme(ctx).boot();
    },
  };
})();
