      // ---- weather ---------------------------------------------------------------------
      var WEATHERS = ['clear', 'cloudy', 'rain', 'snow'];
      var WX_ICON = { clear: '☀️ clear', cloudy: '☁️ cloudy', rain: '🌧 rain', snow: '❄️ snow' };
      var weather = WEATHERS[Math.floor(seeded() * 4)];
      var wxT = 40 + seeded() * 40;
      var wxEl = document.getElementById('wx');
      function setWxChip() { if (wxEl) wxEl.textContent = WX_ICON[weather]; }
      setWxChip();

      function spawnOutsideHouse() {
        for (var t = 0; t < 8; t++) {
          var x = (Math.random() - 0.5) * 240, z = (Math.random() - 0.5) * 170;
          if (!(Math.abs(x) < W / 2 + 2 && Math.abs(z) < D / 2 + 2)) return { x: x, z: z };
        }
        return { x: W / 2 + 10, z: 0 };
      }
      function makeParticles(count, color, size) {
        var pos = new Float32Array(count * 3), vel = new Float32Array(count);
        for (var i = 0; i < count; i++) {
          var xz = spawnOutsideHouse();
          pos[i * 3] = xz.x; pos[i * 3 + 1] = 2 + Math.random() * 34; pos[i * 3 + 2] = xz.z;
          vel[i] = 0.7 + Math.random() * 0.6;
        }
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        var mat = new THREE.PointsMaterial({ color: color, size: size, transparent: true, opacity: 0, depthWrite: false });
        var pts = new THREE.Points(geo, mat);
        pts.userData.vel = vel;
        scene.add(pts);
        return pts;
      }
      var rain = makeParticles(1000, themeValue('weather.rain', 0x9fb7d0), 0.28);
      var snow = makeParticles(700, 0xffffff, 0.5);

      var clouds = [];
      for (var ci = 0; ci < 8; ci++) {
        // flat rectangular cloud slabs, drifting on a grid — the minecraft sky layer
        var cg = new THREE.Group();
        var cmat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
        for (var cj = 0; cj < 2 + Math.floor(seeded() * 3); cj++) {
          var s = new THREE.Mesh(new THREE.BoxGeometry(6 + Math.floor(seeded() * 3) * 3, 1.2, 4 + Math.floor(seeded() * 3) * 3), cmat);
          s.position.set(cj * 6 - 6 + Math.floor(seeded() * 2) * 3, 0, Math.floor(seeded() * 2) * 3 - 1.5);
          cg.add(s);
        }
        cg.position.set((seeded() - 0.5) * 240, 30 + seeded() * 8, (seeded() - 0.5) * 150);
        cg.userData = { speed: 0.6 + seeded() * 0.9, mat: cmat };
        clouds.push(cg);
        scene.add(cg);
      }

      var starPos = new Float32Array(400 * 3);
      for (var si = 0; si < 400; si++) {
        var sv = new THREE.Vector3((seeded() - 0.5), seeded() * 0.5 + 0.12, (seeded() - 0.5)).normalize().multiplyScalar(440);
        starPos[si * 3] = sv.x; starPos[si * 3 + 1] = sv.y; starPos[si * 3 + 2] = sv.z;
      }
      var starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      var starMat = new THREE.PointsMaterial({ color: themeValue('weather.stars', 0xdfe8ff), size: 1.7, transparent: true, opacity: 0, sizeAttenuation: false, depthWrite: false });
      var stars = new THREE.Points(starGeo, starMat);
      scene.add(stars);

      function stepWeather(dt) {
        wxT -= dt;
        if (wxT <= 0) {
          var next = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];
          if (next !== weather) { weather = next; setWxChip(); }
          wxT = 45 + Math.random() * 45;
        }
        var wantRain = weather === 'rain' ? 0.85 : 0;
        var wantSnow = weather === 'snow' ? 0.9 : 0;
        rain.material.opacity += (wantRain - rain.material.opacity) * Math.min(1, dt * 1.5);
        snow.material.opacity += (wantSnow - snow.material.opacity) * Math.min(1, dt * 1.5);
        var wantCloud = weather === 'clear' ? 0.35 : weather === 'cloudy' ? 0.92 : 0.85;
        clouds.forEach(function (c) {
          c.userData.mat.opacity += (wantCloud - c.userData.mat.opacity) * Math.min(1, dt);
          c.position.x += c.userData.speed * dt * (weather === 'rain' ? 2.2 : 1);
          if (c.position.x > 130) c.position.x = -130;
        });
        if (rain.material.opacity > 0.05) {
          var rp = rain.geometry.attributes.position, rv = rain.userData.vel;
          for (var i = 0; i < rp.count; i++) {
            var y = rp.getY(i) - rv[i] * dt * 30;
            if (y < 0.2) y = 26 + Math.random() * 10;
            rp.setY(i, y);
          }
          rp.needsUpdate = true;
        }
        if (snow.material.opacity > 0.05) {
          var sp = snow.geometry.attributes.position, sv2 = snow.userData.vel;
          for (var j = 0; j < sp.count; j++) {
            var sy = sp.getY(j) - sv2[j] * dt * 3.2;
            var sx = sp.getX(j) + Math.sin(simClock * 1.4 + j) * dt * 0.9;
            if (sy < 0.2) { sy = 24 + Math.random() * 10; }
            sp.setY(j, sy); sp.setX(j, sx);
          }
          sp.needsUpdate = true;
        }
        trees.forEach(function (t) {
          var sway = weather === 'rain' || weather === 'snow' ? 0.05 : 0.02;
          t.rotation.z = Math.sin(simClock * 1.1 + t.userData.phase) * sway;
        });
      }

      // ---- day / night ------------------------------------------------------------------
      var SKY_DAY = new THREE.Color(themeValue('weather.skyDay', 0x78a7ff)), SKY_DUSK = new THREE.Color(themeValue('weather.skyDusk', 0xd8863c)), SKY_NIGHT = new THREE.Color(themeValue('weather.skyNight', 0x070b14));
      var skyCol = new THREE.Color();
      function themeNight() {
        var v = getComputedStyle(document.documentElement).getPropertyValue('--night').trim();
        return v === '1' ? 1 : 0;
      }
      var forcedNight = themeNight();
      new MutationObserver(function () { forcedNight = themeNight(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { forcedNight = themeNight(); });

      // debug/preview overrides via URL hash: #hour=13&wx=rain
      var dbg = {};
      function parseHash() {
        dbg = {};
        location.hash.slice(1).split('&').forEach(function (kv) {
          var p = kv.split('=');
          if (p[0]) dbg[p[0]] = decodeURIComponent(p[1] || '');
        });
        if (dbg.wx && WEATHERS.indexOf(dbg.wx) >= 0) { weather = dbg.wx; setWxChip(); wxT = 1e9; }
      }
      window.addEventListener('hashchange', parseHash);
      parseHash();

      var clkEl = document.getElementById('clk');
      function stepDayNight() {
        var d = new Date();
        if (clkEl) clkEl.textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        var hour = dbg.hour != null ? parseFloat(dbg.hour) : forcedNight ? 23 : d.getHours() + d.getMinutes() / 60;
        var elev = Math.sin((hour - 6) / 12 * Math.PI);
        var dayness = Math.max(0, Math.min(1, elev * 1.6));
        var duskness = Math.max(0, 1 - Math.abs(elev) * 3.2);
        var wxDim = weather === 'rain' ? 0.55 : weather === 'cloudy' ? 0.75 : weather === 'snow' ? 0.7 : 1;
        skyCol.copy(SKY_NIGHT).lerp(SKY_DAY, dayness).lerp(SKY_DUSK, duskness * 0.55);
        if (weather === 'rain') skyCol.multiplyScalar(0.7);
        scene.background = skyCol;
        scene.fog.color.copy(skyCol);
        var az = (hour - 12) / 12 * Math.PI;
        sun.position.set(Math.sin(az) * 140, Math.max(6, elev * 140), 70 * Math.cos(az * 0.6));
        sun.intensity = (elev > 0 ? 0.35 + dayness * 0.75 : 0.12) * wxDim;
        sun.color.setHex(elev > 0 ? (duskness > 0.4 ? themeValue('weather.sunDusk', 0xffc287) : themeValue('weather.sunDay', 0xfff4e0)) : themeValue('weather.sunNight', 0x8ea4cc));
        // square sun rides the light's bearing; the square moon sits opposite
        var sdir = sun.position.clone().normalize();
        sunSquare.position.copy(sdir).multiplyScalar(430);
        sunSquare.lookAt(0, 0, 0);
        sunSquare.material.opacity = Math.max(0, Math.min(0.95, elev * 2)) * (weather === 'rain' || weather === 'cloudy' ? 0.25 : 1);
        moonSquare.position.copy(sdir).multiplyScalar(-430);
        moonSquare.position.y = Math.max(30, -sdir.y * 430);
        moonSquare.lookAt(0, 0, 0);
        moonSquare.material.opacity = Math.max(0, Math.min(0.9, -elev * 2)) * (weather === 'rain' || weather === 'cloudy' ? 0.2 : 1);
        hemi.intensity = (0.3 + dayness * 0.5) * wxDim;
        starMat.opacity = Math.max(0, 0.9 - dayness * 2 - (weather === 'rain' || weather === 'cloudy' ? 0.5 : 0));
        var nightF = 1 - dayness;
        var lampDay = LIT.roomLightDay != null ? LIT.roomLightDay : 0.32;
        var lampNight = LIT.roomLightNight != null ? LIT.roomLightNight : 1.05;
        var lampI = lampDay + (lampNight - lampDay) * nightF;
        roomLights.forEach(function (l) { l.intensity = lampI; });
        var bulbGlow = nightF > 0.5 ? themeValue('weather.bulbGlowNight', 0x66512b) : themeValue('weather.bulbGlowDay', 0x2a2113);
        bulbMats.forEach(function (m) { m.emissive.setHex(bulbGlow); });
        glassMats.forEach(function (m) { m.emissive.setHex(nightF > 0.55 ? themeValue('weather.windowGlowNight', 0x4a3a1e) : 0x000000); });
      }
