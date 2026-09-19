      // ---- camera controls -----------------------------------------------------------------
      var target = new THREE.Vector3(0, 1.5, 0);
      var isoR = Math.max(72, Math.max(W, D) * 0.92);
      var sph = { r: isoR, phi: 0.98, theta: 0.62 };
      var want = { r: isoR, phi: 0.98, theta: 0.62, target: target.clone() };
      var tour = false, lastUserInput = 0;
      var selected = null, prevView = null;

      var VIEWS = {
        iso: { r: isoR, phi: 0.98, theta: 0.62, target: new THREE.Vector3(0, 1.5, 0) },
        top: { r: isoR + 20, phi: 0.14, theta: 0, target: new THREE.Vector3(0, 0, 0) },
        street: { r: 30, phi: 1.42, theta: Math.PI, target: new THREE.Vector3(lobbyRoom.cx, 2.4, D / 2) },
      };
      function applyView(name) {
        var v = VIEWS[name];
        if (!v) return;
        want.r = v.r; want.phi = v.phi; want.theta = v.theta; want.target.copy(v.target);
      }
      function updateCamera(dt) {
        if (tour && performance.now() - lastUserInput > 1000 && !selected) want.theta += dt * 0.07;
        if (selected) {
          var a = selected;
          want.target.lerp(new THREE.Vector3(a.x, 2.2, a.z), Math.min(1, dt * 4));
          want.r += (16 - want.r) * Math.min(1, dt * 3);
          want.phi += (1.12 - want.phi) * Math.min(1, dt * 3);
        }
        var k = Math.min(1, dt * 7);
        sph.r += (want.r - sph.r) * k;
        sph.phi += (want.phi - sph.phi) * k;
        sph.theta += (want.theta - sph.theta) * k;
        target.lerp(want.target, k);
        sph.phi = Math.max(0.12, Math.min(1.52, sph.phi));
        sph.r = Math.max(9, Math.min(180, sph.r));
        camera.position.set(
          target.x + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
          target.y + sph.r * Math.cos(sph.phi),
          target.z + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta)
        );
        camera.lookAt(target);
      }
      var dragBtn = -1, px = 0, py = 0, moved = 0, pinch0 = 0;
      canvas.addEventListener('pointerdown', function (e) {
        dragBtn = e.button; px = e.clientX; py = e.clientY; moved = 0;
        lastUserInput = performance.now();
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', function (e) {
        lastUserInput = performance.now();
        if (dragBtn === -1) { hover(e); return; }
        var dx = e.clientX - px, dy = e.clientY - py;
        px = e.clientX; py = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
        if (dragBtn === 2 || e.shiftKey) {
          var panScale = sph.r / 500;
          var fwd = new THREE.Vector3(Math.sin(sph.theta), 0, Math.cos(sph.theta));
          var rt = new THREE.Vector3(fwd.z, 0, -fwd.x);
          want.target.addScaledVector(rt, dx * panScale);
          want.target.addScaledVector(fwd, dy * panScale);
          if (selected) { selected = null; updatePanel(); }
        } else {
          want.theta -= dx * 0.006;
          want.phi -= dy * 0.005;
          want.phi = Math.max(0.12, Math.min(1.52, want.phi));
        }
      });
      window.addEventListener('pointerup', function () { dragBtn = -1; });
      canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      canvas.addEventListener('wheel', function (e) {
        e.preventDefault();
        lastUserInput = performance.now();
        want.r *= 1 + e.deltaY * 0.0011;
        want.r = Math.max(9, Math.min(180, want.r));
      }, { passive: false });
      canvas.addEventListener('touchmove', function (e) {
        if (e.touches.length === 2) {
          var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
          if (pinch0) { want.r *= pinch0 / d; want.r = Math.max(9, Math.min(180, want.r)); }
          pinch0 = d;
        }
      }, { passive: true });
      canvas.addEventListener('touchend', function () { pinch0 = 0; });

      // ---- picking / tooltip / panel -------------------------------------------------------
      var ray = new THREE.Raycaster();
      var mouseV = new THREE.Vector2();
      function pick(e) {
        var b = canvas.getBoundingClientRect();
        mouseV.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
        ray.setFromCamera(mouseV, camera);
        var meshes = [];
        agents.forEach(function (a) { meshes.push(a.body, a.head); });
        var hits = ray.intersectObjects(meshes, false);
        if (!hits.length) return null;
        return agents[hits[0].object.userData.agentIdx] || null;
      }
      var hovered = null;
      function hover(e) {
        var a = pick(e);
        canvas.style.cursor = a ? 'pointer' : 'default';
        if (hovered && hovered !== a) hovered.label.visible = false;
        hovered = a;
        if (!a) { tipEl.style.display = 'none'; return; }
        a.label.visible = true;
        var d = a.def;
        tipEl.innerHTML = '<b>' + escHTML(d.name) + ' — ' + escHTML(STATE_LABEL[d.state] || d.state) + '</b>' +
          escHTML(d.title || '') +
          (d.issue ? '<br>latest: ' + escHTML(d.issue) : '') +
          (d.jira ? '<br>card: ' + escHTML(d.jira) : '');
        tipEl.style.display = 'block';
        var sb = sceneEl.getBoundingClientRect();
        var tx = e.clientX - sb.left + 14, ty = e.clientY - sb.top + 8;
        if (tx > sb.width - 270) tx = sb.width - 270;
        tipEl.style.left = tx + 'px'; tipEl.style.top = ty + 'px';
      }
      canvas.addEventListener('pointerleave', function () { tipEl.style.display = 'none'; if (hovered) { hovered.label.visible = false; hovered = null; } });
      canvas.addEventListener('click', function (e) {
        if (moved > 6) return;
        var a = pick(e);
        if (a && a !== selected) {
          if (!selected) prevView = { r: want.r, phi: want.phi, theta: want.theta, target: want.target.clone() };
          selected = a;
        } else if (!a && selected) {
          deselect();
        }
        updatePanel();
      });
      function deselect() {
        selected = null;
        if (prevView) { want.r = prevView.r; want.phi = prevView.phi; want.theta = prevView.theta; want.target.copy(prevView.target); prevView = null; }
      }
      function escHTML(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
      var startedFormatter = null;
      function formatStarted(iso) {
        var t = Date.parse(iso || '');
        if (!Number.isFinite(t)) return 'unknown';
        try {
          startedFormatter = startedFormatter || new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Bangkok',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          return startedFormatter.format(new Date(t));
        } catch (e) {
          return new Date(t).toLocaleString();
        }
      }
      function formatElapsed(ms) {
        if (!Number.isFinite(ms)) return 'unknown';
        var mins = Math.max(0, Math.floor(ms / 60000));
        var days = Math.floor(mins / 1440);
        var hours = Math.floor((mins % 1440) / 60);
        var rem = mins % 60;
        if (days) return days + 'd ' + hours + 'h';
        if (hours) return hours + 'h ' + rem + 'm';
        return rem + 'm';
      }
      function selectedFooterText(d) {
        var parts = [];
        if (d.progress) parts.push('acceptance criteria — ' + d.progress.met + '/' + d.progress.total + ' met');
        else if (d.issue) parts.push('latest issue: ' + d.issue);
        parts.push('department: ' + (d.deptLabel || d.dept || 'unknown'));
        parts.push('started: ' + formatStarted(d.startedAt));
        parts.push('elapsed: ' + formatElapsed(d.elapsedMs));
        return parts.join(' · ');
      }

      var panel = document.getElementById('panel');
      document.getElementById('p-close').addEventListener('click', function () { deselect(); updatePanel(); });
      function updatePanel() {
        if (!selected) { panel.classList.remove('show'); return; }
        var d = selected.def;
        panel.classList.add('show');
        var por = document.getElementById('p-portrait');
        por.style.background = '';
        var pHead = document.getElementById('p-head');
        if (pHead) drawHead(pHead, selected, d);
        document.getElementById('p-name').textContent = d.name;
        var heroName = selected.traits && selected.traits.hero && selected.traits.hero.name ? titleCase(selected.traits.hero.name) : '';
        document.getElementById('p-role').textContent = (heroName ? 'Hero: ' + heroName + ' · ' : '') + d.role + ' · ' + d.dept + (d.skill && d.skill !== d.role ? ' · ' + d.skill : '');
        document.getElementById('p-state').textContent = STATE_LABEL[d.state] || d.state;
        document.getElementById('p-dot').style.background = STATE_CSS[d.state] || '#9AA0A4';
        document.getElementById('p-title').textContent = d.title || d.note || '';
        var bar = document.getElementById('p-bar'), barI = document.getElementById('p-bar-i'), barL = document.getElementById('p-bar-l');
        if (d.progress) {
          bar.hidden = false; barL.hidden = false;
          barI.style.width = Math.round(d.progress.met / d.progress.total * 100) + '%';
          barL.textContent = selectedFooterText(d);
        } else if (d.issue) {
          bar.hidden = true; barL.hidden = false;
          barL.textContent = selectedFooterText(d);
        } else {
          bar.hidden = true; barL.hidden = false;
          barL.textContent = selectedFooterText(d);
        }
      }

      var finishPopup = document.getElementById('finish-pop');
      var finishClose = document.getElementById('finish-close');
      var finishHead = document.getElementById('finish-head');
      var finishTimer = null;
      var finishQueue = [];
      var finishShowing = false;
      function hideCompletionPopup() {
        if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
        if (!finishPopup) return;
        finishPopup.classList.remove('show');
        finishPopup.hidden = true;
        finishShowing = false;
      }
      function finishCurrentPopup() {
        hideCompletionPopup();
        if (finishQueue.length) setTimeout(showNextCompletionPopup, 160);
      }
      if (finishClose) finishClose.addEventListener('click', finishCurrentPopup);
      function completionFooterText(d) {
        var parts = [];
        if (d.progress) parts.push('acceptance criteria — ' + d.progress.met + '/' + d.progress.total + ' met');
        if (d.jira) parts.push('card: ' + d.jira);
        parts.push('department: ' + (d.deptLabel || d.dept || 'unknown'));
        parts.push('started: ' + formatStarted(d.startedAt));
        parts.push('elapsed: ' + formatElapsed(d.elapsedMs));
        return parts.join(' · ');
      }
      function completionFallbackTraits(d) {
        var h = hash(String((d && (d.id || d.name || d.title)) || 'finished-agent'));
        return makeTraits(h, false);
      }
      function completionHeroName(a, d) {
        if (a && a.traits && a.traits.hero && a.traits.hero.name) return titleCase(a.traits.hero.name);
        var tr = completionFallbackTraits(d);
        return tr && tr.hero && tr.hero.name ? titleCase(tr.hero.name) : '';
      }
      function completionPortraitColor(a, d) {
        if (a && a.body && a.body.material && a.body.material.color) return '#' + a.body.material.color.getHexString();
        var tr = completionFallbackTraits(d);
        var color = tr && tr.primary != null ? tr.primary : SHIRTS[hash(String(d && d.id || 'agent')) % SHIRTS.length];
        return '#' + ('000000' + color.toString(16)).slice(-6);
      }
      function drawHead(cv, a, d) {
        if (!cv) return;
        var cx = cv.getContext('2d');
        if (!cx) return;
        cx.clearRect(0, 0, cv.width, cv.height);
        cx.imageSmoothingEnabled = false;
        var h = hash(String((a && a.def && a.def.id) || (d && d.id) || 'finished-agent'));
        var tr = (a && a.traits) || completionFallbackTraits(d);
        var skin = SKINS[h % SKINS.length];
        var hair = HAIRS[(h >> 3) % HAIRS.length];
        var cells = 8;
        var px = Math.floor(Math.min(cv.width, cv.height) / cells);
        var ox = Math.floor((cv.width - px * cells) / 2);
        var oy = Math.floor((cv.height - px * cells) / 2);
        function fillCell(x, y, w, hgt, color) {
          cx.fillStyle = '#' + ('000000' + color.toString(16)).slice(-6);
          cx.fillRect(ox + x * px, oy + y * px, w * px, hgt * px);
        }
        fillCell(0, 0, 8, 8, skin);
        if (tr.hairstyle !== 1 && tr.hairstyle !== 4 && tr.hairstyle !== 6) fillCell(0, 0, 8, 1, hair);
        if (tr.mask === 'full' || tr.mask === 'visor') fillCell(0, 0, 8, 8, tr.maskColor);
        else if (tr.mask === 'domino') fillCell(0, 2, 8, 3, tr.maskColor);
        else if (tr.mask === 'cowl') fillCell(0, 0, 8, 5, tr.maskColor);
        fillCell(1, 3, 2, 1, 0xffffff); fillCell(5, 3, 2, 1, 0xffffff);
        fillCell(2, 3, 1, 1, tr.eyeColor || 0x3d2fa8); fillCell(5, 3, 1, 1, tr.eyeColor || 0x3d2fa8);
        if (tr.mask === 'visor') fillCell(1, 3, 6, 1, 0x7ef7ff);
        if (tr.hero && tr.hero.lensLarge) {
          fillCell(0, 2, 3, 2, 0xffffff); fillCell(5, 2, 3, 2, 0xffffff); fillCell(3, 3, 2, 1, 0x111827);
        }
        if (tr.hero && tr.hero.cyberEye) fillCell(5, 2, 2, 2, 0xff1f3d);
        if (tr.beard) {
          fillCell(1, 6, 6, 2, hair);
          fillCell(3, 6, 2, 1, 0x7a4a3a);
        } else {
          fillCell(3, 6, 2, 1, 0x9a5f4a);
        }
        cx.strokeStyle = 'rgba(255,255,255,0.28)';
        cx.lineWidth = 2;
        cx.strokeRect(ox + 1, oy + 1, px * cells - 2, px * cells - 2);
      }
      function drawCompletionHead(a, d) {
        drawHead(finishHead, a, d);
      }
      function renderCompletionPopup(a, completion) {
        if (!finishPopup || !completion) return;
        var d = completion;
        var heroName = completionHeroName(a, d);
        var name = d.name || 'agent';
        var title = d.summary || d.title || 'Task finished';
        var detail = d.detail || completionFooterText(d);
        var por = document.getElementById('finish-portrait');
        if (por) por.style.background = '';
        drawCompletionHead(a, d);
        var kicker = document.getElementById('finish-kicker');
        if (kicker) kicker.textContent = 'Finished';
        var nameEl = document.getElementById('finish-name');
        if (nameEl) nameEl.textContent = heroName ? (name + ' · ' + heroName) : name;
        var titleEl = document.getElementById('finish-title');
        if (titleEl) titleEl.textContent = title;
        var detailEl = document.getElementById('finish-detail');
        if (detailEl) detailEl.textContent = detail || completionFooterText(d);
        finishPopup.hidden = false;
        finishPopup.classList.add('show');
        if (finishTimer) clearTimeout(finishTimer);
        finishTimer = setTimeout(finishCurrentPopup, 9000);
      }
      function showNextCompletionPopup() {
        if (finishShowing || !finishQueue.length) return;
        finishShowing = true;
        var item = finishQueue.shift();
        renderCompletionPopup(item.a, item.completion);
      }
      function showCompletionPopup(a, completion) {
        if (!completion) return;
        finishQueue.push({ a: a || null, completion: completion });
        showNextCompletionPopup();
      }

      function focusAgentAt(index) {
        if (!agents.length) return;
        var n = agents.length;
        var i = ((index % n) + n) % n;
        var a = agents[i];
        if (!a || a.remove) return;
        if (!selected) prevView = { r: want.r, phi: want.phi, theta: want.theta, target: want.target.clone() };
        selected = a;
        updatePanel();
      }
      function focusRelative(delta) {
        if (!agents.length) return;
        var idx = selected ? agents.indexOf(selected) : -1;
        if (idx < 0) idx = 0;
        focusAgentAt(idx + delta);
      }
      function nearestDuelPartner(a) {
        var best = null, bestD = Infinity;
        if (!a) return null;
        for (var i = 0; i < agents.length; i++) {
          var b = agents[i];
          if (!b || b === a || b.remove) continue;
          var d = Math.hypot(b.x - a.x, b.z - a.z);
          if (d < bestD) { bestD = d; best = b; }
        }
        return best;
      }
      function runManualAction(action) {
        var a = selected || agents[0];
        if (!a) return;
        if (action === 'duel') {
          var b = nearestDuelPartner(a);
          if (b) startManualDuel(a, b);
        }
        updatePanel();
      }

      var speed = 1;
      var ctlBar = document.querySelector('.ctl');
      if (ctlBar) {
        function addCtlButton(label, action) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = label;
          btn.setAttribute('data-action', action);
          btn.setAttribute('aria-pressed', 'false');
          ctlBar.appendChild(btn);
          return btn;
        }
        addCtlButton('duel', 'duel');
        addCtlButton('<', 'prev-agent');
        addCtlButton('>', 'next-agent');
      }
      Array.prototype.forEach.call(document.querySelectorAll('.ctl button'), function (btn) {
        btn.addEventListener('click', function () {
          if (btn.hasAttribute('data-speed')) {
            speed = Number(btn.getAttribute('data-speed'));
            Array.prototype.forEach.call(document.querySelectorAll('.ctl button[data-speed]'), function (b) {
              b.setAttribute('aria-pressed', String(b === btn));
            });
          } else if (btn.hasAttribute('data-action')) {
            var action = btn.getAttribute('data-action');
            if (action === 'prev-agent') focusRelative(-1);
            else if (action === 'next-agent') focusRelative(1);
            else runManualAction(action);
          } else {
            var v = btn.getAttribute('data-view');
            tour = v === 'tour';
            if (v !== 'tour') { deselect(); updatePanel(); applyView(v); }
            Array.prototype.forEach.call(document.querySelectorAll('.ctl button[data-view]'), function (b) {
              b.setAttribute('aria-pressed', String(b === btn));
            });
          }
        });
      });
