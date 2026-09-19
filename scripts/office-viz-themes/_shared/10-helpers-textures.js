      // ---- helpers ---------------------------------------------------------------
      function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
      function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
      var seeded = mulberry(1234);
      function cnum(hex, fallback) {
        if (typeof hex === 'string' && /^#?[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex.replace('#', ''), 16);
        return fallback;
      }
      var PAL = CFG.palette || {};
      var LIT = CFG.lighting || {};
      var DEC = CFG.decor || {};
      var BLD = CFG.building || {};
      var ACCENTS = (PAL.accents || themeArray('palette.accents', ['#D98E2B', '#7A93A8', '#A87F9B', '#7FA88B'])).map(function (c) { return cnum(c, themeValue('palette.accentFallback', 0xD98E2B)); });
      var DEPT_FLOORS = (PAL.deptFloors || themeArray('palette.deptFloors', ['#D8CFC0', '#CDD6CE', '#D6CCD6'])).map(function (c) { return cnum(c, themeValue('palette.deptFloorFallback', 0xD8CFC0)); });

      var STATE_HEX = themeObject('states.hex', { working: 0x3fa1e8, blocked: 0xd99a2e, failed: 0xdb5f52, idle: 0x9aa0a4, asleep: 0x8f96b3, coffee: 0xc98e5a });
      var STATE_CSS = themeObject('states.css', { working: '#3FA1E8', blocked: '#D99A2E', failed: '#DB5F52', idle: '#9AA0A4', asleep: '#8F96B3', coffee: '#C98E5A' });
      var STATE_LABEL = { working: 'working', asleep: 'asleep', coffee: 'coffee break', idle: 'waiting', blocked: 'blocked', failed: 'failed' };
      var SKINS = [0xE4B48C, 0xC99A72, 0x8D5B3B, 0xF0C9A5, 0x6E4327];
      var HAIRS = [0x2C2620, 0x5B4630, 0x8C6B3E, 0x3D3D45, 0x7A2E1D, 0x9C9C9C];
      // wool-dye shirt tones
      var SHIRTS = themeArray('agents.shirts', [0x3AAFA9, 0xB1508C, 0x5B9E3C, 0xC8963C, 0x7B5BC8, 0xC85B5B, 0x3C7BC8]);

      function lam(color, opts) {
        var m = new THREE.MeshLambertMaterial({ color: color });
        if (opts && opts.emissive != null) { m.emissive.setHex(opts.emissive); }
        if (opts && opts.transparent) { m.transparent = true; m.opacity = opts.opacity != null ? opts.opacity : 1; }
        return m;
      }
      function boxMesh(w, h, d, color, opts) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lam(color, opts));
        m.castShadow = true; m.receiveShadow = true;
        return m;
      }

      // ---- pixel block textures (16×16 noise canvases, NearestFilter — the Minecraft look)
      function hexRGB(hex) { return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]; }
      function makeBlockTex(baseHex, jitter, draw, seedN) {
        var rnd = mulberry(seedN != null ? seedN : baseHex);
        var cv = document.createElement('canvas');
        cv.width = 16; cv.height = 16;
        var cx = cv.getContext('2d');
        var c = hexRGB(baseHex);
        for (var y = 0; y < 16; y++) {
          for (var x = 0; x < 16; x++) {
            var j = (rnd() - 0.5) * 2 * jitter;
            cx.fillStyle = 'rgb(' + Math.max(0, Math.min(255, Math.round(c[0] + j))) + ',' +
              Math.max(0, Math.min(255, Math.round(c[1] + j))) + ',' +
              Math.max(0, Math.min(255, Math.round(c[2] + j))) + ')';
            cx.fillRect(x, y, 1, 1);
          }
        }
        if (draw) draw(cx, rnd);
        var tex = new THREE.CanvasTexture(cv);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        return tex;
      }
      function brickLines(shade) {
        return function (cx) {
          cx.fillStyle = shade;
          cx.globalAlpha = 0.55;
          cx.fillRect(0, 3, 16, 1); cx.fillRect(0, 7, 16, 1); cx.fillRect(0, 11, 16, 1); cx.fillRect(0, 15, 16, 1);
          cx.fillRect(4, 0, 1, 4); cx.fillRect(12, 0, 1, 4);
          cx.fillRect(8, 4, 1, 4); cx.fillRect(0, 4, 1, 4);
          cx.fillRect(4, 8, 1, 4); cx.fillRect(12, 8, 1, 4);
          cx.fillRect(8, 12, 1, 4);
          cx.globalAlpha = 1;
        };
      }
      function plankLines(shade) {
        return function (cx) {
          cx.fillStyle = shade;
          cx.globalAlpha = 0.5;
          cx.fillRect(0, 3, 16, 1); cx.fillRect(0, 7, 16, 1); cx.fillRect(0, 11, 16, 1); cx.fillRect(0, 15, 16, 1);
          cx.fillRect(5, 0, 1, 4); cx.fillRect(11, 4, 1, 4); cx.fillRect(3, 8, 1, 4); cx.fillRect(13, 12, 1, 4);
          cx.globalAlpha = 1;
        };
      }
      var TEX = {
        grass: makeBlockTex(cnum(PAL.grass, themeValue('textures.grass', 0x6DA24E)), themeValue('textures.grassNoise', 26)),
        dirt: makeBlockTex(themeValue('textures.dirt', 0x8A5A32), themeValue('textures.dirtNoise', 24)),
        stone: makeBlockTex(themeValue('textures.stone', 0x8C8C8C), themeValue('textures.stoneNoise', 22)),
        stoneBrick: makeBlockTex(themeValue('textures.stoneBrick', 0x9A9A9A), 16, brickLines(themeValue('textures.stoneBrickLine', '#5d5d5d'))),
        cobble: makeBlockTex(themeValue('textures.cobble', 0x7E7E7E), 34, null, 777),
        planks: makeBlockTex(themeValue('textures.planks', 0xB08A54), themeValue('textures.planksNoise', 14), plankLines(themeValue('textures.plankLine', '#6e5430'))),
        darkPlanks: makeBlockTex(themeValue('textures.darkPlanks', 0x6E4E2C), themeValue('textures.darkPlanksNoise', 14), plankLines(themeValue('textures.darkPlankLine', '#3d2a15'))),
        bark: makeBlockTex(themeValue('textures.bark', 0x6B502F), themeValue('textures.barkNoise', 20), function (cx) {
          cx.fillStyle = themeValue('textures.barkLine', '#4a3720'); cx.globalAlpha = 0.6;
          cx.fillRect(2, 0, 1, 16); cx.fillRect(7, 0, 1, 16); cx.fillRect(12, 0, 1, 16);
          cx.globalAlpha = 1;
        }),
        leaves: makeBlockTex(themeValue('textures.leaves', 0x4E8A35), themeValue('textures.leavesNoise', 34), null, 4242),
        glowstone: makeBlockTex(themeValue('textures.glowstone', 0xE8C86A), themeValue('textures.glowstoneNoise', 40), null, 999),
        sand: makeBlockTex(themeValue('textures.sand', 0xD8CFA0), themeValue('textures.sandNoise', 18)),
        wool: (function () {
          var cache = {};
          return function (hex) {
            if (!cache[hex]) cache[hex] = makeBlockTex(hex, 12, null, hex ^ 0x5f5f);
            return cache[hex];
          };
        })(),
      };
      function texMat(tex, opts) {
        var m = new THREE.MeshLambertMaterial({ map: tex });
        if (opts && opts.emissive != null) { m.emissive.setHex(opts.emissive); }
        if (opts && opts.transparent) { m.transparent = true; m.opacity = opts.opacity != null ? opts.opacity : 1; }
        return m;
      }
      function texBox(w, h, d, tex, opts) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), texMat(tex, opts));
        m.castShadow = true; m.receiveShadow = true;
        return m;
      }
      // repeat-tiled variant for long/large surfaces (walls, floors) so texels stay ~1 block
      function tiledTex(tex, ru, rv) {
        var t = tex.clone();
        t.needsUpdate = true;
        t.repeat.set(Math.max(1, Math.round(ru)), Math.max(1, Math.round(rv)));
        return t;
      }
      function tiledBox(w, h, d, tex, blockSize) {
        var b = blockSize || 3;
        var m = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          texMat(tiledTex(tex, Math.max(w, d) / b, Math.max(h, Math.min(w, d)) / b))
        );
        m.castShadow = true; m.receiveShadow = true;
        return m;
      }
