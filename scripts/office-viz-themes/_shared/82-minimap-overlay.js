      // ---- minimap overlay ------------------------------------------------------------------
      var minimapCanvas = null;
      var minimapCtx = null;
      var minimapStyle = null;
      var minimapHitRadius = 10;

      function cssColorForState(state) {
        if (STATE_CSS[state]) return STATE_CSS[state];
        var hex = STATE_HEX[state] || 0x9aa0a4;
        return '#' + ('000000' + hex.toString(16)).slice(-6);
      }

      function minimapBounds() {
        var streetLen = Math.max(18, D * 0.22);
        return {
          x0: -W / 2,
          x1: W / 2,
          z0: -D / 2,
          z1: Math.max(D / 2, lobbyRoom ? lobbyRoom.z1 + streetLen : D / 2),
        };
      }

      function minimapProject(x, z, box, pad, ww, hh) {
        var bw = box.x1 - box.x0;
        var bh = box.z1 - box.z0;
        var scale = Math.min((ww - pad * 2) / bw, (hh - pad * 2) / bh);
        var ox = (ww - bw * scale) / 2;
        var oy = (hh - bh * scale) / 2;
        return {
          x: ox + (x - box.x0) * scale,
          y: oy + (z - box.z0) * scale,
          scale: scale,
        };
      }

      function drawMinimapDiamond(cx, cy, size, fill, stroke, lineWidth) {
        minimapCtx.save();
        minimapCtx.translate(cx, cy);
        minimapCtx.rotate(Math.PI / 4);
        minimapCtx.fillStyle = fill;
        minimapCtx.fillRect(-size / 2, -size / 2, size, size);
        minimapCtx.strokeStyle = stroke;
        minimapCtx.lineWidth = lineWidth;
        minimapCtx.strokeRect(-size / 2, -size / 2, size, size);
        minimapCtx.restore();
      }

      function syncMinimapSize() {
        if (!minimapCanvas) return false;
        var rect = minimapCanvas.getBoundingClientRect();
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        var w = Math.max(120, Math.round(rect.width));
        var h = Math.max(90, Math.round(rect.height));
        var pxW = Math.round(w * dpr);
        var pxH = Math.round(h * dpr);
        if (minimapCanvas.width !== pxW || minimapCanvas.height !== pxH) {
          minimapCanvas.width = pxW;
          minimapCanvas.height = pxH;
        }
        minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w: w, h: h };
      }

      function hexToRgba(hex, opacity) {
        var r = (hex >> 16) & 255;
        var g = (hex >> 8) & 255;
        var b = hex & 255;
        return 'rgba(' + r + ',' + g + ',' + b + ',' + opacity + ')';
      }

      function drawOfficeMinimap() {
        if (!minimapCtx) return;
        var size = syncMinimapSize();
        if (!size) return;
        var w = size.w, h = size.h;
        var pad = 9;
        var box = minimapBounds();
        minimapCtx.clearRect(0, 0, w, h);

        // 1. Draw background card
        minimapCtx.fillStyle = 'rgba(8,12,16,0.86)';
        minimapCtx.fillRect(0, 0, w, h);

        // 2. Draw surrounding lawn (grass lot) using actual theme grass color
        var grassCol = themeValue('textures.grass', 0x6DA24E);
        minimapCtx.fillStyle = hexToRgba(grassCol, 0.28);
        minimapCtx.fillRect(0, 0, w, h);

        // 3. Draw trees outside the building
        if (typeof trees !== 'undefined' && Array.isArray(trees)) {
          trees.forEach(function (tree) {
            var p = minimapProject(tree.position.x, tree.position.z, box, pad, w, h);
            minimapCtx.fillStyle = 'rgba(78, 138, 53, 0.65)';
            minimapCtx.beginPath();
            minimapCtx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            minimapCtx.fill();
          });
        }

        // 4. Draw entrance path (cobble)
        if (lobbyRoom) {
          var pathStart = minimapProject(lobbyRoom.cx - 2.3, lobbyRoom.z1, box, pad, w, h);
          var pathEnd = minimapProject(lobbyRoom.cx + 2.3, box.z1, box, pad, w, h);
          var px = Math.min(pathStart.x, pathEnd.x);
          var py = Math.min(pathStart.y, pathEnd.y);
          var pw = Math.abs(pathEnd.x - pathStart.x);
          var ph = Math.abs(pathEnd.y - pathStart.y);
          minimapCtx.fillStyle = hexToRgba(themeValue('textures.cobble', 0x7E7E7E), 0.85);
          minimapCtx.fillRect(px, py, pw, ph);
          minimapCtx.strokeStyle = 'rgba(255,255,255,0.18)';
          minimapCtx.lineWidth = 1;
          minimapCtx.strokeRect(px + 0.5, py + 0.5, Math.max(1, pw - 1), Math.max(1, ph - 1));
        }

        // 5. Draw building background bounds
        var a = minimapProject(-W / 2, -D / 2, box, pad, w, h);
        var b = minimapProject(W / 2, D / 2, box, pad, w, h);
        var bx = Math.min(a.x, b.x), by = Math.min(a.y, b.y);
        var bw = Math.abs(b.x - a.x), bh = Math.abs(b.y - a.y);
        // Outer walls border line
        minimapCtx.strokeStyle = 'rgba(255,255,255,0.34)';
        minimapCtx.lineWidth = 1.5;
        minimapCtx.strokeRect(bx + 0.5, by + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1));

        // 6. Draw corridor floor (stone)
        var c0 = minimapProject(-W / 2, -CORR / 2, box, pad, w, h);
        var c1 = minimapProject(W / 2, CORR / 2, box, pad, w, h);
        var cx0 = Math.min(c0.x, c1.x), cy0 = Math.min(c0.y, c1.y);
        var cw0 = Math.abs(c1.x - c0.x), ch0 = Math.abs(c1.y - c0.y);
        var stoneCol = themeValue('textures.stone', 0x8C8C8C);
        minimapCtx.fillStyle = hexToRgba(stoneCol, 0.7);
        minimapCtx.fillRect(cx0, cy0, cw0, ch0);

        // 7. Draw corridor runner carpet (red wool)
        if (DEC.rugs !== false) {
          var run0 = minimapProject(-W * 0.86 / 2, -1.1, box, pad, w, h);
          var run1 = minimapProject(W * 0.86 / 2, 1.1, box, pad, w, h);
          minimapCtx.fillStyle = hexToRgba(themeValue('world.runner', 0xA43535), 0.85);
          minimapCtx.fillRect(
            Math.min(run0.x, run1.x),
            Math.min(run0.y, run1.y),
            Math.abs(run1.x - run0.x),
            Math.abs(run1.y - run0.y)
          );
        }

        // 8. Draw rooms with their exact floor colors & boundaries
        rooms.forEach(function (room, idx) {
          var p0 = minimapProject(room.x0, room.z0, box, pad, w, h);
          var p1 = minimapProject(room.x1, room.z1, box, pad, w, h);
          var rx = Math.min(p0.x, p1.x), ry = Math.min(p0.y, p1.y);
          var rw = Math.abs(p1.x - p0.x), rh = Math.abs(p1.y - p0.y);

          // Get floor color
          var floorColorVal;
          if (room.kind === 'coffee' || room.kind === 'lobby' || room.kind === 'fun') {
            floorColorVal = themeValue('textures.planks', 0xB08A54);
          } else {
            floorColorVal = room.kind === 'dept'
              ? DEPT_FLOORS[idx % DEPT_FLOORS.length]
              : DEPT_FLOORS[(idx + 2) % DEPT_FLOORS.length];
          }

          minimapCtx.fillStyle = hexToRgba(floorColorVal, 0.75);
          minimapCtx.fillRect(rx, ry, rw, rh);

          // Accent color for inner borders/walls
          var accentVal = ACCENTS[idx % ACCENTS.length];
          minimapCtx.strokeStyle = hexToRgba(accentVal, 0.6);
          minimapCtx.lineWidth = 1;
          minimapCtx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, rw - 1), Math.max(1, rh - 1));

          // Draw door gap indicators
          if (room.door) {
            var d = minimapProject(room.door.x, room.door.zIn, box, pad, w, h);
            minimapCtx.fillStyle = '#ffffff';
            minimapCtx.fillRect(d.x - 2, d.y - 2, 4, 4);
          }
        });

        // 9. Draw decorations (Rugs first, then furniture/plants/chairs)
        if (typeof allVisualDecorations !== 'undefined' && Array.isArray(allVisualDecorations)) {
          // Rugs
          allVisualDecorations.forEach(function (dec) {
            if (dec.type !== 'rug') return;
            var p = minimapProject(dec.x, dec.z, box, pad, w, h);
            var rad = dec.rad * p.scale;
            minimapCtx.fillStyle = hexToRgba(dec.color, 0.35);
            minimapCtx.fillRect(p.x - rad * 0.9, p.y - rad * 0.9, rad * 1.8, rad * 1.8);
            minimapCtx.strokeStyle = hexToRgba(dec.color, 0.6);
            minimapCtx.lineWidth = 1;
            minimapCtx.strokeRect(p.x - rad * 0.9 + 0.5, p.y - rad * 0.9 + 0.5, Math.max(1, rad * 1.8 - 1), Math.max(1, rad * 1.8 - 1));
          });

          // Main furniture: desks, sofas, tables, shelves, jukebox, pool-table, arcade, etc.
          allVisualDecorations.forEach(function (dec) {
            var p = minimapProject(dec.x, dec.z, box, pad, w, h);
            var sc = p.scale;
            if (dec.type === 'desk') {
              var dw = 1.75 * sc, dh = 0.9 * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.planks', 0xB08A54), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              minimapCtx.strokeStyle = 'rgba(0,0,0,0.2)';
              minimapCtx.strokeRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'standing-desk') {
              var dw = 2.2 * sc, dh = 1.0 * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.darkPlanks', 0x6E4E2C), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              minimapCtx.strokeStyle = 'rgba(0,0,0,0.2)';
              minimapCtx.strokeRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'sofa') {
              var rotated = Math.abs(Math.sin(dec.rotationY)) > 0.5;
              var dw = (rotated ? 1.8 : 5.2) * sc;
              var dh = (rotated ? 5.2 : 1.8) * sc;
              minimapCtx.fillStyle = hexToRgba(dec.color, 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              minimapCtx.strokeStyle = 'rgba(255,255,255,0.25)';
              minimapCtx.strokeRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'coffee-table' || dec.type === 'side-table' || dec.type === 'table') {
              var dw = (dec.topW || 2.0) * sc;
              var dh = (dec.topD || 1.2) * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.planks', 0xB08A54), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              minimapCtx.strokeStyle = 'rgba(0,0,0,0.15)';
              minimapCtx.strokeRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'design-table') {
              var dw = (dec.w || 3.4) * sc;
              var dh = (dec.d || 1.8) * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.planks', 0xB08A54), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              minimapCtx.strokeStyle = 'rgba(0,0,0,0.15)';
              minimapCtx.strokeRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'shelf') {
              var rotated = Math.abs(Math.sin(dec.rotationY)) > 0.5;
              var dw = (rotated ? (dec.d || 0.58) : (dec.w || 2.6)) * sc;
              var dh = (rotated ? (dec.w || 2.6) : (dec.d || 0.58)) * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.darkPlanks', 0x6E4E2C), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              minimapCtx.strokeStyle = 'rgba(0,0,0,0.2)';
              minimapCtx.strokeRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'reception-desk') {
              var dw = 6.4 * sc, dh = 1.5 * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.planks', 0xB08A54), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              minimapCtx.strokeStyle = 'rgba(0,0,0,0.2)';
              minimapCtx.strokeRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'espresso-machine') {
              var dw = 1.2 * sc, dh = 1.0 * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.cobble', 0x7E7E7E), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'water-cooler') {
              var dw = 1.2 * sc, dh = 1.2 * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.stone', 0x8C8C8C), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'arcade') {
              var dw = 1.6 * sc, dh = 1.2 * sc;
              minimapCtx.fillStyle = hexToRgba(dec.color, 0.95);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              minimapCtx.strokeStyle = '#ffffff';
              minimapCtx.lineWidth = 1;
              minimapCtx.strokeRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'jukebox') {
              var dw = 1.6 * sc, dh = 1.1 * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('furniture.jukeboxCab', 0x3a2b1a), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
            } else if (dec.type === 'pool-table') {
              var dw = 4.6 * sc, dh = 2.8 * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.darkPlanks', 0x6E4E2C), 0.9);
              minimapCtx.fillRect(p.x - dw / 2, p.y - dh / 2, dw, dh);
              var fw = 4.2 * sc, fh = 2.4 * sc;
              minimapCtx.fillStyle = hexToRgba(dec.color, 0.9);
              minimapCtx.fillRect(p.x - fw / 2, p.y - fh / 2, fw, fh);
            }
          });

          // Chairs, Stools, and Beanbags
          allVisualDecorations.forEach(function (dec) {
            var p = minimapProject(dec.x, dec.z, box, pad, w, h);
            var sc = p.scale;
            if (dec.type === 'chair') {
              var cw = 1.0 * sc, ch = 1.0 * sc;
              minimapCtx.fillStyle = hexToRgba(dec.color, 0.85);
              minimapCtx.fillRect(p.x - cw / 2, p.y - ch / 2, cw, ch);
              minimapCtx.strokeStyle = 'rgba(0,0,0,0.15)';
              minimapCtx.strokeRect(p.x - cw / 2, p.y - ch / 2, cw, ch);
            } else if (dec.type === 'lounge-chair') {
              var rotated = Math.abs(Math.sin(dec.rotationY)) > 0.5;
              var cw = (rotated ? 1.45 : 1.5) * sc;
              var ch = (rotated ? 1.5 : 1.45) * sc;
              minimapCtx.fillStyle = hexToRgba(dec.color, 0.85);
              minimapCtx.fillRect(p.x - cw / 2, p.y - ch / 2, cw, ch);
              minimapCtx.strokeStyle = 'rgba(255,255,255,0.15)';
              minimapCtx.strokeRect(p.x - cw / 2, p.y - ch / 2, cw, ch);
            } else if (dec.type === 'stool') {
              var cw = 0.8 * sc, ch = 0.8 * sc;
              minimapCtx.fillStyle = hexToRgba(themeValue('textures.darkPlanks', 0x6E4E2C), 0.85);
              minimapCtx.fillRect(p.x - cw / 2, p.y - ch / 2, cw, ch);
              minimapCtx.strokeStyle = 'rgba(0,0,0,0.15)';
              minimapCtx.strokeRect(p.x - cw / 2, p.y - ch / 2, cw, ch);
            } else if (dec.type === 'beanbag') {
              var cw = 1.6 * sc;
              minimapCtx.fillStyle = hexToRgba(dec.color, 0.85);
              minimapCtx.beginPath();
              minimapCtx.arc(p.x, p.y, cw / 2, 0, Math.PI * 2);
              minimapCtx.fill();
              minimapCtx.strokeStyle = 'rgba(255,255,255,0.2)';
              minimapCtx.stroke();
            }
          });

          // Plants (always on top of tables/rugs)
          allVisualDecorations.forEach(function (dec) {
            if (dec.type !== 'plant') return;
            var p = minimapProject(dec.x, dec.z, box, pad, w, h);
            var sc = p.scale;
            var rad = (dec.scale || 1.0) * 1.0 * sc;

            minimapCtx.fillStyle = 'rgba(78, 138, 53, 0.85)';
            minimapCtx.beginPath();
            minimapCtx.arc(p.x, p.y, rad, 0, Math.PI * 2);
            minimapCtx.fill();

            var potColor = dec.potColor || 0x7FA88B;
            minimapCtx.fillStyle = hexToRgba(potColor, 1.0);
            minimapCtx.fillRect(p.x - 0.35 * sc, p.y - 0.35 * sc, 0.7 * sc, 0.7 * sc);
          });
        }

        var selectedPoint = null;
        agents.forEach(function (agent) {
          if (!agent || agent.remove) return;
          var p = minimapProject(agent.x, agent.z, box, pad, w, h);
          var fill = cssColorForState(agent.def && agent.def.state);
          var stroke = agent === selected ? '#ff2d2d' : 'rgba(255,255,255,0.72)';
          var lineWidth = agent === selected ? 2.6 : 1;
          drawMinimapDiamond(p.x, p.y, agent === selected ? 9 : 6.5, fill, stroke, lineWidth);
          if (agent === selected) selectedPoint = p;
        });

        if (selectedPoint) {
          minimapCtx.save();
          minimapCtx.strokeStyle = '#ff2d2d';
          minimapCtx.lineWidth = 2;
          minimapCtx.shadowColor = '#ff2d2d';
          minimapCtx.shadowBlur = 8;
          minimapCtx.beginPath();
          minimapCtx.arc(selectedPoint.x, selectedPoint.y, 10.5, 0, Math.PI * 2);
          minimapCtx.stroke();
          minimapCtx.restore();
        }
      }

      function pickMinimapAgent(e) {
        if (!minimapCanvas) return null;
        var rect = minimapCanvas.getBoundingClientRect();
        var w = Math.max(120, rect.width);
        var h = Math.max(90, rect.height);
        var px = e.clientX - rect.left;
        var py = e.clientY - rect.top;
        var box = minimapBounds();
        var best = null, bestD = Infinity;
        agents.forEach(function (agent) {
          if (!agent || agent.remove) return;
          var p = minimapProject(agent.x, agent.z, box, 9, w, h);
          var d = Math.hypot(px - p.x, py - p.y);
          if (d < bestD) { bestD = d; best = agent; }
        });
        return bestD <= minimapHitRadius ? best : null;
      }

      function selectFromMinimap(agent) {
        lastUserInput = performance.now();
        if (agent) {
          if (agent !== selected && !selected) {
            prevView = { r: want.r, phi: want.phi, theta: want.theta, target: want.target.clone() };
          }
          selected = agent;
        } else if (selected) {
          deselect();
        }
        updatePanel();
        drawOfficeMinimap();
      }

      function initOfficeMinimap() {
        if (!sceneEl || minimapCanvas) return;
        minimapStyle = document.createElement('style');
        minimapStyle.textContent = [
          '.office-minimap{position:absolute;left:10px;top:50px;z-index:5;width:178px;height:132px;opacity:0.9;',
          'border:1px solid rgba(255,255,255,.18);border-radius:8px;overflow:hidden;',
          'background:rgba(8,12,16,.72);backdrop-filter:blur(5px);box-shadow:0 6px 18px rgba(0,0,0,.32)}',
          '.office-minimap canvas{display:block;width:100%;height:100%;cursor:pointer}',
          '.office-minimap.fullscreen{width:24vw;height:18vw;min-width:200px;min-height:150px;max-width:380px;max-height:285px;top:60px;left:15px}',
          '@media (max-width:700px){.office-minimap{top:58px;width:140px;height:106px}}',
        ].join('');
        document.head.appendChild(minimapStyle);

        var wrap = document.createElement('div');
        wrap.className = 'office-minimap';
        wrap.setAttribute('aria-hidden', 'true');
        minimapCanvas = document.createElement('canvas');
        wrap.appendChild(minimapCanvas);
        sceneEl.appendChild(wrap);
        minimapCtx = minimapCanvas.getContext('2d');
        minimapCanvas.addEventListener('pointermove', function (e) {
          minimapCanvas.style.cursor = pickMinimapAgent(e) ? 'pointer' : 'default';
        });
        minimapCanvas.addEventListener('pointerleave', function () {
          minimapCanvas.style.cursor = 'default';
        });
        minimapCanvas.addEventListener('click', function (e) {
          selectFromMinimap(pickMinimapAgent(e));
        });
        drawOfficeMinimap();
      }

      function updateOfficeMinimap() {
        if (!minimapCanvas) initOfficeMinimap();
        if (minimapCanvas) {
          var wrap = minimapCanvas.parentNode;
          if (wrap) {
            var fs = typeof isFs === 'function' ? isFs() : false;
            if (fs) {
              wrap.classList.add('fullscreen');
            } else {
              wrap.classList.remove('fullscreen');
            }
          }
        }
        drawOfficeMinimap();
      }
