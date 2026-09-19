      // ---- lamps ------------------------------------------------------------------------
      function pendant(x, z, accent) {
        var g = new THREE.Group();
        var cord = boxMesh(0.09, 1.6, 0.09, 0x3a3a3a);
        cord.position.y = 5.0;
        g.add(cord);
        var bulbM = texMat(TEX.glowstone);
        var bulb = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), bulbM);
        bulb.castShadow = true;
        bulb.position.y = 3.95;
        g.add(bulb);
        bulbMats.push(bulbM);
        g.position.set(x, 0, z);
        house.add(g);
      }

      function floorLamp(x, z, accent) {
        var g = new THREE.Group();
        var pole = texBox(0.22, 3.0, 0.22, TEX.bark);
        pole.position.y = 1.5; g.add(pole);
        var tipM = new THREE.MeshLambertMaterial({ color: themeValue('furniture.torchTip', 0xE8A33C), emissive: 0x000000 });
        var tip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), tipM);
        tip.position.y = 3.15; g.add(tip);
        bulbMats.push(tipM);
        g.position.set(x, 0.2, z);
        house.add(g);
      }

      rooms.forEach(function (r) {
        var nPend = LIT.pendantsPerRoom != null ? LIT.pendantsPerRoom : 2;
        for (var i = 0; i < nPend; i++) {
          var fx = r.x0 + (r.x1 - r.x0) * ((i + 1) / (nPend + 1));
          pendant(fx, r.cz, r.accent || 0xD98E2B);
        }
        var pl = new THREE.PointLight(0xffd9a0, 0, 30, 2);
        pl.position.set(r.cx, 4.4, r.cz);
        scene.add(pl);
        roomLights.push(pl);
      });

      if (LIT.corridorLights !== false) {
        [-W / 4, W / 4].forEach(function (lx) {
          var pl = new THREE.PointLight(0xffe6c0, 0, 26, 2);
          pl.position.set(lx, 4.0, 0);
          scene.add(pl);
          roomLights.push(pl);
          pendant(lx, 0, 0x8a8378);
        });
      }
