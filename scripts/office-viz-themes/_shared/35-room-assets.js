      // ---- reusable room assets --------------------------------------------------------
      class OfficeSceneObject {
        constructor(type, opts) {
          opts = opts || {};
          this.type = type;
          this.group = null;
          this.x = opts.x || 0;
          this.y = opts.y != null ? opts.y : 0.2;
          this.z = opts.z || 0;
          this.rotationY = opts.rotationY || 0;
          if (typeof allVisualDecorations !== 'undefined') {
            allVisualDecorations.push(this);
          }
        }

        createGroup() {
          return new THREE.Group();
        }

        applyTransform() {
          if (!this.group) return;
          this.group.position.set(this.x, this.y, this.z);
          this.group.rotation.y = this.rotationY;
        }

        setPosition(x, y, z) {
          this.x = x;
          this.y = y != null ? y : this.y;
          this.z = z;
          this.applyTransform();
          return this;
        }

        setRotation(y) {
          this.rotationY = y || 0;
          this.applyTransform();
          return this;
        }

        rotateBy(delta) {
          return this.setRotation(this.rotationY + delta);
        }

        mount(parent) {
          this.applyTransform();
          parent.add(this.group);
          return this.group;
        }
      }

      class ReactableAsset extends OfficeSceneObject {
        createSpot(x, z, face, type, opts) {
          opts = opts || {};
          var forward = opts.forward || 0;
          var sits = !!opts.sit || type === 'seat';
          var s = {
            x: x + Math.sin(face) * forward,
            z: z + Math.cos(face) * forward,
            assetX: x,
            assetZ: z,
            face: face,
            type: type,
            sit: sits,
            busyBy: null,
          };
          if (opts.seatY != null) s.seatY = opts.seatY;
          if (opts.mat) s.mat = opts.mat;
          if (opts.reactions) s.reactions = opts.reactions;
          return s;
        }
      }

      class FurnitureObject extends ReactableAsset {
        render() {}
        update() {}
      }

      function addStackedCubes(g, cubes, matOrColor) {
        cubes.forEach(function (c) {
          var mesh = typeof matOrColor === 'number' ? boxMesh(c[3], c[4], c[5], matOrColor) : texBox(c[3], c[4], c[5], matOrColor);
          mesh.position.set(c[0], c[1], c[2]);
          g.add(mesh);
        });
      }

      class PlantAsset extends FurnitureObject {
        constructor(x, z, opts) {
          opts = opts || {};
          super('plant', { x: x, z: z, rotationY: opts.rotationY || 0 });
          this.variant = opts.variant || 'round';
          this.scale = opts.scale || 1;
          this.potColor = opts.potColor || null;
        }

        render() {
          if (DEC.plants === false) return;
          var g = this.createGroup();
          var potTex = this.potColor ? TEX.wool(this.potColor) : TEX.cobble;
          var s = this.scale;
          var pot = texBox(0.9 * s, 0.8 * s, 0.9 * s, potTex); pot.position.y = 0.4 * s; g.add(pot);
          var soil = texBox(0.7 * s, 0.12 * s, 0.7 * s, TEX.dirt); soil.position.y = 0.82 * s; g.add(soil);
          if (this.variant === 'cactus') {
            addStackedCubes(g, [
              [0, 1.32 * s, 0, 0.34 * s, 1.0 * s, 0.34 * s],
              [-0.35 * s, 1.48 * s, 0, 0.26 * s, 0.56 * s, 0.26 * s],
              [0.34 * s, 1.8 * s, 0, 0.26 * s, 0.64 * s, 0.26 * s],
            ], TEX.leaves);
          } else if (this.variant === 'palm') {
            var stem = texBox(0.18 * s, 1.25 * s, 0.18 * s, TEX.bark); stem.position.y = 1.4 * s; g.add(stem);
            [[0, 0], [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]].forEach(function (o) {
              var leaf = texBox(0.7 * s, 0.18 * s, 0.34 * s, TEX.leaves);
              leaf.position.set(o[0] * s, 2.15 * s, o[1] * s);
              leaf.rotation.y = Math.atan2(o[0], o[1] || 0.001);
              g.add(leaf);
            });
          } else {
            var stem2 = texBox(0.16 * s, 0.7 * s, 0.16 * s, TEX.bark); stem2.position.y = 1.2 * s; g.add(stem2);
            var leaves = texBox(0.9 * s, 0.9 * s, 0.9 * s, TEX.leaves); leaves.position.y = 1.85 * s; g.add(leaves);
            var tuft = texBox(0.55 * s, 0.55 * s, 0.55 * s, TEX.leaves); tuft.position.set(0.32 * s, 2.2 * s, -0.1 * s); g.add(tuft);
          }
          this.group = g;
          return this.mount(house);
        }
      }

      class RugAsset extends FurnitureObject {
        constructor(x, z, rad, color) {
          super('rug', { x: x, y: 0.24, z: z });
          this.rad = rad;
          this.color = color;
        }

        render() {
          if (DEC.rugs === false) return;
          this.group = new THREE.Group();
          var rug = new THREE.Mesh(new THREE.BoxGeometry(this.rad * 1.8, 0.06, this.rad * 1.8), texMat(tiledTex(TEX.wool(this.color), this.rad, this.rad)));
          this.group.add(rug);
          return this.mount(house);
        }
      }

      class ChairAsset extends FurnitureObject {
        constructor(x, z, rotY, color) {
          super('chair', { x: x, z: z, rotationY: rotY });
          this.color = color;
        }

        render() {
          var g = this.createGroup();
          var seat = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.14, 1.0), texMat(TEX.wool(this.color)));
          seat.castShadow = true; seat.position.y = 0.95; g.add(seat);
          var back = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 0.14), texMat(TEX.wool(this.color)));
          back.castShadow = true; back.position.set(0, 1.55, 0.45); g.add(back);
          var pole = texBox(0.18, 0.9, 0.18, TEX.darkPlanks);
          pole.position.set(0, 0.5, 0); g.add(pole);
          this.group = g;
          return this.mount(house);
        }
      }

      class LoungeChairAsset extends FurnitureObject {
        constructor(x, z, rotY, color) {
          super('lounge-chair', { x: x, z: z, rotationY: rotY });
          this.color = color;
        }

        render() {
          var wt = TEX.wool(this.color);
          var g = this.createGroup();
          var seat = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.55, 1.45), texMat(wt)); seat.castShadow = true; seat.position.y = 0.7; g.add(seat);
          var back = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.15, 0.34), texMat(wt)); back.castShadow = true; back.position.set(0, 1.25, -0.58); g.add(back);
          var lArm = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.9, 1.45), texMat(wt)); lArm.castShadow = true; lArm.position.set(-0.88, 0.95, 0); g.add(lArm);
          var rArm = lArm.clone(); rArm.position.x = 0.88; g.add(rArm);
          var ott = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.42, 0.8), texMat(wt)); ott.castShadow = true; ott.position.set(0, 0.52, 1.28); g.add(ott);
          this.group = g;
          return this.mount(house);
        }
      }

      class ShelfAsset extends FurnitureObject {
        constructor(x, z, rotY, opts) {
          opts = opts || {};
          super(opts.type || 'shelf', { x: x, z: z, rotationY: rotY || 0 });
          this.w = opts.w || 2.6;
          this.h = opts.h || 2.6;
          this.d = opts.d || 0.58;
          this.accent = opts.accent || themeValue('furniture.shelfAccent', 0x3C7BC8);
        }

        render() {
          var g = this.createGroup();
          var frame = texBox(this.w, this.h, this.d, TEX.darkPlanks); frame.position.y = this.h / 2; g.add(frame);
          for (var i = 0; i < 3; i++) {
            var shelf = texBox(this.w + 0.18, 0.12, this.d + 0.18, TEX.planks);
            shelf.position.y = 0.65 + i * 0.72;
            g.add(shelf);
          }
          for (var j = 0; j < 10; j++) {
            var book = boxMesh(0.16 + (j % 3) * 0.05, 0.42 + (j % 4) * 0.06, 0.32, [0xB1508C, 0x3C7BC8, 0x5B9E3C, 0xC8963C][j % 4]);
            book.position.set(-this.w / 2 + 0.34 + j * 0.2, 1.0 + (j % 3) * 0.72, this.d / 2 + 0.08);
            g.add(book);
          }
          var trophy = boxMesh(0.34, 0.45, 0.34, this.accent, { emissive: this.accent });
          trophy.position.set(this.w / 2 - 0.5, 2.35, this.d / 2 + 0.08);
          g.add(trophy);
          bulbMats.push(trophy.material);
          this.group = g;
          return this.mount(house);
        }
      }

      class DesignTableAsset extends FurnitureObject {
        constructor(x, z, rotY, opts) {
          opts = opts || {};
          super(opts.type || 'design-table', { x: x, z: z, rotationY: rotY || 0 });
          this.w = opts.w || 3.4;
          this.d = opts.d || 1.8;
          this.accent = opts.accent || themeValue('furniture.designTableAccent', 0xD99A2E);
        }

        render() {
          var g = this.createGroup();
          var top = texBox(this.w, 0.18, this.d, TEX.planks); top.position.y = 1.35; g.add(top);
          [[-1.45, -0.65], [1.45, -0.65], [-1.45, 0.65], [1.45, 0.65]].forEach(function (o) {
            var leg = texBox(0.18, 1.25, 0.18, TEX.darkPlanks); leg.position.set(o[0], 0.65, o[1]); g.add(leg);
          });
          [[-0.9, 0.18, 0xF2EFE6], [-0.25, -0.22, this.accent], [0.5, 0.18, 0x9FC4E4], [1.0, -0.3, 0xE8C86A]].forEach(function (p, idx) {
            var note = boxMesh(0.54, 0.035, 0.42, p[2]);
            note.position.set(p[0], 1.48 + idx * 0.006, p[1]);
            note.rotation.y = (idx - 1) * 0.25;
            g.add(note);
          });
          var modelBase = texBox(0.55, 0.18, 0.55, TEX.stone); modelBase.position.set(0.9, 1.62, 0.34); g.add(modelBase);
          var modelTower = boxMesh(0.22, 0.7, 0.22, themeValue('furniture.prototypeTower', 0x5B9E3C)); modelTower.position.set(0.9, 2.05, 0.34); g.add(modelTower);
          var pencil = boxMesh(0.08, 0.08, 0.78, this.accent); pencil.position.set(-1.2, 1.58, -0.42); pencil.rotation.y = 0.8; g.add(pencil);
          this.group = g;
          return this.mount(house);
        }
      }

      class StandingDeskAsset extends FurnitureObject {
        constructor(x, z, rotY, opts) {
          opts = opts || {};
          super('standing-desk', { x: x, z: z, rotationY: rotY || 0 });
          this.screenMat = null;
          this.accent = opts.accent || themeValue('furniture.standingDeskGlow', 0x3FA1E8);
        }

        render() {
          var g = this.createGroup();
          var top = texBox(2.2, 0.18, 1.0, TEX.darkPlanks); top.position.y = 1.72; g.add(top);
          var frame = texBox(1.8, 1.6, 0.14, TEX.bark); frame.position.set(0, 0.86, -0.36); g.add(frame);
          var mon = boxMesh(1.15, 0.74, 0.1, 0x22262a); mon.position.set(0, 2.3, -0.18); g.add(mon);
          this.screenMat = new THREE.MeshLambertMaterial({ color: 0x17232d, emissive: this.accent, emissiveIntensity: 0.25 });
          var scr = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.56), this.screenMat);
          scr.position.set(0, 2.3, -0.12);
          g.add(scr);
          var pad = boxMesh(0.9, 0.05, 0.36, 0x8C8C8C); pad.position.set(0, 1.86, 0.24); g.add(pad);
          var pot = texBox(0.38, 0.32, 0.38, TEX.wool(themeValue('furniture.microPlantPot', 0xC8963C))); pot.position.set(0.78, 1.94, 0.18); g.add(pot);
          var leaf = texBox(0.42, 0.42, 0.42, TEX.leaves); leaf.position.set(0.78, 2.28, 0.18); g.add(leaf);
          this.group = g;
          return this.mount(house);
        }

        update() {
          if (!this.screenMat) return;
          this.screenMat.emissiveIntensity = 0.22 + Math.sin(simClock * 3.2 + this.x) * 0.08;
        }
      }

      class JukeboxAsset extends FurnitureObject {
        constructor(x, z, rotY) {
          super('jukebox', { x: x, z: z, rotationY: rotY || 0 });
          this.glowMats = [];
        }

        render() {
          var g = this.createGroup();
          var body = boxMesh(1.35, 2.1, 0.75, themeValue('furniture.jukeboxBody', 0x6B3D5D)); body.position.y = 1.2; g.add(body);
          var arch = boxMesh(1.0, 0.5, 0.16, themeValue('furniture.jukeboxTrim', 0xE8C86A), { emissive: 0xE8C86A }); arch.position.set(0, 2.0, 0.44); g.add(arch);
          var panelM = new THREE.MeshLambertMaterial({ color: 0x101418, emissive: themeValue('furniture.jukeboxGlow', 0xFF7BD1), emissiveIntensity: 0.45 });
          var panel = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.9), panelM); panel.position.set(0, 1.35, 0.46); g.add(panel);
          this.glowMats.push(panelM, arch.material);
          this.group = g;
          return this.mount(house);
        }

        update() {
          this.glowMats.forEach(function (m, i) {
            m.emissiveIntensity = 0.36 + Math.max(0, Math.sin(simClock * 5.5 + i)) * 0.45;
          });
        }
      }

      class SofaAsset extends FurnitureObject {
        constructor(x, z, rotY, color) {
          super('sofa', { x: x, z: z, rotationY: rotY });
          this.color = color;
        }

        render() {
          var wt = TEX.wool(this.color);
          var g = this.createGroup();
          var s1 = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.8, 1.8), texMat(tiledTex(wt, 3, 1))); s1.castShadow = true; s1.position.y = 0.6; g.add(s1);
          var s2 = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.1, 0.5), texMat(tiledTex(wt, 3, 1))); s2.castShadow = true; s2.position.set(0, 1.15, -0.85); g.add(s2);
          var a1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 1.8), texMat(wt)); a1.castShadow = true; a1.position.set(-2.6, 0.9, 0); g.add(a1);
          var a2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 1.8), texMat(wt)); a2.castShadow = true; a2.position.set(2.6, 0.9, 0); g.add(a2);
          this.group = g;
          return this.mount(house);
        }
      }

      class TableAsset extends FurnitureObject {
        constructor(type, x, z, opts) {
          opts = opts || {};
          super(type || 'table', { x: x, z: z, rotationY: opts.rotationY || 0 });
          this.topW = opts.topW || 2.0;
          this.topD = opts.topD || 1.2;
          this.topY = opts.topY || 1.35;
          this.baseW = opts.baseW || 0.24;
          this.baseD = opts.baseD || 0.24;
          this.baseH = opts.baseH || 1.5;
          this.topTex = opts.topTex || TEX.planks;
          this.baseTex = opts.baseTex || TEX.bark;
          this.baseY = opts.baseY != null ? opts.baseY : 0.65;
        }

        render() {
          var g = this.createGroup();
          var top = texBox(this.topW, 0.12, this.topD, this.topTex);
          top.position.y = this.topY;
          g.add(top);
          var post = texBox(this.baseW, this.baseH, this.baseD, this.baseTex);
          post.position.y = this.baseY;
          g.add(post);
          this.group = g;
          return this.mount(house);
        }
      }

      class TvAsset extends FurnitureObject {
        constructor(x, z, rotY, opts) {
          opts = opts || {};
          super('tv', { x: x, y: opts.y != null ? opts.y : 2.4, z: z, rotationY: rotY });
          this.w = opts.w || 3.4;
          this.h = opts.h || 1.9;
          this.screenMat = null;
        }

        render() {
          var g = this.createGroup();
          var body = boxMesh(this.w, this.h, 0.12, 0x22262a);
          g.add(body);
          this.screenMat = new THREE.MeshLambertMaterial({ color: 0x1c2a38, emissive: 0x14344e });
          var screen = new THREE.Mesh(new THREE.PlaneGeometry(this.w - 0.3, this.h - 0.3), this.screenMat);
          screen.position.z = 0.08;
          g.add(screen);
          this.group = g;
          return this.mount(house);
        }
      }

      class LowCabinetAsset extends FurnitureObject {
        constructor(x, z, rotY, opts) {
          opts = opts || {};
          super(opts.type || 'low-cabinet', { x: x, z: z, rotationY: rotY || 0 });
          this.w = opts.w || 2.8;
          this.accent = opts.accent || themeValue('furniture.cabinetAccent', 0x7A93A8);
        }

        render() {
          var g = this.createGroup();
          var body = texBox(this.w, 1.05, 0.72, TEX.darkPlanks); body.position.y = 0.72; g.add(body);
          for (var i = 0; i < 3; i++) {
            var drawer = boxMesh(this.w / 3 - 0.12, 0.32, 0.05, this.accent);
            drawer.position.set(-this.w / 3 + i * this.w / 3, 0.78, 0.39);
            g.add(drawer);
          }
          var top = texBox(this.w + 0.18, 0.14, 0.86, TEX.planks); top.position.y = 1.32; g.add(top);
          this.group = g;
          return this.mount(house);
        }
      }

      class BulletinBoardAsset extends FurnitureObject {
        constructor(x, z, rotY, opts) {
          opts = opts || {};
          super(opts.type || 'bulletin', { x: x, y: opts.y != null ? opts.y : 2.35, z: z, rotationY: rotY || 0 });
          this.w = opts.w || 2.6;
          this.h = opts.h || 1.55;
          this.accent = opts.accent || themeValue('furniture.bulletinAccent', 0xD99A2E);
        }

        render() {
          var g = this.createGroup();
          var frame = boxMesh(this.w + 0.18, this.h + 0.18, 0.08, 0x6b563a); g.add(frame);
          var board = boxMesh(this.w, this.h, 0.05, themeValue('furniture.bulletinBoard', 0x8A5A32)); board.position.z = 0.045; g.add(board);
          for (var i = 0; i < 5; i++) {
            var note = boxMesh(0.42 + (i % 2) * 0.16, 0.28 + (i % 3) * 0.08, 0.035, [0xF2EFE6, this.accent, 0x9FC4E4, 0xE8C86A, 0xC98E5A][i]);
            note.position.set(-this.w / 2 + 0.45 + (i % 3) * 0.62, -0.35 + Math.floor(i / 3) * 0.55, 0.09);
            note.rotation.z = (i - 2) * 0.06;
            g.add(note);
          }
          this.group = g;
          return this.mount(house);
        }
      }

      class WallClockAsset extends FurnitureObject {
        constructor(x, z, rotY, opts) {
          opts = opts || {};
          super('wall-clock', { x: x, y: opts.y != null ? opts.y : 3.0, z: z, rotationY: rotY || 0 });
        }

        render() {
          var g = this.createGroup();
          var face = boxMesh(0.9, 0.9, 0.08, 0xF2EFE6); g.add(face);
          var h1 = boxMesh(0.08, 0.42, 0.05, 0x222222); h1.position.set(0, 0.12, 0.08); h1.rotation.z = -0.5; g.add(h1);
          var h2 = boxMesh(0.06, 0.34, 0.05, 0x222222); h2.position.set(0.12, -0.02, 0.09); h2.rotation.z = 1.05; g.add(h2);
          this.group = g;
          return this.mount(house);
        }
      }

      class PlanterDividerAsset extends FurnitureObject {
        constructor(x, z, rotY, opts) {
          opts = opts || {};
          super('planter-divider', { x: x, z: z, rotationY: rotY || 0 });
          this.w = opts.w || 3.2;
          this.potColor = opts.potColor || themeValue('furniture.planterDividerPot', 0x7FA88B);
        }

        render() {
          if (DEC.plants === false) return;
          var g = this.createGroup();
          var trough = texBox(this.w, 0.55, 0.58, TEX.wool(this.potColor)); trough.position.y = 0.48; g.add(trough);
          var soil = texBox(this.w - 0.25, 0.1, 0.4, TEX.dirt); soil.position.y = 0.82; g.add(soil);
          for (var i = 0; i < 4; i++) {
            var leaf = texBox(0.42, 0.72 + (i % 2) * 0.25, 0.42, TEX.leaves);
            leaf.position.set(-this.w / 2 + 0.5 + i * (this.w - 1) / 3, 1.17 + (i % 2) * 0.12, 0);
            g.add(leaf);
          }
          this.group = g;
          return this.mount(house);
        }
      }

      class FloorCushionAsset extends FurnitureObject {
        constructor(x, z, rotY, color) {
          super('floor-cushion', { x: x, z: z, rotationY: rotY || 0 });
          this.color = color || themeValue('furniture.floorCushion', 0xC8963C);
        }

        render() {
          var g = this.createGroup();
          var cushion = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.34, 1.25), texMat(TEX.wool(this.color)));
          cushion.position.y = 0.38;
          cushion.castShadow = true;
          g.add(cushion);
          this.group = g;
          return this.mount(house);
        }
      }

      class DeskFurniture extends FurnitureObject {
        constructor(desk) {
          super('desk', { x: desk.x, z: desk.z });
          this.agentId = desk.agentId;
          this.desk = desk;
          this.screenMat = null;
        }

        render() {
          var g = this.createGroup();
          var top = texBox(3.4, 0.22, 1.6, TEX.planks); top.position.y = 1.5; g.add(top);
          var l1 = texBox(0.2, 1.5, 1.4, TEX.darkPlanks); l1.position.set(-1.55, 0.75, 0); g.add(l1);
          var l2 = texBox(0.2, 1.5, 1.4, TEX.darkPlanks); l2.position.set(1.55, 0.75, 0); g.add(l2);
          var mon = boxMesh(1.5, 0.95, 0.12, 0x2B2B2B); mon.position.set(0, 2.25, -0.28); g.add(mon);
          var scrMat = new THREE.MeshLambertMaterial({ color: 0x242B30, emissive: 0x000000 });
          var scr = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.75), scrMat);
          scr.position.set(0, 2.25, -0.21); g.add(scr);
          var stand = boxMesh(0.18, 0.32, 0.18, 0x2B2B2B); stand.position.set(0, 1.72, -0.28); g.add(stand);
          var kb = boxMesh(1.2, 0.07, 0.42, 0x8C8C8C); kb.position.set(0, 1.65, 0.28); g.add(kb);
          var mug = boxMesh(0.26, 0.3, 0.26, 0xA43535); mug.position.set(1.15, 1.77, 0.3); g.add(mug);
          var papers = boxMesh(0.7, 0.05, 0.5, 0xf2efe6); papers.position.set(-1.05, 1.64, 0.2); g.add(papers);
          var dlArm = texBox(0.12, 0.8, 0.12, TEX.bark);
          dlArm.rotation.z = 0.6; dlArm.position.set(-1.3, 1.95, -0.2); g.add(dlArm);
          var dlM = new THREE.MeshLambertMaterial({ color: themeValue('furniture.deskLamp', 0xE8A33C), emissive: 0x000000 });
          var dlHead = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), dlM);
          dlHead.position.set(-1.05, 2.2, -0.2); g.add(dlHead);
          bulbMats.push(dlM);
          var seat = texBox(1.0, 0.14, 1.0, TEX.darkPlanks); seat.position.set(0, 0.95, 1.55); g.add(seat);
          var back = texBox(1.0, 1.0, 0.14, TEX.darkPlanks); back.position.set(0, 1.55, 2.0); g.add(back);
          var pole = boxMesh(0.18, 0.9, 0.18, 0x4a4a4a); pole.position.set(0, 0.5, 1.55); g.add(pole);
          this.group = g;
          this.screenMat = scrMat;
          return this.mount(house);
        }

        update() {
          if (!this.screenMat) return;
          var a = agentById[this.agentId];
          if (!a) {
            this.screenMat.emissive.setHex(0x000000);
            this.screenMat.color.setHex(0x242B30);
            return;
          }
          if (a.def.state === 'failed') {
            this.screenMat.emissive.setHex(0x8a1f18);
            this.screenMat.color.setHex(0x5a2420);
          } else if (a.def.state === 'working' && a.mode === 'sit') {
            this.screenMat.emissive.setHex(0x35586e);
            this.screenMat.color.setHex(0x9FC4E4);
          } else {
            this.screenMat.emissive.setHex(0x000000);
            this.screenMat.color.setHex(0x242B30);
          }
        }
      }

      class BoardFurniture extends FurnitureObject {
        constructor() {
          super('board');
        }

        render(room) {
          if (!room.board) return;
          var g = this.createGroup();
          var bd = texBox(3.0, 1.8, 0.14, TEX.planks); bd.position.y = 2.2; g.add(bd);
          var lg1 = texBox(0.14, 1.3, 0.14, TEX.bark); lg1.position.set(-1.2, 0.65, 0); g.add(lg1);
          var lg2 = texBox(0.14, 1.3, 0.14, TEX.bark); lg2.position.set(1.2, 0.65, 0); g.add(lg2);
          var s1 = boxMesh(1.8, 0.12, 0.02, 0x3d2a15); s1.position.set(-0.3, 2.6, 0.09); g.add(s1);
          var s2 = boxMesh(1.2, 0.12, 0.02, 0x3d2a15); s2.position.set(-0.6, 2.3, 0.09); g.add(s2);
          var s3 = boxMesh(1.5, 0.12, 0.02, 0x8a4d2a); s3.position.set(-0.45, 2.0, 0.09); g.add(s3);
          this.group = g;
          this.setPosition(room.board.x, 0.2, room.board.z);
          this.setRotation(room.isNorth ? 0 : Math.PI);
          this.mount(house);
          room.boardSpot = this.createSpot(room.board.x + 1.5, room.board.z + (room.isNorth ? 2.2 : -2.2), room.isNorth ? Math.PI : 0, 'board', {
            reactions: ['board-write', 'board-point', 'board-erase'],
          });
        }
      }

      class LobbyFurniture extends FurnitureObject {
        constructor() {
          super('lobby');
        }

        render(room) {
          var rd = new THREE.Group();
          var c1 = tiledBox(6.0, 1.7, 1.2, TEX.stoneBrick, 1.4); c1.position.y = 0.85; rd.add(c1);
          var c2 = tiledBox(6.4, 0.18, 1.5, TEX.planks, 1.4); c2.position.y = 1.78; rd.add(c2);
          rd.position.set(room.cx, 0.2, room.cz + 2.0);
          house.add(rd);
          if (typeof allVisualDecorations !== 'undefined') {
            allVisualDecorations.push({ type: 'reception-desk', x: room.cx, z: room.cz + 2.0 });
          }
          var sx = room.x0 + (room.x1 - room.x0) * 0.26, sz = room.cz - 2.5;
          new SofaAsset(sx, sz - 2, 0, themeValue('furniture.lobbySofaA', 0x7B5BC8)).render();
          new SofaAsset(sx - 3.6, sz + 1.4, Math.PI / 2, themeValue('furniture.lobbySofaB', 0x7B5BC8)).render();
          var ct = texBox(2.0, 0.5, 1.2, TEX.darkPlanks); ct.position.set(sx, 0.65, sz + 0.6); house.add(ct);
          var loungeX = Math.min(room.x1 - 4.2, sx + 4.6);
          var loungeZ = sz - 2.2;
          new LoungeChairAsset(loungeX, loungeZ, -Math.PI / 4, themeValue('furniture.lobbyLoungeChair', 0x3C7BC8)).render();
          new TableAsset('side-table', loungeX + 1.9, loungeZ + 0.8, { topW: 1.0, topD: 1.0, topY: 1.0, baseH: 0.9, baseY: 0.48 }).render();
          var shelfX = room.x1 - 3.1, shelfZ = room.cz + 3.2;
          new ShelfAsset(shelfX, shelfZ, -Math.PI / 2, { w: 2.2, h: 2.4, accent: themeValue('furniture.lobbyShelfAccent', 0xC8963C) }).render();
          rugAt(sx, sz, 3.6, themeValue('furniture.lobbyRug', 0xC8963C));
          zones.lobby.push(assetSpot(sx - 1.2, sz - 2, 0, 'sofa', { sit: true, seatY: -0.45, forward: 0.25, reactions: ['sofa-relax', 'sofa-phone', 'sofa-stretch'] }));
          zones.lobby.push(assetSpot(sx + 1.2, sz - 2, 0, 'sofa', { sit: true, seatY: -0.45, forward: 0.25, reactions: ['sofa-relax', 'sofa-phone', 'sofa-stretch'] }));
          zones.lobby.push(assetSpot(sx - 3.6, sz + 0.4, Math.PI / 2, 'sofa', { sit: true, seatY: -0.45, forward: 0.25, reactions: ['sofa-relax', 'sofa-phone', 'sofa-stretch'] }));
          zones.lobby.push(assetSpot(sx - 3.6, sz + 2.4, Math.PI / 2, 'sofa', { sit: true, seatY: -0.45, forward: 0.25, reactions: ['sofa-relax', 'sofa-phone', 'sofa-stretch'] }));
          zones.lobby.push(assetSpot(loungeX, loungeZ + 0.35, Math.PI * 0.75, 'lounge', { sit: true, seatY: -0.55, forward: 0.18, reactions: ['lounge-read', 'lounge-scroll', 'lounge-nap', 'lounge-wave'] }));
          zones.lobby.push(assetSpot(shelfX - 1.7, shelfZ, Math.PI / 2, 'shelf', { reactions: ['shelf-browse', 'shelf-pick', 'shelf-tidy', 'shelf-point'] }));
          zones.lobby.push({ x: room.cx - 3.2, z: room.cz + 3.4, face: Math.PI, type: 'stand', sit: false, busyBy: null, reactions: ['stand-think', 'stand-scan', 'stand-wave'] });
          plantAt(room.x0 + 2, room.z1 - 2, { variant: 'palm', scale: 1.1, potColor: themeValue('furniture.lobbyPlantPotA', 0x7FA88B) });
          plantAt(room.x1 - 2, room.z0 + 2, { variant: 'round', scale: 1.0, potColor: themeValue('furniture.lobbyPlantPotB', 0xA87F9B) });
          zones.lobby.push(assetSpot(room.x0 + 3.2, room.z1 - 2.1, -Math.PI / 2, 'plant', { reactions: ['plant-water', 'plant-prune', 'plant-smell'] }));
        }
      }

      class MeetingFurniture extends FurnitureObject {
        constructor() {
          super('meeting');
        }

        render(room) {
          var tbl = tiledBox(7.0, 0.25, 2.8, TEX.planks, 1.4); tbl.position.set(room.cx, 1.55, room.cz); house.add(tbl);
          var base = tiledBox(5.6, 1.4, 1.6, TEX.darkPlanks, 1.4); base.position.set(room.cx, 0.7, room.cz); house.add(base);
          for (var i = 0; i < 3; i++) {
            chairAt(room.cx - 2.4 + i * 2.4, room.cz - 2.4, Math.PI, themeValue('furniture.meetingChairA', 0x6f7f8c));
            chairAt(room.cx - 2.4 + i * 2.4, room.cz + 2.4, 0, themeValue('furniture.meetingChairB', 0x6f7f8c));
            zones.meeting.push(assetSpot(room.cx - 2.4 + i * 2.4, room.cz - 2.4, 0, 'meet', { sit: true, seatY: 0.55, forward: 0.36, reactions: ['meet-nod', 'meet-note', 'meet-point'] }));
            zones.meeting.push(assetSpot(room.cx - 2.4 + i * 2.4, room.cz + 2.4, Math.PI, 'meet', { sit: true, seatY: 0.55, forward: 0.36, reactions: ['meet-nod', 'meet-note', 'meet-point'] }));
          }
          var tvZ = room.isNorth ? room.z0 + 0.6 : room.z1 - 0.6;
          var tv = new TvAsset(room.cx, tvZ, room.isNorth ? 0 : Math.PI);
          tv.render();
          var credZ = room.isNorth ? room.z1 - 1.7 : room.z0 + 1.7;
          new ShelfAsset(room.x1 - 2.7, credZ, room.isNorth ? Math.PI : 0, { w: 2.5, h: 1.8, d: 0.5, accent: themeValue('furniture.meetingShelfAccent', 0x5B9E3C) }).render();
          var ideaX = room.x0 + 3.4;
          new StandingDeskAsset(ideaX, room.cz, room.isNorth ? Math.PI / 2 : -Math.PI / 2, { accent: themeValue('furniture.standingDeskMeetingGlow', 0xD99A2E) }).render();
          zones.meeting.push(assetSpot(ideaX + (room.isNorth ? 1.4 : -1.4), room.cz, room.isNorth ? -Math.PI / 2 : Math.PI / 2, 'focus-desk', { reactions: ['desk-type', 'desk-review', 'desk-doodle', 'desk-stand'] }));
          zones.meeting.push(assetSpot(room.x1 - 2.7, credZ + (room.isNorth ? -1.4 : 1.4), room.isNorth ? 0 : Math.PI, 'shelf', { reactions: ['shelf-browse', 'shelf-pick', 'shelf-point'] }));
          plantAt(room.x0 + 2, room.isNorth ? room.z0 + 2 : room.z1 - 2, { variant: 'cactus', scale: 1.0, potColor: themeValue('furniture.meetingPlantPot', 0xC8963C) });
        }
      }

      class PresentationFurniture extends FurnitureObject {
        constructor() {
          super('presentation');
          this.screenMat = null;
        }

        render(room) {
          var scrZ = room.isNorth ? room.z0 + 1.0 : room.z1 - 1.0;
          var big = boxMesh(8.0, 3.0, 0.2, 0x1e2226); big.position.set(room.cx, 2.3, scrZ); house.add(big);
          var cv = document.createElement('canvas');
          cv.width = 256; cv.height = 96;
          var cx2 = cv.getContext('2d');
          cx2.fillStyle = '#10314a'; cx2.fillRect(0, 0, 256, 96);
          cx2.fillStyle = '#e8f0f6'; cx2.font = '700 24px ui-monospace, Menlo, monospace'; cx2.fillText('Q3 ROADMAP', 18, 38);
          cx2.fillStyle = themeValue('furniture.roadmapBarA', '#c8963c'); cx2.fillRect(18, 52, 130, 10);
          cx2.fillStyle = themeValue('furniture.roadmapBarB', '#5b9e3c'); cx2.fillRect(18, 70, 90, 10);
          var bigTex = new THREE.CanvasTexture(cv);
          bigTex.magFilter = THREE.NearestFilter;
          this.screenMat = new THREE.MeshLambertMaterial({ map: bigTex, emissive: 0x223344 });
          var bigScr = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 2.5), this.screenMat);
          bigScr.position.set(room.cx, 2.3, scrZ + (room.isNorth ? 0.14 : -0.14));
          bigScr.rotation.y = room.isNorth ? 0 : Math.PI;
          house.add(bigScr);
          var pod = texBox(1.1, 1.5, 0.9, TEX.darkPlanks);
          pod.position.set(room.cx - 3.6, 0.95, scrZ + (room.isNorth ? 2.4 : -2.4));
          house.add(pod);
          var demoX = room.cx + 3.3, demoZ = scrZ + (room.isNorth ? 2.7 : -2.7);
          new DesignTableAsset(demoX, demoZ, room.isNorth ? 0 : Math.PI, { w: 2.7, d: 1.5, accent: themeValue('furniture.demoTableAccent', 0x3FA1E8) }).render();
          zones.watch.push(assetSpot(demoX, demoZ + (room.isNorth ? 1.65 : -1.65), room.isNorth ? Math.PI : 0, 'design-table', { reactions: ['table-sketch', 'table-build', 'table-point', 'table-photo'] }));
          var rows = 2, cols2 = Math.min(4, Math.floor((room.x1 - room.x0 - 6) / 2.2));
          for (var rr2 = 0; rr2 < rows; rr2++) {
            for (var cc = 0; cc < cols2; cc++) {
              var chx = room.cx - (cols2 - 1) * 1.1 + cc * 2.2;
              var chz = scrZ + (room.isNorth ? 5.0 + rr2 * 2.4 : -(5.0 + rr2 * 2.4));
              chairAt(chx, chz, room.isNorth ? 0 : Math.PI, themeValue('furniture.presentationChair', 0x7f6f8c));
              zones.watch.push(assetSpot(chx, chz, room.isNorth ? Math.PI : 0, 'watch', { sit: true, seatY: 0.55, forward: 0.36, reactions: ['watch-nod', 'watch-clap', 'watch-note'] }));
            }
          }
        }

        update() {
          if (!this.screenMat) return;
          var watchers = zones.watch.some(function (s) { return s.busyBy && s.busyBy.mode === 'act'; });
          this.screenMat.emissive.setHex(watchers ? 0x4a6a8a : 0x223344);
          this.screenMat.emissiveIntensity = watchers ? 0.75 + Math.sin(simClock * 2.4) * 0.15 : 0.28;
        }
      }

      class CoffeeFurniture extends FurnitureObject {
        constructor() {
          super('coffee');
          this.steam = null;
          this.spot = null;
        }

        render(room) {
          var cLen = Math.min(8, (room.x1 - room.x0) - 5);
          var cz2 = room.isNorth ? room.z0 + 2.2 : room.z1 - 2.2;
          var counter = tiledBox(cLen, 1.5, 1.4, TEX.darkPlanks, 1.4); counter.position.set(room.cx, 0.95, cz2); house.add(counter);
          var counterTop = tiledBox(cLen + 0.3, 0.16, 1.7, TEX.planks, 1.4); counterTop.position.set(room.cx, 1.78, cz2); house.add(counterTop);
          var emX = room.cx - cLen / 2 + 1.2;
          var em = texBox(1.2, 1.2, 1.0, TEX.cobble); em.position.set(emX, 2.46, cz2); house.add(em);
          var emBtn = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.08), new THREE.MeshLambertMaterial({ color: themeValue('furniture.espressoButton', 0x3a2b1a), emissive: themeValue('furniture.espressoButtonGlow', 0xa84e1c) }));
          emBtn.position.set(emX, 2.3, cz2 + (room.isNorth ? 0.55 : -0.55)); house.add(emBtn);
          if (typeof allVisualDecorations !== 'undefined') {
            allVisualDecorations.push({ type: 'espresso-machine', x: emX, z: cz2 });
          }
          this.spot = { x: emX, z: cz2 + (room.isNorth ? 1.9 : -1.9), face: room.isNorth ? Math.PI : 0, type: 'brew', sit: false, busyBy: null, reactions: ['brew-press', 'brew-steam', 'brew-sniff'] };
          zones.coffee.push(this.spot);
          this.steam = textSprite('♨️', { fs: 40, scale: 0.018, bg: false });
          this.steam.position.set(emX, 3.4, cz2);
          this.steam.material.opacity = 0;
          scene.add(this.steam);
          var menu = roomPoster('COFFEE BAR', { w: 520, h: 170, fs: 46, bgColor: 'rgba(60,45,30,0.94)', color: '#F5E9D5' });
          menu.position.set(room.cx, 3.25, room.isNorth ? room.z0 + WT + 0.14 : room.z1 - WT - 0.14);
          menu.rotation.y = room.isNorth ? 0 : Math.PI;
          house.add(menu);
          var wcX = room.x1 - 2.4, wcZ = room.isNorth ? room.z0 + 2.4 : room.z1 - 2.4;
          var base = texBox(1.2, 1.1, 1.2, TEX.stone); base.position.set(wcX, 0.75, wcZ); house.add(base);
          var water = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.14, 0.95), new THREE.MeshLambertMaterial({ color: themeValue('furniture.water', 0x3F76E4), transparent: true, opacity: 0.85 }));
          water.position.set(wcX, 1.33, wcZ); house.add(water);
          if (typeof allVisualDecorations !== 'undefined') {
            allVisualDecorations.push({ type: 'water-cooler', x: wcX, z: wcZ });
          }
          zones.cooler.push({ x: wcX, z: wcZ + (room.isNorth ? 1.7 : -1.7), face: room.isNorth ? Math.PI : 0, type: 'drinkwater', sit: false, busyBy: null, reactions: ['drink-sip', 'drink-refill', 'drink-shake'] });
          var snackX = room.x0 + 2.0, snackZ = room.isNorth ? room.z1 - 2.6 : room.z0 + 2.6;
          new ShelfAsset(snackX, snackZ, room.isNorth ? Math.PI : 0, { w: 2.0, h: 1.9, d: 0.48, accent: themeValue('furniture.snackShelfAccent', 0xE8A33C) }).render();
          zones.coffee.push(assetSpot(snackX, snackZ + (room.isNorth ? -1.3 : 1.3), room.isNorth ? 0 : Math.PI, 'snack-shelf', { reactions: ['snack-pick', 'snack-share', 'snack-crunch', 'shelf-tidy'] }));
          for (var i = 0; i < 2; i++) {
            var tx2 = room.x0 + (room.x1 - room.x0) * (0.32 + i * 0.36);
            var tz2 = room.isNorth ? room.cz + 2.4 : room.cz - 2.4;
            new TableAsset('coffee-table', tx2, tz2, { topW: 1.9, topD: 1.9 }).render();
            [[-1.5, 0], [1.5, 0]].forEach(function (o) {
              var st = texBox(0.8, 0.9, 0.8, TEX.darkPlanks);
              st.position.set(tx2 + o[0], 0.65, tz2 + o[1]); house.add(st);
              zones.coffee.push(assetSpot(tx2 + o[0], tz2 + o[1], Math.atan2(-o[0], 0.001), 'stool', { sit: true, seatY: 0.35, reactions: ['stool-sip', 'stool-chat', 'stool-snack'] }));
            });
          }
          rugAt(room.cx, room.cz, 3.2, themeValue('furniture.coffeeRug', 0xc98e5a));
          plantAt(room.x0 + 1.8, room.isNorth ? room.z1 - 2 : room.z0 + 2, { variant: 'round', potColor: themeValue('furniture.coffeePlantPot', 0x5B9E3C) });
        }

        update() {
          if (!this.steam || !this.spot) return;
          var on = this.spot.busyBy && this.spot.busyBy.mode === 'act';
          this.steam.material.opacity += ((on ? 0.9 : 0) - this.steam.material.opacity) * 0.1;
          if (on) this.steam.position.y = 3.4 + (simClock % 1) * 0.5;
        }
      }

      class FunFurniture extends FurnitureObject {
        constructor() {
          super('fun');
          this.arcadeMats = [];
        }

        render(room) {
          for (var i = 0; i < 2; i++) {
            var ax = room.x0 + 2.4 + i * 2.6;
            var az = room.isNorth ? room.z0 + 2.0 : room.z1 - 2.0;
            var cab = boxMesh(1.6, 2.9, 1.2, i ? themeValue('furniture.arcadeCabA', 0x3d4d6b) : themeValue('furniture.arcadeCabB', 0x6b3d5d));
            cab.position.set(ax, 1.65, az); house.add(cab);
            if (typeof allVisualDecorations !== 'undefined') {
              allVisualDecorations.push({
                type: 'arcade',
                x: ax,
                z: az,
                color: i ? themeValue('furniture.arcadeCabA', 0x3d4d6b) : themeValue('furniture.arcadeCabB', 0x6b3d5d)
              });
            }
            var scrM = new THREE.MeshLambertMaterial({ color: 0x101418, emissive: i ? themeValue('furniture.arcadeGlowA', 0x1e8f8f) : themeValue('furniture.arcadeGlowB', 0x8f1e6b) });
            var scr = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.9), scrM);
            scr.position.set(ax, 2.2, az + (room.isNorth ? 0.62 : -0.62));
            scr.rotation.y = room.isNorth ? 0 : Math.PI;
            house.add(scr);
            var spot = assetSpot(ax, az + (room.isNorth ? 1.7 : -1.7), room.isNorth ? Math.PI : 0, 'arcade', { mat: scrM, reactions: ['arcade-mash', 'arcade-lean', 'arcade-cheer'] });
            zones.fun.push(spot);
            this.arcadeMats.push({ mat: scrM, spot: spot });
          }
          var pt = new THREE.Group();
          var felt = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.3, 2.4), texMat(tiledTex(TEX.wool(themeValue('furniture.poolFelt', 0x2e7d53)), 2, 1)));
          felt.castShadow = true; felt.position.y = 1.35; pt.add(felt);
          var rail = tiledBox(4.6, 0.5, 2.8, TEX.darkPlanks, 1.4); rail.position.y = 1.15; pt.add(rail);
          [[-1.9, -1], [1.9, -1], [-1.9, 1], [1.9, 1]].forEach(function (o) {
            var lg = texBox(0.3, 1.1, 0.3, TEX.bark); lg.position.set(o[0], 0.55, o[1]); pt.add(lg);
          });
          var b1 = boxMesh(0.22, 0.22, 0.22, 0xf2efe6); b1.position.set(-0.5, 1.6, 0.2); pt.add(b1);
          var b2 = boxMesh(0.22, 0.22, 0.22, 0xc23b30); b2.position.set(0.4, 1.6, -0.3); pt.add(b2);
          pt.position.set(room.cx + 1.5, 0.2, room.cz + (room.isNorth ? 1.6 : -1.6));
          house.add(pt);
          var ptz = room.cz + (room.isNorth ? 1.6 : -1.6);
          if (typeof allVisualDecorations !== 'undefined') {
            allVisualDecorations.push({
              type: 'pool-table',
              x: room.cx + 1.5,
              z: ptz,
              color: themeValue('furniture.poolFelt', 0x2e7d53)
            });
          }
          zones.fun.push({ x: room.cx + 1.5, z: ptz + 2.6, face: Math.PI, type: 'pool', sit: false, busyBy: null, reactions: ['pool-aim', 'pool-chalk', 'pool-celebrate'] });
          zones.fun.push({ x: room.cx + 1.5, z: ptz - 2.6, face: 0, type: 'pool', sit: false, busyBy: null, reactions: ['pool-aim', 'pool-chalk', 'pool-celebrate'] });
          var makerX = room.x0 + 3.2, makerZ = room.isNorth ? room.z1 - 3.1 : room.z0 + 3.1;
          new DesignTableAsset(makerX, makerZ, room.isNorth ? Math.PI : 0, { w: 3.2, d: 1.7, accent: themeValue('furniture.makerTableAccent', 0xFF7BD1) }).render();
          zones.fun.push(assetSpot(makerX, makerZ + (room.isNorth ? -1.7 : 1.7), room.isNorth ? 0 : Math.PI, 'design-table', { reactions: ['table-sketch', 'table-build', 'table-dice', 'table-highfive'] }));
          var musicX = room.x1 - 2.2, musicZ = room.isNorth ? room.z0 + 2.3 : room.z1 - 2.3;
          var jukebox = new JukeboxAsset(musicX, musicZ, room.isNorth ? 0 : Math.PI);
          jukebox.render();
          var musicSpot = assetSpot(musicX, musicZ + (room.isNorth ? 1.35 : -1.35), room.isNorth ? Math.PI : 0, 'jukebox', { mat: jukebox.glowMats[0], reactions: ['jukebox-pick', 'jukebox-dance', 'jukebox-bop', 'jukebox-airdrum'] });
          zones.fun.push(musicSpot);
          this.arcadeMats.push({ mat: jukebox.glowMats[0], spot: musicSpot });
          [[-0.32, 2.6], [0.4, 4.0]].forEach(function (o, i2) {
            var bb = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 1.6), texMat(TEX.wool(i2 ? themeValue('furniture.beanbagA', 0xC8963C) : themeValue('furniture.beanbagB', 0x5B9E3C))));
            var bx = room.x1 - 3 + o[0], bz = (room.isNorth ? room.z1 - 4 : room.z0 + 4) + (room.isNorth ? -o[1] + 2 : o[1] - 2);
            bb.position.set(bx, 0.72, bz);
            bb.castShadow = true;
            house.add(bb);
            if (typeof allVisualDecorations !== 'undefined') {
              allVisualDecorations.push({
                type: 'beanbag',
                x: bx,
                z: bz,
                color: i2 ? themeValue('furniture.beanbagA', 0xC8963C) : themeValue('furniture.beanbagB', 0x5B9E3C)
              });
            }
            zones.fun.push(assetSpot(bx, bz, room.isNorth ? Math.PI : 0, 'bean', { sit: true, seatY: -0.95, reactions: ['bean-lounge', 'bean-phone', 'bean-think'] }));
          });
          var neon = roomPoster('★ ARCADE ★', { w: 560, h: 180, fs: 52, bgColor: 'rgba(20,10,26,0.94)', color: '#FF7BD1' });
          neon.position.set(room.cx, 3.35, room.isNorth ? room.z0 + WT + 0.14 : room.z1 - WT - 0.14);
          neon.rotation.y = room.isNorth ? 0 : Math.PI;
          house.add(neon);
          plantAt(room.x0 + 1.6, room.isNorth ? room.z0 + 4.2 : room.z1 - 4.2, { variant: 'palm', scale: 0.95, potColor: themeValue('furniture.funPlantPot', 0x3C7BC8) });
          rugAt(room.cx, room.cz, 3.4, themeValue('furniture.funRug', 0x8a7fa8));
        }

        update() {
          this.arcadeMats.forEach(function (cab, i) {
            var playing = cab.spot.busyBy && cab.spot.busyBy.mode === 'act';
            cab.mat.emissiveIntensity = playing ? 0.9 + Math.sin(simClock * 9 + i) * 0.35 : 0.45;
          });
        }
      }

      class DeptFurniture extends FurnitureObject {
        constructor() {
          super('dept');
        }

        render(room) {
          room.desks.forEach(function (desk) {
            registerFurniture(room, createDeskFurniture(desk));
          });
          registerFurniture(room, createBoardFurniture());
          var collabX = room.x0 + 3.4, collabZ = room.isNorth ? room.z0 + 3.2 : room.z1 - 3.2;
          new StandingDeskAsset(collabX, collabZ, room.isNorth ? Math.PI : 0, { accent: themeValue('furniture.deptStandingDeskGlow', 0x3FA1E8) }).render();
          zones.meeting.push(assetSpot(collabX, collabZ + (room.isNorth ? 1.35 : -1.35), room.isNorth ? Math.PI : 0, 'focus-desk', { reactions: ['desk-type', 'desk-review', 'desk-doodle', 'desk-stand'] }));
          plantAt(room.x1 - 2, room.isNorth ? room.z1 - 2.6 : room.z0 + 2.6, { variant: room.desks.length % 2 ? 'cactus' : 'round', potColor: themeValue('furniture.deptPlantPot', 0x7FA88B) });
          rugAt(room.cx, room.cz, Math.min(4.2, (room.x1 - room.x0) / 4), themeValue('furniture.deptRug', 0xb99a6e));
        }
      }

      class CartFurniture extends FurnitureObject {
        constructor() {
          super('cart');
          this.cart = null;
          this.dir = 1;
        }

        render() {
          var cart = new THREE.Group();
          var cb = boxMesh(2.0, 0.9, 1.2, 0x6E6E6E); cb.position.y = 0.85; cart.add(cb);
          var cbIn = boxMesh(1.7, 0.2, 0.95, 0x3a3a3a); cbIn.position.y = 1.32; cart.add(cbIn);
          var cm1 = texBox(0.8, 0.6, 0.8, TEX.planks); cm1.position.set(-0.3, 1.7, 0); cart.add(cm1);
          var cm2 = texBox(0.8, 0.8, 0.8, TEX.planks); cm2.position.set(0.55, 1.8, 0); cart.add(cm2);
          var cw1 = boxMesh(0.5, 0.5, 0.2, 0x2b2b2b);
          cw1.position.set(-0.7, 0.32, 0.62); cart.add(cw1);
          var cw2 = cw1.clone(); cw2.position.set(0.7, 0.32, 0.62); cart.add(cw2);
          var cw3 = cw1.clone(); cw3.position.set(-0.7, 0.32, -0.62); cart.add(cw3);
          var cw4 = cw1.clone(); cw4.position.set(0.7, 0.32, -0.62); cart.add(cw4);
          var eye = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshLambertMaterial({ color: 0x222222, emissive: 0x44ddff }));
          eye.position.set(1.05, 1.35, 0); cart.add(eye);
          cart.position.set(-W / 2 + 6, 0.2, 0);
          scene.add(cart);
          this.cart = cart;
          this.dir = 1;
        }

        update(dt) {
          if (!this.cart) return;
          this.cart.position.x += this.dir * dt * 3.2;
          this.cart.rotation.y = this.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
          if (this.cart.position.x > W / 2 - 6) this.dir = -1;
          if (this.cart.position.x < -W / 2 + 6) this.dir = 1;
        }
      }

      function registerFurniture(room, item) {
        if (room && room.furniture) room.furniture.push(item);
        furnitureObjects.push(item);
        item.render(room);
        return item;
      }

      function assetSpot(x, z, face, type, opts) {
        return new ReactableAsset('spot').createSpot(x, z, face, type, opts);
      }

      function plantAt(x, z, opts) {
        return new PlantAsset(x, z, opts).render();
      }

      function rugAt(x, z, rad, color) {
        return new RugAsset(x, z, rad, color).render();
      }

      function chairAt(x, z, rotY, color) {
        return new ChairAsset(x, z, rotY, color).render();
      }

      function createDeskFurniture(desk) { return new DeskFurniture(desk); }
      function createBoardFurniture() { return new BoardFurniture(); }
      function createLobbyFurniture() { return new LobbyFurniture(); }
      function createMeetingFurniture() { return new MeetingFurniture(); }
      function createPresentationFurniture() { return new PresentationFurniture(); }
      function createCoffeeFurniture() { return new CoffeeFurniture(); }
      function createFunFurniture() { return new FunFurniture(); }
      function createDeptFurniture() { return new DeptFurniture(); }
      function createCartFurniture() { return new CartFurniture(); }

      function textSprite(text, opts) {
        opts = opts || {};
        var cv = document.createElement('canvas');
        var cx = cv.getContext('2d');
        var fs = opts.fs || 34;
        var font = '700 ' + fs + 'px ui-monospace, Menlo, Consolas, monospace';
        cx.font = font;
        var tw = cx.measureText(text).width;
        cv.width = Math.ceil(tw + 36); cv.height = fs + 26;
        cx = cv.getContext('2d');
        cx.font = font;
        if (opts.bg !== false) {
          cx.fillStyle = opts.bgColor || 'rgba(20,25,30,0.78)';
          cx.fillRect(0, 0, cv.width, cv.height);
          cx.strokeStyle = 'rgba(0,0,0,0.45)';
          cx.lineWidth = 4;
          cx.strokeRect(2, 2, cv.width - 4, cv.height - 4);
        }
        cx.fillStyle = opts.color || '#F2F4F0';
        cx.textBaseline = 'middle';
        cx.fillText(text, 18, cv.height / 2 + 2);
        var tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = 4;
        var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
        var sc = (opts.scale || 0.055);
        sp.scale.set(cv.width * sc, cv.height * sc, 1);
        return sp;
      }

      function roomLabelMat(text, opts) {
        opts = opts || {};
        var cv = document.createElement('canvas');
        var cx = cv.getContext('2d');
        var fs = opts.fs || 34;
        var font = '700 ' + fs + 'px ui-monospace, Menlo, Consolas, monospace';
        cx.font = font;
        var tw = cx.measureText(text).width;
        cv.width = Math.ceil(tw + 48);
        cv.height = fs + 34;
        cx = cv.getContext('2d');
        cx.font = font;
        cx.fillStyle = opts.bgColor || 'rgba(20,25,30,0.82)';
        cx.fillRect(0, 0, cv.width, cv.height);
        cx.strokeStyle = 'rgba(0,0,0,0.48)';
        cx.lineWidth = 4;
        cx.strokeRect(2, 2, cv.width - 4, cv.height - 4);
        cx.fillStyle = opts.color || '#F2F4F0';
        cx.textBaseline = 'middle';
        cx.fillText(text, 24, cv.height / 2 + 2);
        var tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = 4;
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        var mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
        var mesh = new THREE.Mesh(new THREE.PlaneGeometry(cv.width * 0.03, cv.height * 0.03), mat);
        mesh.rotation.x = -Math.PI / 2;
        return mesh;
      }

      function roomPoster(text, opts) {
        opts = opts || {};
        var cv = document.createElement('canvas');
        var cx = cv.getContext('2d');
        var w = opts.w || 420;
        var h = opts.h || 180;
        cv.width = w;
        cv.height = h;
        cx.fillStyle = opts.bgColor || 'rgba(91,158,60,0.92)';
        cx.fillRect(0, 0, w, h);
        cx.strokeStyle = 'rgba(255,255,255,0.24)';
        cx.lineWidth = 8;
        cx.strokeRect(6, 6, w - 12, h - 12);
        cx.fillStyle = opts.color || '#F2F4F0';
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        cx.font = (opts.fs || 54) + 'px ui-monospace, Menlo, Consolas, monospace';
        cx.fillText(text, w / 2, h / 2 + 2);
        var tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = 4;
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        var poster = new THREE.Mesh(
          new THREE.PlaneGeometry(w * 0.01, h * 0.01),
          new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
        );
        var frame = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.01 + 0.18, h * 0.01 + 0.18, 0.08),
          new THREE.MeshLambertMaterial({ color: 0x6b563a })
        );
        var group = new THREE.Group();
        group.add(frame);
        poster.position.z = 0.055;
        group.add(poster);
        return group;
      }
