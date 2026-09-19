      // ---- officers -------------------------------------------------------------------
      // ---- thought bubbles: real-time activity icon above every officer -----------------
      var thoughtTexCache = {};
      function thoughtTexture(icon) {
        if (thoughtTexCache[icon]) return thoughtTexCache[icon];
        var cv = document.createElement('canvas');
        cv.width = 96; cv.height = 84;
        var cx = cv.getContext('2d');
        // square chat-bubble plate + stepped pixel tail
        cx.fillStyle = 'rgba(252,250,245,0.96)';
        cx.strokeStyle = 'rgba(40,44,48,0.6)';
        cx.lineWidth = 3;
        cx.fillRect(8, 4, 84, 52);
        cx.strokeRect(8, 4, 84, 52);
        cx.fillRect(18, 56, 12, 12);
        cx.fillRect(10, 68, 10, 10);
        cx.font = '34px -apple-system, "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
        cx.textAlign = 'center'; cx.textBaseline = 'middle';
        cx.fillStyle = '#22282B';
        cx.fillText(icon, 50, 31);
        var tex = new THREE.CanvasTexture(cv);
        tex.anisotropy = 4;
        thoughtTexCache[icon] = tex;
        return tex;
      }

      // 8x8 pixel hero face texture: skin base, mask/visor, eyes, mouth
      var faceTexCache = {};
      function faceTexture(skinHex, hairHex, tr) {
        var key = skinHex + ':' + hairHex + ':' + tr.hairstyle + ':' + tr.mask + ':' + tr.maskColor + ':' + tr.eyeColor + ':' + (tr.beard ? 1 : 0);
        if (faceTexCache[key]) return faceTexCache[key];
        var cv = document.createElement('canvas');
        cv.width = 8; cv.height = 8;
        var cx = cv.getContext('2d');
        var s = hexRGB(skinHex);
        cx.fillStyle = 'rgb(' + s[0] + ',' + s[1] + ',' + s[2] + ')';
        cx.fillRect(0, 0, 8, 8);
        if (tr.hairstyle !== 1 && tr.hairstyle !== 4 && tr.hairstyle !== 6) {
          var h = hexRGB(hairHex);
          cx.fillStyle = 'rgb(' + h[0] + ',' + h[1] + ',' + h[2] + ')';
          cx.fillRect(0, 0, 8, 1);
        }
        if (tr.mask === 'full' || tr.mask === 'visor') {
          var mh = hexRGB(tr.maskColor);
          cx.fillStyle = 'rgb(' + mh[0] + ',' + mh[1] + ',' + mh[2] + ')';
          cx.fillRect(0, 0, 8, 8);
        } else if (tr.mask === 'domino') {
          var md = hexRGB(tr.maskColor);
          cx.fillStyle = 'rgb(' + md[0] + ',' + md[1] + ',' + md[2] + ')';
          cx.fillRect(0, 2, 8, 3);
        } else if (tr.mask === 'cowl') {
          var mc = hexRGB(tr.maskColor);
          cx.fillStyle = 'rgb(' + mc[0] + ',' + mc[1] + ',' + mc[2] + ')';
          cx.fillRect(0, 0, 8, 5);
        }
        cx.fillStyle = '#ffffff';
        cx.fillRect(1, 3, 2, 1); cx.fillRect(5, 3, 2, 1);
        var e = hexRGB(tr.eyeColor || 0x3d2fa8);
        cx.fillStyle = 'rgb(' + e[0] + ',' + e[1] + ',' + e[2] + ')';
        cx.fillRect(2, 3, 1, 1); cx.fillRect(5, 3, 1, 1);
        if (tr.mask === 'visor') {
          cx.fillStyle = '#7ef7ff';
          cx.fillRect(1, 3, 6, 1);
        }
        if (tr.hero && tr.hero.lensLarge) {
          cx.fillStyle = '#ffffff';
          cx.fillRect(0, 2, 3, 2); cx.fillRect(5, 2, 3, 2);
          cx.fillStyle = '#111827';
          cx.fillRect(3, 3, 2, 1);
        }
        if (tr.hero && tr.hero.cyberEye) {
          cx.fillStyle = '#ff1f3d';
          cx.fillRect(5, 2, 2, 2);
        }
        if (tr.beard) {
          var b = hexRGB(hairHex);
          cx.fillStyle = 'rgb(' + b[0] + ',' + b[1] + ',' + b[2] + ')';
          cx.fillRect(1, 6, 6, 2);
          cx.fillStyle = '#7a4a3a';
          cx.fillRect(3, 6, 2, 1); // mouth peeking through
        } else {
          cx.fillStyle = '#9a5f4a';
          cx.fillRect(3, 6, 2, 1);
        }
        var tex = new THREE.CanvasTexture(cv);
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        faceTexCache[key] = tex;
        return tex;
      }

      var HERO_ARCHETYPES = [
        { name: 'Superman', primary: 0x1E5BFF, secondary: 0xEF233C, accent: 0xFFD23F, mask: 'none', cape: true, chest: 'diamond', boots: true, gloves: true, hair: 0, build: 1.1 },
        { name: 'Batman', primary: 0x111827, secondary: 0x2D3748, accent: 0xFACC15, mask: 'cowl', cape: true, ears: true, belt: true, gauntlets: true, build: 1.14 },
        { name: 'Spider-Man', primary: 0xD7263D, secondary: 0x0B4EA2, accent: 0xFFFFFF, mask: 'full', web: true, boots: true, gloves: true, hair: 6, build: 0.92 },
        { name: 'Cyclops', primary: 0x1063D9, secondary: 0x7DD3FC, accent: 0xE0F2FE, mask: 'visor', helmet: true, gauntlets: true, boots: true, shoulder: true, build: 0.98 },
        { name: 'Captain America', primary: 0x234E9A, secondary: 0xB91C1C, accent: 0xF8FAFC, mask: 'domino', shield: true, chest: 'star', boots: true, gloves: true, build: 1.06 },
        { name: 'Thor', primary: 0x334155, secondary: 0x7C3AED, accent: 0xFDE047, mask: 'none', cape: true, lightning: true, shoulder: true, hair: 5, build: 1.16 },
        { name: 'Green Arrow', primary: 0x047857, secondary: 0x064E3B, accent: 0xA7F3D0, mask: 'domino', belt: true, quiver: true, gloves: true, boots: true, build: 0.96 },
        { name: 'Scarlet Witch', primary: 0x7F1D1D, secondary: 0xE11D48, accent: 0xF9A8D4, mask: 'crown', cape: true, glowHands: true, hair: 5, build: 0.9 },
        { name: 'Iron Man', primary: 0x991B1B, secondary: 0xF59E0B, accent: 0x67E8F9, mask: 'visor', helmet: true, techBackpack: true, gauntlets: true, boots: true, shoulder: true, build: 1.08 },
        { name: 'Starfire', primary: 0x581C87, secondary: 0x0F172A, accent: 0x22D3EE, mask: 'domino', cape: true, chest: 'orbit', gloves: true, boots: true, build: 0.94 },
        { name: 'The Flash', primary: 0xB91C1C, secondary: 0xF97316, accent: 0xFDE047, mask: 'cowl', lightning: true, boots: true, fin: true, build: 0.9 },
        { name: 'Iceman', primary: 0xE0F2FE, secondary: 0x0E7490, accent: 0x38BDF8, mask: 'visor', helmet: true, cape: true, shoulder: true, gauntlets: true, build: 1.04 },
        { name: 'Black Panther', primary: 0x18181B, secondary: 0x4C1D95, accent: 0xA78BFA, mask: 'full', cape: true, belt: true, claws: true, ears: true, build: 0.96 },
        { name: 'Rescue', primary: 0xFFFFFF, secondary: 0xEF4444, accent: 0x22C55E, mask: 'visor', chest: 'cross', techBackpack: true, gloves: true, boots: true, build: 0.92 },
        { name: 'Doctor Fate', primary: 0x92400E, secondary: 0xFBBF24, accent: 0xFEF3C7, mask: 'none', helmet: true, cape: true, shoulder: true, gauntlets: true, build: 1.2 },
        { name: 'Ronin', primary: 0x111827, secondary: 0x0F766E, accent: 0x2DD4BF, mask: 'full', scarf: true, belt: true, gloves: true, boots: true, build: 0.88 },
        { name: 'Yondu', primary: 0x1E3A8A, secondary: 0x94A3B8, accent: 0xF8FAFC, mask: 'visor', helmet: true, techBackpack: true, fin: true, gloves: true, build: 0.98 },
        { name: 'Daredevil', primary: 0x7F1D1D, secondary: 0xB45309, accent: 0xFB7185, mask: 'domino', gauntlets: true, shoulder: true, boots: true, build: 1.18 },
        { name: 'Mera', primary: 0x0369A1, secondary: 0x14B8A6, accent: 0xA7F3D0, mask: 'none', cape: true, shield: true, chest: 'wave', gloves: true, build: 1.0 },
        { name: 'Raven', primary: 0x4C1D95, secondary: 0xBE185D, accent: 0xF0ABFC, mask: 'crown', cape: true, glowHands: true, chest: 'diamond', hair: 5, build: 0.9 },
        { name: 'Robin', primary: 0x365314, secondary: 0x84CC16, accent: 0xECFCCB, mask: 'domino', belt: true, quiver: true, boots: true, gloves: true, build: 0.94 },
        { name: 'Captain Cold', primary: 0xF8FAFC, secondary: 0x2563EB, accent: 0xF97316, mask: 'visor', helmet: true, fin: true, boots: true, gauntlets: true, build: 0.96 },
        { name: 'War Machine', primary: 0x0F172A, secondary: 0x475569, accent: 0x22D3EE, mask: 'visor', helmet: true, techBackpack: true, shoulder: true, gauntlets: true, boots: true, build: 1.22 },
        { name: 'Firestorm', primary: 0xEA580C, secondary: 0xFDE047, accent: 0xFFF7ED, mask: 'domino', cape: true, lightning: true, boots: true, gloves: true, build: 0.91 },
        { name: 'Iron Man', primary: 0xB91C1C, secondary: 0xF59E0B, accent: 0x67E8F9, mask: 'visor', helmet: true, chest: 'arc', techBackpack: true, tubing: true, gauntlets: true, boots: true, shoulder: true, build: 1.1 },
        { name: 'Captain America', primary: 0x1E3A8A, secondary: 0xB91C1C, accent: 0xE5E7EB, mask: 'domino', chest: 'star', shield: true, harness: true, gloves: true, boots: true, build: 1.08 },
        { name: 'Thor', primary: 0x1F2937, secondary: 0x9CA3AF, accent: 0xEF4444, mask: 'none', cape: true, scaleMail: true, shoulder: true, boots: true, gauntlets: true, hair: 5, build: 1.18 },
        { name: 'The Hulk', primary: 0x22C55E, secondary: 0x5B21B6, accent: 0x166534, mask: 'none', raggedPants: true, huge: true, height: 1.35, build: 1.42, hair: 1 },
        { name: 'Black Widow', primary: 0x0B0F19, secondary: 0x111827, accent: 0xEF4444, mask: 'none', chest: 'hourglass', belt: true, bracers: true, gloves: true, boots: true, hair: 5, build: 0.9 },
        { name: 'Spider-Man', primary: 0xDC2626, secondary: 0x1D4ED8, accent: 0xF8FAFC, mask: 'full', web: true, chest: 'spider', boots: true, gloves: true, lensLarge: true, build: 0.9 },
        { name: 'Black Panther', primary: 0x050505, secondary: 0x111827, accent: 0xA855F7, mask: 'full', chest: 'panther', necklace: true, ears: true, claws: true, kineticGlow: true, build: 1.02 },
        { name: 'Doctor Strange', primary: 0x1E3A8A, secondary: 0x7F1D1D, accent: 0xF59E0B, mask: 'none', cape: true, highCollar: true, chest: 'amulet', glowHands: true, belt: true, hair: 0, build: 0.96 },
        { name: 'Captain Marvel', primary: 0x1D4ED8, secondary: 0xB91C1C, accent: 0xFBBF24, mask: 'visor', chest: 'burst', helmet: true, fin: true, boots: true, gauntlets: true, build: 1.02 },
        { name: 'Scarlet Witch', primary: 0x7F1D1D, secondary: 0x111827, accent: 0xEF4444, mask: 'crown', cape: true, highCollar: true, chest: 'diamond', glowHands: true, hair: 5, build: 0.9 },
        { name: 'Ant-Man', primary: 0x111827, secondary: 0xB91C1C, accent: 0x9CA3AF, mask: 'visor', helmet: true, tubing: true, boots: true, gloves: true, shoulder: true, lensLarge: true, build: 0.94 },
        { name: 'Star-Lord', primary: 0x581C1C, secondary: 0x374151, accent: 0xEF4444, mask: 'visor', helmet: true, trench: true, twinBlasters: true, boots: true, hair: 0, build: 0.98 },
        { name: 'Deadpool', primary: 0xB91C1C, secondary: 0x111827, accent: 0xF8FAFC, mask: 'full', belt: true, pouches: true, katanas: true, gloves: true, boots: true, build: 0.98 },
        { name: 'Wolverine', primary: 0xFACC15, secondary: 0x2563EB, accent: 0xE5E7EB, mask: 'cowl', ears: true, claws: true, shoulder: true, boots: true, gloves: true, build: 1.08 },
        { name: 'Superman', primary: 0x1D4ED8, secondary: 0xDC2626, accent: 0xFACC15, mask: 'none', cape: true, chest: 'shield-glyph', boots: true, gloves: false, hair: 0, build: 1.15 },
        { name: 'Batman', primary: 0x1F2937, secondary: 0x030712, accent: 0x111827, mask: 'cowl', cape: true, chest: 'bat', ears: true, gauntlets: true, bladedGauntlets: true, belt: true, shoulder: true, build: 1.2 },
        { name: 'Wonder Woman', primary: 0xB91C1C, secondary: 0x1D4ED8, accent: 0xFBBF24, mask: 'crown', chest: 'eagle', skirt: true, bracers: true, boots: true, shield: true, build: 1.0 },
        { name: 'Aquaman', primary: 0xD97706, secondary: 0x065F46, accent: 0xFBBF24, mask: 'none', chest: 'scale', scaleMail: true, trident: true, boots: true, bracers: true, hair: 5, beardForce: true, build: 1.14 },
        { name: 'The Flash', primary: 0xDC2626, secondary: 0x991B1B, accent: 0xFACC15, mask: 'cowl', chest: 'boltCircle', fin: true, lightning: true, boots: true, gloves: true, build: 0.9 },
        { name: 'Cyborg', primary: 0x9CA3AF, secondary: 0x374151, accent: 0xEF4444, mask: 'visor', helmet: true, chest: 'core', techBackpack: true, tubing: true, shoulder: true, gauntlets: true, cyberEye: true, build: 1.18 },
        { name: 'Shazam', primary: 0xDC2626, secondary: 0xF8FAFC, accent: 0xFACC15, mask: 'none', cape: true, shortCape: true, chest: 'lightning', boots: true, gauntlets: true, highCollar: true, build: 1.04 },
        { name: 'Peacemaker', primary: 0xDC2626, secondary: 0xF8FAFC, accent: 0x2563EB, mask: 'visor', helmet: true, domeHelmet: true, chest: 'dove', belt: true, gloves: true, boots: true, build: 1.06 },
        { name: 'Blue Beetle', primary: 0x1D4ED8, secondary: 0x030712, accent: 0x38BDF8, mask: 'visor', helmet: true, chest: 'scarab', insectWings: true, tubing: true, boots: true, gauntlets: true, build: 1.0 },
        { name: 'Supergirl', primary: 0x2563EB, secondary: 0xDC2626, accent: 0xFACC15, mask: 'none', cape: true, chest: 'shield-glyph', skirt: true, boots: true, hair: 5, build: 0.92 }
      ];

      function heroColor(hero, key, fallback) {
        return hero[key] != null ? hero[key] : fallback;
      }

      function heroAbility(hero) {
        if (hero && hero.ability) return hero.ability;
        var name = String(hero && hero.name || '').toLowerCase();
        if (name === 'superman') return 'solar-flare';
        if (name === 'batman') return 'shadow-glide';
        if (name === 'spider-man') return 'web-sling';
        if (name === 'cyclops') return 'optic-burst';
        if (name === 'captain america') return 'shield-bounce';
        if (name === 'thor') return 'storm-call';
        if (name === 'green arrow') return 'arrow-swarm';
        if (name === 'scarlet witch') return 'hex-wave';
        if (name === 'iron man') return 'repulsor-blast';
        if (name === 'starfire') return 'star-burst';
        if (name === 'the flash') return 'speed-blur';
        if (name === 'iceman') return 'freeze-field';
        if (name === 'black panther') return 'kinetic-pounce';
        if (name === 'rescue') return 'arc-shield';
        if (name === 'doctor fate') return 'fate-weave';
        if (name === 'ronin') return 'blade-flurry';
        if (name === 'yondu') return 'sonic-arrow';
        if (name === 'daredevil') return 'radar-sense';
        if (name === 'mera') return 'tide-wave';
        if (name === 'raven') return 'shadow-portal';
        if (name === 'robin') return 'acrobat-strike';
        if (name === 'captain cold') return 'cold-ray';
        if (name === 'war machine') return 'artillery-barrage';
        if (name === 'firestorm') return 'plasma-forge';
        if (name === 'black widow') return 'widow-sting';
        if (name === 'ant-man') return 'shrink-burst';
        if (name === 'star-lord') return 'mixtape-blast';
        if (name === 'deadpool') return 'chaos-slash';
        if (name === 'wolverine') return 'claw-rush';
        if (name === 'wonder woman') return 'lasso-bind';
        if (name === 'aquaman') return 'waterjet';
        if (name === 'cyborg') return 'tech-cannon';
        if (name === 'shazam') return 'lightning-shout';
        if (name === 'peacemaker') return 'peace-pulse';
        if (name === 'blue beetle') return 'scarab-swarm';
        if (name === 'supergirl') return 'solar-flare';
        if (hero.lightning) return 'storm-call';
        if (hero.web) return 'web-sling';
        if (hero.shield) return 'shield-bounce';
        if (hero.trident) return 'waterjet';
        if (hero.twinBlasters) return 'repulsor-blast';
        if (hero.quiver) return 'arrow-swarm';
        if (hero.katanas) return 'blade-flurry';
        if (hero.techBackpack) return 'tech-cannon';
        if (hero.glowHands || hero.kineticGlow) return 'hex-wave';
        if (hero.insectWings) return 'flight-burst';
        if (hero.fin) return 'speed-blur';
        if (hero.claws) return 'claw-rush';
        return 'burst-wave';
      }

      function abilityIcon(ability) {
        var map = {
          'solar-flare': '☀️',
          'shadow-glide': '🌑',
          'web-sling': '🕸️',
          'optic-burst': '🔴',
          'shield-bounce': '🛡️',
          'storm-call': '🌩️',
          'arrow-swarm': '🏹',
          'hex-wave': '🌀',
          'repulsor-blast': '✨',
          'star-burst': '⭐',
          'speed-blur': '💨',
          'freeze-field': '🧊',
          'kinetic-pounce': '🐾',
          'arc-shield': '🔷',
          'fate-weave': '🔮',
          'blade-flurry': '🗡️',
          'sonic-arrow': '🎯',
          'radar-sense': '👁️',
          'tide-wave': '🌊',
          'shadow-portal': '🕳️',
          'acrobat-strike': '🤸',
          'cold-ray': '❄️',
          'artillery-barrage': '💥',
          'plasma-forge': '🔥',
          'widow-sting': '🕷️',
          'shrink-burst': '🐜',
          'mixtape-blast': '🎶',
          'chaos-slash': '🎲',
          'claw-rush': '🐺',
          'lasso-bind': '🪢',
          'waterjet': '💧',
          'tech-cannon': '🤖',
          'peace-pulse': '🕊️',
          'scarab-swarm': '🪲',
          'flight-burst': '🪽',
          'burst-wave': '✨',
          'lightning-shout': '⚡',
        };
        return map[ability] || '✨';
      }

      function titleCase(s) {
        return String(s || '').replace(/\b[a-z]/g, function (m) { return m.toUpperCase(); });
      }

      function agentHeroName(def, tr) {
        var heroName = tr && tr.hero && tr.hero.name ? titleCase(tr.hero.name) : '';
        return heroName ? (def.name + ' · ' + heroName) : def.name;
      }

      // deterministic per-agent character traits: a large roster of original hero archetypes
      function makeTraits(h, lead) {
        var pantsPalette = themeArray('agents.pants', [0x4a5058, 0x5a5348, 0x39465a, 0x54455a, 0x4d5a45]);
        if (!pantsPalette.length) pantsPalette = [0x4a5058];
        var hero = HERO_ARCHETYPES[h % HERO_ARCHETYPES.length];
        var ability = heroAbility(hero);
        if (lead) {
          hero = {
            name: 'mission commander',
            primary: themeValue('agents.leadShirt', 0xD98E2B),
            secondary: 0x172554,
            accent: 0xFDE047,
            mask: 'domino',
            cape: true,
            shoulder: true,
            chest: 'star',
            gauntlets: true,
            boots: true,
            build: 1.12,
          };
        }
        return {
          hero: hero,
          ability: ability,
          abilityIcon: abilityIcon(ability),
          height: Math.max(0.86, Math.min(1.45, (hero.height || 1) + (((h >> 2) % 11) - 5) / 100)),
          build: Math.max(0.84, Math.min(1.48, (hero.build || 1) + (((h >> 9) % 7) - 3) / 100)),
          hairstyle: hero.hair != null ? hero.hair : (h >> 12) % 6,
          glasses: false,
          headphones: false,
          beard: hero.beardForce || (hero.mask === 'none' && ((h >> 11) % 10) < 2),
          tie: false,
          pants: pantsPalette[(h >> 15) % pantsPalette.length],
          primary: heroColor(hero, 'primary', SHIRTS[(h >> 6) % SHIRTS.length]),
          secondary: heroColor(hero, 'secondary', pantsPalette[(h >> 15) % pantsPalette.length]),
          accent: heroColor(hero, 'accent', ACCENTS[(h >> 17) % ACCENTS.length]),
          mask: hero.mask || 'none',
          maskColor: hero.maskColor || heroColor(hero, 'secondary', 0x111827),
          eyeColor: hero.eyeColor || heroColor(hero, 'accent', 0x3d2fa8),
          beanieColor: heroColor(hero, 'accent', ACCENTS[(h >> 17) % ACCENTS.length]),
        };
      }

      function addChestMark(bodyG, tr) {
        var hero = tr.hero;
        var markColor = tr.accent;
        if (hero.chest === 'star') {
          var core = boxMesh(0.22, 0.22, 0.08, markColor);
          core.position.set(0, 2.0, 0.33); bodyG.add(core);
          var hbar = boxMesh(0.55, 0.12, 0.08, markColor);
          hbar.position.set(0, 2.0, 0.34); bodyG.add(hbar);
          var vbar = boxMesh(0.12, 0.55, 0.08, markColor);
          vbar.position.set(0, 2.0, 0.35); bodyG.add(vbar);
        } else if (hero.chest === 'cross') {
          var ch = boxMesh(0.54, 0.16, 0.08, markColor);
          ch.position.set(0, 1.98, 0.33); bodyG.add(ch);
          var cv = boxMesh(0.16, 0.54, 0.08, markColor);
          cv.position.set(0, 1.98, 0.34); bodyG.add(cv);
        } else if (hero.chest === 'arc' || hero.chest === 'core' || hero.chest === 'amulet') {
          var coreBox = boxMesh(0.34, 0.34, 0.09, markColor, { emissive: markColor });
          coreBox.position.set(0, 2.0, 0.35); coreBox.rotation.z = hero.chest === 'amulet' ? Math.PI / 4 : 0; bodyG.add(coreBox);
          var ringTop = boxMesh(0.62, 0.08, 0.08, 0xE0F2FE, { emissive: markColor });
          ringTop.position.set(0, 2.22, 0.36); bodyG.add(ringTop);
          var ringBottom = ringTop.clone(); ringBottom.position.y = 1.78; bodyG.add(ringBottom);
        } else if (hero.chest === 'hourglass') {
          var hourA = boxMesh(0.32, 0.2, 0.08, markColor);
          hourA.position.set(0, 2.08, 0.34); hourA.rotation.z = Math.PI / 4; bodyG.add(hourA);
          var hourB = hourA.clone(); hourB.position.y = 1.86; hourB.rotation.z = -Math.PI / 4; bodyG.add(hourB);
        } else if (hero.chest === 'spider') {
          var spiderBody = boxMesh(0.2, 0.32, 0.08, markColor);
          spiderBody.position.set(0, 2.0, 0.34); bodyG.add(spiderBody);
          for (var sp = 0; sp < 4; sp++) {
            var leg = boxMesh(0.34, 0.05, 0.08, markColor);
            leg.position.set(sp < 2 ? -0.22 : 0.22, 1.84 + (sp % 2) * 0.26, 0.35);
            leg.rotation.z = sp < 2 ? 0.45 : -0.45; bodyG.add(leg);
          }
        } else if (hero.chest === 'panther') {
          var fangL = boxMesh(0.12, 0.38, 0.08, markColor, { emissive: markColor });
          fangL.position.set(-0.16, 2.02, 0.34); fangL.rotation.z = 0.35; bodyG.add(fangL);
          var fangR = fangL.clone(); fangR.position.x = 0.16; fangR.rotation.z = -0.35; bodyG.add(fangR);
          var nose = boxMesh(0.22, 0.12, 0.08, 0xE5E7EB);
          nose.position.set(0, 2.12, 0.35); bodyG.add(nose);
        } else if (hero.chest === 'burst') {
          for (var bi = 0; bi < 8; bi++) {
            var ray = boxMesh(0.08, bi % 2 ? 0.46 : 0.34, 0.08, markColor);
            ray.position.set(0, 2.0, 0.34); ray.rotation.z = bi * Math.PI / 4; bodyG.add(ray);
          }
        } else if (hero.chest === 'shield-glyph') {
          var glyph = boxMesh(0.58, 0.46, 0.08, markColor);
          glyph.position.set(0, 2.02, 0.34); bodyG.add(glyph);
          var glyphInset = boxMesh(0.36, 0.24, 0.09, hero.secondary);
          glyphInset.position.set(0, 2.02, 0.35); bodyG.add(glyphInset);
        } else if (hero.chest === 'bat') {
          var wingL = boxMesh(0.46, 0.18, 0.08, 0x030712);
          wingL.position.set(-0.22, 2.02, 0.35); wingL.rotation.z = 0.25; bodyG.add(wingL);
          var wingR = wingL.clone(); wingR.position.x = 0.22; wingR.rotation.z = -0.25; bodyG.add(wingR);
          var headMark = boxMesh(0.16, 0.22, 0.08, 0x030712);
          headMark.position.set(0, 2.07, 0.36); bodyG.add(headMark);
        } else if (hero.chest === 'eagle') {
          var eagle = boxMesh(0.74, 0.16, 0.08, markColor);
          eagle.position.set(0, 2.08, 0.34); bodyG.add(eagle);
          var eagleV = boxMesh(0.22, 0.42, 0.08, markColor);
          eagleV.position.set(0, 1.9, 0.35); eagleV.rotation.z = Math.PI / 4; bodyG.add(eagleV);
        } else if (hero.chest === 'scale') {
          for (var sc = 0; sc < 9; sc++) {
            var scale = boxMesh(0.18, 0.12, 0.08, sc % 2 ? hero.secondary : markColor);
            scale.position.set(-0.28 + (sc % 3) * 0.28, 2.18 - Math.floor(sc / 3) * 0.2, 0.34); bodyG.add(scale);
          }
        } else if (hero.chest === 'boltCircle') {
          var circle = boxMesh(0.54, 0.54, 0.08, 0xF8FAFC);
          circle.position.set(0, 2.0, 0.34); bodyG.add(circle);
          var bolt = boxMesh(0.14, 0.56, 0.09, markColor);
          bolt.position.set(0, 2.0, 0.36); bolt.rotation.z = -0.45; bodyG.add(bolt);
        } else if (hero.chest === 'lightning') {
          var bigBolt = boxMesh(0.18, 0.7, 0.09, markColor, { emissive: markColor });
          bigBolt.position.set(0, 2.0, 0.35); bigBolt.rotation.z = -0.5; bodyG.add(bigBolt);
        } else if (hero.chest === 'dove') {
          var doveBody = boxMesh(0.24, 0.16, 0.08, markColor);
          doveBody.position.set(0, 2.0, 0.35); bodyG.add(doveBody);
          var doveWingL = boxMesh(0.38, 0.12, 0.08, markColor);
          doveWingL.position.set(-0.24, 2.06, 0.35); doveWingL.rotation.z = 0.4; bodyG.add(doveWingL);
          var doveWingR = doveWingL.clone(); doveWingR.position.x = 0.24; doveWingR.rotation.z = -0.4; bodyG.add(doveWingR);
        } else if (hero.chest === 'scarab') {
          var beetle = boxMesh(0.34, 0.46, 0.08, markColor, { emissive: markColor });
          beetle.position.set(0, 2.0, 0.35); bodyG.add(beetle);
          var beetleLine = boxMesh(0.06, 0.5, 0.09, hero.secondary);
          beetleLine.position.set(0, 2.0, 0.36); bodyG.add(beetleLine);
        } else if (hero.chest === 'diamond') {
          var dia = boxMesh(0.42, 0.42, 0.08, markColor);
          dia.position.set(0, 2.0, 0.34); dia.rotation.z = Math.PI / 4; bodyG.add(dia);
        } else if (hero.chest === 'orbit') {
          var planet = boxMesh(0.28, 0.28, 0.08, markColor);
          planet.position.set(0, 2.0, 0.34); bodyG.add(planet);
          var ring = boxMesh(0.72, 0.08, 0.08, hero.secondary);
          ring.position.set(0, 2.0, 0.35); ring.rotation.z = -0.45; bodyG.add(ring);
        } else if (hero.chest === 'wave') {
          for (var i = 0; i < 3; i++) {
            var wave = boxMesh(0.55 - i * 0.12, 0.08, 0.08, markColor);
            wave.position.set(0, 1.86 + i * 0.16, 0.34); wave.rotation.z = i % 2 ? -0.2 : 0.2; bodyG.add(wave);
          }
        } else if (hero.lightning) {
          var boltA = boxMesh(0.16, 0.5, 0.08, markColor);
          boltA.position.set(-0.08, 2.06, 0.34); boltA.rotation.z = -0.5; bodyG.add(boltA);
          var boltB = boxMesh(0.16, 0.46, 0.08, markColor);
          boltB.position.set(0.1, 1.82, 0.35); boltB.rotation.z = -0.5; bodyG.add(boltB);
        } else if (hero.web) {
          var webV = boxMesh(0.08, 0.7, 0.08, markColor);
          webV.position.set(0, 1.95, 0.34); bodyG.add(webV);
          var webH1 = boxMesh(0.72, 0.06, 0.08, markColor);
          webH1.position.set(0, 2.1, 0.35); bodyG.add(webH1);
          var webH2 = boxMesh(0.62, 0.06, 0.08, markColor);
          webH2.position.set(0, 1.85, 0.35); bodyG.add(webH2);
        } else {
          var badge = boxMesh(0.34, 0.34, 0.08, markColor);
          badge.position.set(0, 2.0, 0.34); bodyG.add(badge);
        }
      }

      function addHeroGear(bodyG, tr, skin, hair, legL, legR, armL, armR) {
        var hero = tr.hero;
        var capeColor = hero.capeColor || hero.secondary;
        if (hero.cape) {
          var capeH = hero.shortCape ? 1.05 : 1.75;
          var cape = boxMesh(1.15, capeH, 0.08, capeColor, { transparent: true, opacity: 0.88 });
          cape.position.set(0, hero.shortCape ? 2.02 : 1.67, -0.38); cape.rotation.x = -0.12; bodyG.add(cape);
          var capeFoldL = boxMesh(0.12, Math.max(0.8, capeH - 0.17), 0.09, tr.primary, { transparent: true, opacity: 0.65 });
          capeFoldL.position.set(-0.46, 1.55, -0.43); capeFoldL.rotation.x = -0.1; bodyG.add(capeFoldL);
          var capeFoldR = capeFoldL.clone(); capeFoldR.position.x = 0.46; bodyG.add(capeFoldR);
        }
        if (hero.highCollar) {
          var collar = boxMesh(1.18, 0.46, 0.18, capeColor);
          collar.position.set(0, 2.58, -0.28); collar.rotation.x = -0.25; bodyG.add(collar);
        }
        if (hero.trench) {
          var coatBack = boxMesh(1.15, 1.55, 0.1, hero.primary);
          coatBack.position.set(0, 1.45, -0.39); bodyG.add(coatBack);
          var coatL = boxMesh(0.18, 1.55, 0.64, hero.primary);
          coatL.position.set(-0.55, 1.45, -0.06); bodyG.add(coatL);
          var coatR = coatL.clone(); coatR.position.x = 0.55; bodyG.add(coatR);
        }
        if (hero.harness) {
          var strapA = boxMesh(0.12, 1.48, 0.09, 0x6B3F1D);
          strapA.position.set(-0.24, 1.88, 0.37); strapA.rotation.z = -0.48; bodyG.add(strapA);
          var strapB = strapA.clone(); strapB.position.x = 0.24; strapB.rotation.z = 0.48; bodyG.add(strapB);
        }
        if (hero.scaleMail) {
          for (var sm = 0; sm < 15; sm++) {
            var scaleTile = boxMesh(0.17, 0.12, 0.08, sm % 2 ? hero.secondary : tr.accent);
            scaleTile.position.set(-0.34 + (sm % 5) * 0.17, 2.23 - Math.floor(sm / 5) * 0.16, 0.36); bodyG.add(scaleTile);
          }
        }
        if (hero.raggedPants) {
          var ragL = boxMesh(0.42, 0.22, 0.4, hero.secondary);
          ragL.position.set(-0.24, 0.88, 0.03); bodyG.add(ragL);
          var ragR = ragL.clone(); ragR.position.x = 0.24; bodyG.add(ragR);
          var tearL = boxMesh(0.16, 0.24, 0.42, tr.primary);
          tearL.position.set(-0.08, 0.73, 0.04); bodyG.add(tearL);
          var tearR = tearL.clone(); tearR.position.x = 0.34; bodyG.add(tearR);
        }
        if (hero.belt) {
          var belt = boxMesh(1.08, 0.16, 0.62, tr.accent);
          belt.position.y = 1.23; bodyG.add(belt);
          var buckle = boxMesh(0.22, 0.18, 0.08, 0xF8FAFC);
          buckle.position.set(0, 1.23, 0.36); bodyG.add(buckle);
        }
        if (hero.pouches) {
          for (var po = 0; po < 4; po++) {
            var pouch = boxMesh(0.18, 0.22, 0.12, 0x4B2E1A);
            pouch.position.set(-0.39 + po * 0.26, 1.08, 0.38); bodyG.add(pouch);
          }
        }
        if (hero.boots) {
          var bootL = boxMesh(0.38, 0.28, 0.38, hero.secondary);
          bootL.position.set(0, -0.66, 0.02); legL.add(bootL);
          var bootR = bootL.clone(); legR.add(bootR);
        }
        if (hero.skirt) {
          var skirt = boxMesh(1.08, 0.38, 0.62, hero.secondary);
          skirt.position.y = 1.03; bodyG.add(skirt);
          var skirtTrim = boxMesh(1.12, 0.08, 0.66, tr.accent);
          skirtTrim.position.y = 0.82; bodyG.add(skirtTrim);
        }
        if (hero.gloves) {
          var gloveL = boxMesh(0.34, 0.28, 0.34, hero.secondary);
          gloveL.geometry.translate(0, -1.17, 0); armL.add(gloveL);
          var gloveR = gloveL.clone(); armR.add(gloveR);
        }
        if (hero.bracers) {
          var bracerL = boxMesh(0.4, 0.34, 0.4, 0xE5E7EB);
          bracerL.geometry.translate(0, -0.78, 0); armL.add(bracerL);
          var bracerR = bracerL.clone(); armR.add(bracerR);
        }
        if (hero.gauntlets || hero.glowHands) {
          var gauntColor = hero.glowHands ? tr.accent : hero.secondary;
          var gauntL = boxMesh(0.42, 0.36, 0.42, gauntColor, hero.glowHands ? { emissive: tr.accent } : null);
          gauntL.geometry.translate(0, -1.08, 0); armL.add(gauntL);
          var gauntR = gauntL.clone(); armR.add(gauntR);
        }
        if (hero.bladedGauntlets) {
          for (var bg = 0; bg < 3; bg++) {
            var blade = boxMesh(0.05, 0.48, 0.05, 0xD1D5DB);
            blade.position.set(0.18, -0.78 + bg * 0.08, 0.24); blade.rotation.x = 0.75; armL.add(blade);
            var bladeR = blade.clone(); bladeR.position.x = -0.18; armR.add(bladeR);
          }
        }
        if (hero.shoulder) {
          var padL = boxMesh(0.44, 0.24, 0.54, tr.accent);
          padL.position.set(-0.72, 2.45, 0); bodyG.add(padL);
          var padR = padL.clone(); padR.position.x = 0.72; bodyG.add(padR);
        }
        if (hero.shield) {
          var shield = boxMesh(0.72, 0.72, 0.14, tr.accent);
          shield.position.set(-0.02, -0.62, 0.28); shield.rotation.z = Math.PI / 4; armL.add(shield);
          var shieldFace = boxMesh(0.46, 0.46, 0.16, hero.secondary);
          shieldFace.position.set(-0.02, -0.62, 0.37); shieldFace.rotation.z = Math.PI / 4; armL.add(shieldFace);
        }
        if (hero.trident) {
          var pole = boxMesh(0.07, 1.9, 0.07, tr.accent);
          pole.position.set(0.18, -0.42, 0.42); pole.rotation.z = -0.15; armR.add(pole);
          var prongM = boxMesh(0.07, 0.45, 0.07, tr.accent);
          prongM.position.set(0.04, -1.38, 0.58); prongM.rotation.z = -0.15; armR.add(prongM);
          var prongL = prongM.clone(); prongL.position.x = -0.1; prongL.rotation.z = 0.15; armR.add(prongL);
          var prongR = prongM.clone(); prongR.position.x = 0.18; prongR.rotation.z = -0.45; armR.add(prongR);
        }
        if (hero.twinBlasters) {
          var blasterL = boxMesh(0.14, 0.52, 0.14, 0x374151);
          blasterL.position.set(-0.18, -1.28, 0.26); blasterL.rotation.x = 0.8; armL.add(blasterL);
          var blasterR = blasterL.clone(); blasterR.position.x = 0.18; armR.add(blasterR);
        }
        if (hero.quiver) {
          var quiver = boxMesh(0.28, 1.1, 0.24, 0x5B341A);
          quiver.position.set(0.5, 2.05, -0.48); quiver.rotation.z = -0.45; bodyG.add(quiver);
          for (var qi = 0; qi < 3; qi++) {
            var arrow = boxMesh(0.06, 0.72, 0.06, tr.accent);
            arrow.position.set(0.38 + qi * 0.08, 2.62, -0.5); arrow.rotation.z = -0.45; bodyG.add(arrow);
          }
        }
        if (hero.katanas) {
          var swordA = boxMesh(0.07, 1.58, 0.07, 0xD1D5DB);
          swordA.position.set(-0.24, 2.12, -0.62); swordA.rotation.z = 0.65; bodyG.add(swordA);
          var swordB = swordA.clone(); swordB.position.x = 0.24; swordB.rotation.z = -0.65; bodyG.add(swordB);
          var hiltA = boxMesh(0.28, 0.08, 0.08, 0x111827);
          hiltA.position.set(-0.68, 2.72, -0.62); hiltA.rotation.z = 0.65; bodyG.add(hiltA);
          var hiltB = hiltA.clone(); hiltB.position.x = 0.68; hiltB.rotation.z = -0.65; bodyG.add(hiltB);
        }
        if (hero.techBackpack) {
          var pack = boxMesh(0.68, 0.9, 0.28, hero.secondary);
          pack.position.set(0, 1.86, -0.52); bodyG.add(pack);
          var core = boxMesh(0.28, 0.32, 0.08, tr.accent, { emissive: tr.accent });
          core.position.set(0, 1.94, -0.7); bodyG.add(core);
        }
        if (hero.tubing) {
          var tubeL = boxMesh(0.08, 1.04, 0.08, 0xCBD5E1);
          tubeL.position.set(-0.56, 1.86, 0.34); tubeL.rotation.z = -0.22; bodyG.add(tubeL);
          var tubeR = tubeL.clone(); tubeR.position.x = 0.56; tubeR.rotation.z = 0.22; bodyG.add(tubeR);
        }
        if (hero.necklace) {
          for (var nk = 0; nk < 5; nk++) {
            var tooth = boxMesh(0.1, 0.22, 0.08, 0xD1D5DB);
            tooth.position.set(-0.28 + nk * 0.14, 2.28 - Math.abs(nk - 2) * 0.05, 0.36); bodyG.add(tooth);
          }
        }
        if (hero.kineticGlow) {
          var glowBelt = boxMesh(1.12, 0.08, 0.64, tr.accent, { emissive: tr.accent, transparent: true, opacity: 0.85 });
          glowBelt.position.y = 1.32; bodyG.add(glowBelt);
        }
        if (hero.insectWings) {
          var wingL = boxMesh(0.58, 1.2, 0.07, tr.accent, { emissive: tr.accent, transparent: true, opacity: 0.55 });
          wingL.position.set(-0.55, 2.0, -0.68); wingL.rotation.z = -0.35; wingL.rotation.y = -0.35; bodyG.add(wingL);
          var wingR = wingL.clone(); wingR.position.x = 0.55; wingR.rotation.z = 0.35; wingR.rotation.y = 0.35; bodyG.add(wingR);
        }
        if (hero.fin) {
          var fin = boxMesh(0.12, 0.54, 0.52, tr.accent);
          fin.position.set(0, 3.28, -0.06); bodyG.add(fin);
        }
        if (hero.domeHelmet) {
          var dome = boxMesh(1.02, 0.44, 1.02, 0xD1D5DB);
          dome.position.y = 3.2; bodyG.add(dome);
          var stripe = boxMesh(0.18, 0.48, 1.06, tr.accent);
          stripe.position.y = 3.22; bodyG.add(stripe);
        }
        if (hero.ears) {
          var earL = boxMesh(0.18, 0.5, 0.18, tr.maskColor);
          earL.position.set(-0.32, 3.34, 0); earL.rotation.z = 0.35; bodyG.add(earL);
          var earR = earL.clone(); earR.position.x = 0.32; earR.rotation.z = -0.35; bodyG.add(earR);
        }
        if (hero.claws) {
          for (var ci = 0; ci < 3; ci++) {
            var claw = boxMesh(0.04, 0.34, 0.04, tr.accent);
            claw.position.set(-0.1 + ci * 0.1, -1.25, 0.2); claw.rotation.x = 0.6; armR.add(claw);
          }
        }
        if (hero.scarf) {
          var scarf = boxMesh(1.08, 0.18, 0.66, tr.accent);
          scarf.position.y = 2.36; bodyG.add(scarf);
          var tail = boxMesh(0.18, 0.9, 0.16, tr.accent);
          tail.position.set(0.52, 1.9, -0.45); tail.rotation.z = -0.2; bodyG.add(tail);
        }
      }

      function buildOfficer(def) {
        var h = hash(def.id);
        var skin = SKINS[h % SKINS.length];
        var hair = HAIRS[(h >> 3) % HAIRS.length];
        var tr = makeTraits(h, !!def.lead);
        var g = new THREE.Group();
        var bodyG = new THREE.Group();               // scaled body; overhead UI stays unscaled
        bodyG.scale.set(tr.build, tr.height, tr.build);
        g.add(bodyG);
        // blocky hero build: same joint pivots and heights as the default rig so every pose works
        var legL = boxMesh(0.34, 0.8, 0.34, tr.secondary);
        legL.geometry.translate(0, -0.4, 0); legL.position.set(-0.24, 0.8, 0); bodyG.add(legL);
        var legR = legL.clone(); legR.position.x = 0.24; bodyG.add(legR);
        var body = boxMesh(1.0, 1.55, 0.55, tr.primary);
        body.position.y = 1.6; bodyG.add(body);
        var sideStripe = boxMesh(0.14, 1.25, 0.08, tr.secondary);
        sideStripe.position.set(-0.43, 1.72, 0.34); bodyG.add(sideStripe);
        var sideStripeR = sideStripe.clone(); sideStripeR.position.x = 0.43; bodyG.add(sideStripeR);
        var sash = boxMesh(1.08, 0.16, 0.08, tr.accent);
        sash.position.set(0, 1.78, 0.35); sash.rotation.z = -0.5; bodyG.add(sash);
        addChestMark(bodyG, tr);
        var armL = boxMesh(0.3, 1.0, 0.3, tr.primary);
        armL.geometry.translate(0, -0.5, 0); armL.position.set(-0.68, 2.05, 0); bodyG.add(armL);
        var armR = armL.clone(); armR.position.x = 0.68; bodyG.add(armR);
        var handL = boxMesh(0.3, 0.22, 0.3, skin);
        handL.geometry.translate(0, -1.06, 0); armL.add(handL);
        var handR = handL.clone(); armR.add(handR);
        // cube head: pixel face on the front, skin around, hair on top
        var skinM = lam(skin);
        var topM = (tr.hairstyle === 1) ? skinM : (tr.hero.helmet || tr.mask === 'full' || tr.mask === 'cowl') ? lam(tr.maskColor) : lam(hair);
        var head = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 0.85),
          [skinM, skinM, topM, skinM, texMat(faceTexture(skin, hair, tr)), skinM]);
        head.position.y = 2.75; head.castShadow = true; bodyG.add(head);
        // hairstyle and hero headgear: voxel helmets, cowls, crowns, and hair blocks
        if (tr.hero.helmet || tr.mask === 'full' || tr.mask === 'cowl') {
          var helm = boxMesh(0.94, 0.36, 0.94, tr.maskColor);
          helm.position.y = 3.1; bodyG.add(helm);
          var brow = boxMesh(0.94, 0.18, 0.16, tr.accent);
          brow.position.set(0, 2.9, 0.46); bodyG.add(brow);
        } else if (tr.mask === 'crown') {
          var crown = boxMesh(0.92, 0.18, 0.92, tr.accent);
          crown.position.y = 3.14; bodyG.add(crown);
          var spireL = boxMesh(0.14, 0.34, 0.14, tr.accent);
          spireL.position.set(-0.28, 3.34, 0.2); bodyG.add(spireL);
          var spireM = boxMesh(0.16, 0.44, 0.16, tr.accent);
          spireM.position.set(0, 3.39, 0.22); bodyG.add(spireM);
          var spireR = spireL.clone(); spireR.position.x = 0.28; bodyG.add(spireR);
        } else if (tr.hairstyle !== 1 && tr.hairstyle !== 4 && tr.hairstyle !== 6) {
          var hairM = boxMesh(0.92, 0.3, 0.92, hair);
          hairM.position.y = 3.08; bodyG.add(hairM);
          var hairBack = boxMesh(0.92, 0.5, 0.2, hair);
          hairBack.position.set(0, 2.85, -0.38); bodyG.add(hairBack);
        }
        if (tr.hairstyle === 2) { // bun
          var bun = boxMesh(0.3, 0.3, 0.3, hair);
          bun.position.set(0, 3.3, -0.28); bodyG.add(bun);
        } else if (tr.hairstyle === 3) { // ponytail (behind = -z)
          var pony = boxMesh(0.24, 0.62, 0.24, hair);
          pony.position.set(0, 2.5, -0.52); pony.rotation.x = 0.5; bodyG.add(pony);
        } else if (tr.hairstyle === 4) { // beanie
          var beanie = boxMesh(0.94, 0.38, 0.94, tr.beanieColor);
          beanie.position.y = 3.1; bodyG.add(beanie);
          var pom = boxMesh(0.24, 0.24, 0.24, 0xf2efe6);
          pom.position.y = 3.4; bodyG.add(pom);
        } else if (tr.hairstyle === 5) { // long hair
          var lockL = boxMesh(0.2, 0.66, 0.24, hair);
          lockL.position.set(-0.44, 2.42, -0.18); bodyG.add(lockL);
          var lockR = lockL.clone(); lockR.position.x = 0.44; bodyG.add(lockR);
        }
        // face accessories (front = +z)
        if (tr.mask === 'domino') {
          var gl = boxMesh(0.76, 0.2, 0.06, tr.maskColor);
          gl.position.set(0, 2.81, 0.46); bodyG.add(gl);
        }
        if (tr.mask === 'visor' || tr.hero.helmet) {
          var visor = boxMesh(0.72, 0.16, 0.07, tr.accent, { emissive: tr.accent });
          visor.position.set(0, 2.82, 0.48); bodyG.add(visor);
        }
        addHeroGear(bodyG, tr, skin, hair, legL, legR, armL, armR);
        // overhead UI — a floating, spinning state block (the plumbob, minecraft-style)
        var headTop = 3.3 * tr.height;
        var pb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
          new THREE.MeshLambertMaterial({ color: STATE_HEX[def.state] || 0x9aa0a4, emissive: STATE_HEX[def.state] || 0x9aa0a4, emissiveIntensity: 0.55 }));
        pb.position.y = headTop + 0.6; g.add(pb);
        var thought = new THREE.Sprite(new THREE.SpriteMaterial({ map: thoughtTexture('💭'), transparent: true, depthWrite: false }));
        thought.scale.set(1.9, 1.66, 1);
        thought.position.set(1.15, headTop + 1.35, 0);
        g.add(thought);
        var lbl = textSprite(agentHeroName(def, tr), { fs: 30, scale: 0.028 });
        lbl.position.y = headTop + 2.3; lbl.visible = false; g.add(lbl);
        g.traverse(function (o) { o.userData.agentIdx = agents.length; });
        scene.add(g);
        var desk = deskByAgent[def.id];
        var room = null;
        for (var i = 0; i < rooms.length; i++) {
          if (rooms[i].desks.some(function (dd) { return dd.agentId === def.id; })) { room = rooms[i]; break; }
        }
        if (!desk) { desk = { x: lobbyRoom.cx, z: lobbyRoom.cz }; room = lobbyRoom; }
        var startIdx = agents.length;
        var startX = reduced ? desk.x : lobbyRoom.cx;
        var startZ = reduced ? desk.z + 1.55 : lobbyRoom.z1 + 3.0 + startIdx * 1.8;
        var startMode = reduced ? 'sit' : 'walk';
        return {
          def: def, group: g, bodyG: bodyG, room: room, desk: desk, traits: tr, headTop: headTop,
          legL: legL, legR: legR, armL: armL, armR: armR, head: head, body: body, plumbob: pb, label: lbl,
          thought: thought, thoughtIcon: '💭', chatT: 0, socialT: 0, socialCooldown: 0,
          abilityT: 0, abilityCooldown: 4 + (h % 9) / 2, abilityKind: null, abilityTarget: null,
          duelAfterT: 0, duelAfterRole: null, duelAfterKind: null, duelAfterBeat: 0, duelAfterSpawned: false,
          duelAfterX: 0, duelAfterZ: 0,
          manualT: 0, manualKind: null, manualIcon: null,
          socialKind: null, socialRole: null, socialPartner: null, socialIcon: null, destIcon: null, spot: null,
          x: startX, z: startZ, mode: startMode, path: [], after: 'sit',
          speed: 4.6 + (h % 10) / 6, facing: Math.PI, walkPhase: 0,
          decideT: 2 + (h % 100) / 20,
        };
      }
      DATA.agents.forEach(function (def) { agents.push(buildOfficer(def)); });

      // ---- live asset props: furniture-owned animation hooks --------------------------------
      function stepProps(dt) {
        furnitureObjects.forEach(function (item) {
          if (item && item.update) item.update(dt);
        });
      }

      var agentById = {};
      agents.forEach(function (a) { agentById[a.def.id] = a; });

      // ---- real-time thought resolution ----------------------------------------------------
      var WX_MINI = { clear: '☀️', cloudy: '☁️', rain: '🌧', snow: '❄️' };
      function currentThought(a) {
        if (a.manualT > 0) return a.manualIcon || '✨';
        if (a.duelAfterT > 0) return a.duelAfterRole === 'winner' ? '🏆' : '💫';
        if (a.abilityT > 0) return a.abilityIcon || (a.traits && a.traits.abilityIcon) || '✨';
        if (a.socialT > 0) return a.socialIcon || '💬';
        if (a.chatT > 0) return '💬';
        if (a.mode === 'walk') return a.destIcon || '🚶';
        var st = a.def.state;
        if (a.mode === 'act' && a.spot) {
          if (a.reaction && REACTION_ICON[a.reaction]) return REACTION_ICON[a.reaction];
          if (a.spot.type === 'window') return WX_MINI[weather] || '🌤';
          if (a.spot.type === 'meet' && st === 'blocked') return '⏳';
          return ACT_ICON[a.spot.type] || '🤔';
        }
        if (st === 'asleep') return '💤';
        if (st === 'failed') return '💥';
        if (st === 'blocked') return a.mode === 'stand' ? '⏳' : '❗';
        if (st === 'coffee') return '☕';
        if (a.mode === 'sit') return st === 'working' ? '💻' : '🤔';
        return st === 'working' ? '📈' : '🤔';
      }
      function updateThought(a) {
        var icon = currentThought(a);
        if (icon !== a.thoughtIcon) {
          a.thoughtIcon = icon;
          a.thought.material.map = thoughtTexture(icon);
          a.thought.material.needsUpdate = true;
        }
      }
